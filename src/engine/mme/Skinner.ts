import * as THREE from 'three';
import { applyMorphs, expandEdges, skin } from '../../core/mme/skinning.ts';
import { mmdSourceOf, readMmdData, type MmdData } from './mmdData.ts';

// MME に渡す形。座標はすべて MMD の左手系
export interface MmeGeometry {
  geometry: THREE.BufferGeometry; // a_POSITION・a_NORMAL・a_TEXCOORD0.. (position は a_POSITION と同じ属性)。groups は元の形のもの。
                                  // index は元の形の三角形の向きを逆にしたもの (D3D の表は時計回り)
  edge: THREE.BufferGeometry | null; // a_POSITION だけ輪郭線の分だけ広げた形 (ほかは geometry と共有)。MMD モデルだけ
}

// 元の形 (右手系) を左手系にした、変形前の位置と法線。モーフの差分は使うときに初めて作る
// (モーフは 100 を超えることもあり、全部作ると元の形のモーフの倍の場所を取るので)
interface Rest {
  pos: Float32Array;
  nrm: Float32Array;
  deltas: (Float32Array | undefined)[];
}

// メッシュごとの、変形した形と、前の計算の入力
interface Pose {
  source: THREE.BufferGeometry; // 作ったときの元の形 (差し替わったら作り直す)
  copy: Copy;
  rest: Rest;
  out: MmeGeometry & { edge: THREE.BufferGeometry };
  pos: Float32Array;
  nrm: Float32Array;
  edgePos: Float32Array;
  posAttr: THREE.BufferAttribute;
  nrmAttr: THREE.BufferAttribute;
  edgeAttr: THREE.BufferAttribute;
  morphed: Float32Array; // モーフを足した位置
  bones: Float32Array; // 骨ごとの行列 (左手系、16 個ずつ)
  prevBones: Float32Array;
  prevInfluences: number[];
  prevEye: number[]; // 物の空間 (左手系) のカメラの位置と tanHalfFovY
  done: boolean; // 1 回は計算した
  frameNo: number; // 骨とモーフを見たフレームの番号 (番号なしで呼ばれたら NaN)
  activeDeltas: Float32Array[]; // 作業用 (applyMorphs に渡す重みが 0 でないモーフ)
  activeWeights: number[];
}

// File ごとの、.pmx の読み込み
interface Source {
  promise: Promise<void>;
  data: MmdData | null;
  error: unknown; // 読めなかったときの理由 (失敗したら undefined 以外)
  failed: boolean;
}

// 作った形 (geometry と、MMD なら輪郭線の形)。owned は、その形が自分で持つ属性と index (UV は元の形と共有なので入れない。
// 輪郭線の形は geometry の index を共有する)
interface Copy {
  parts: { geometry: THREE.BufferGeometry; owned: Set<THREE.BufferAttribute> }[];
  source: THREE.BufferGeometry;
  onDispose: () => void; // 元の形が dispose されたら写しを捨てる
  released: boolean;
}

interface PlainEntry {
  out: MmeGeometry;
  copy: Copy;
  sources: (THREE.BufferAttribute | THREE.InterleavedBufferAttribute | null)[]; // position, normal, index, uv, uv1, uv2, uv3
  versions: number[]; // position, normal
}

// three.js の追加 UV の名前 (MMD の TEXCOORD1.. に対応する)
const UV_NAMES = ['uv', 'uv1', 'uv2', 'uv3'];

// 作業用 (毎フレームの確保を避ける)
const _inv = new THREE.Matrix4();
const _bone = new THREE.Matrix4();
const _eye = new THREE.Vector3();

type Attr = THREE.BufferAttribute | THREE.InterleavedBufferAttribute;

// three.js の形は表が反時計回り (MMDLoader も右手系にするときに三角形の向きを逆にしている)。
// MMD・D3D の表は時計回りなので、三角形ごとに頂点の順を逆にした index を作る (index のない形も作る)
function d3dIndex(src: THREE.BufferGeometry): THREE.BufferAttribute {
  const idx = src.index;
  const n = idx ? idx.count : src.attributes.position?.count ?? 0;
  const out = (src.attributes.position?.count ?? 0) > 65535 ? new Uint32Array(n) : new Uint16Array(n);
  const at = (i: number) => (idx ? idx.getX(i) : i);
  for (let i = 0; i < n; i++) out[i] = at(i);
  for (let i = 0; i + 2 < n; i += 3) { out[i + 1] = at(i + 2); out[i + 2] = at(i + 1); }
  return new THREE.BufferAttribute(out, 1);
}

// 右手系の 3 成分の属性を、z を反転した左手系の配列にする
function lhArray(a: Attr): Float32Array {
  const out = new Float32Array(a.count * 3);
  for (let i = 0; i < a.count; i++) {
    out[i * 3] = a.getX(i);
    out[i * 3 + 1] = a.getY(i);
    out[i * 3 + 2] = -a.getZ(i);
  }
  return out;
}

// MMD モデル (.pmx から読んだ SkinnedMesh) と、そうでない物の形を、MME が読める左手系にして持つ
export class Skinner {
  private sources = new WeakMap<Blob, Source>();
  private waiting = new WeakSet<THREE.Object3D>(); // 読み終わりを待つ onReady を登録した物
  private rests = new WeakMap<THREE.BufferGeometry, Rest>();
  private poses = new WeakMap<THREE.SkinnedMesh, Pose>();
  private plains = new WeakMap<THREE.BufferGeometry, PlainEntry>();
  // 生きている写し。元の形が dispose されると外れる (メッシュが消えても、その形は dispose されるので残らない)
  private live = new Set<Copy>();
  private mismatched = new WeakSet<THREE.Object3D>(); // 頂点の数が .pmx と合わないと分かった物
  private reported = new WeakSet<THREE.Object3D>(); // 失敗を console に出した物
  private disposed = false;

  // MMD モデル: 初めて呼ばれたら .pmx を読み始めて null を返し、読み終えたら onReady を呼ぶ (1 つの物につき 1 回)。
  // 読み終えていれば、変形して返す。呼ぶ前に、骨の世界の行列 (updateMatrixWorld) を最新にしておく。
  // frameNo を渡すと、同じ番号の 2 回目からは骨とモーフを見直さない (1 フレームに場面を何度も描くので。輪郭線はカメラに合わせる)
  mmd(mesh: THREE.SkinnedMesh, eyeWorld: THREE.Vector3, tanHalfFovY: number, onReady: () => void, frameNo?: number): MmeGeometry | null {
    const file = this.fileOf(mesh);
    if (!file || this.disposed) return null;
    const src = this.source(file);
    const data = src.data;
    if (!data) {
      if (src.failed) this.report(mesh, src.error);
      else if (!this.waiting.has(mesh)) {
        this.waiting.add(mesh);
        void src.promise.then(() => { if (src.data && !this.disposed) onReady(); });
      }
      return null;
    }
    const geo = mesh.geometry;
    if (geo.attributes.position.count !== data.skin.count) {
      this.mismatched.add(mesh);
      this.report(mesh, `.pmx の頂点の数 (${data.skin.count}) がモデルの形 (${geo.attributes.position.count}) と合いません`);
      return null;
    }
    this.mismatched.delete(mesh);

    let pose = this.poses.get(mesh);
    if (pose?.source !== geo || pose.copy.released) {
      if (pose) this.release(pose.copy);
      pose = this.createPose(mesh);
      this.poses.set(mesh, pose);
    }

    // 骨の行列 (左手系) と、モーフの重みを、前と比べる (このフレームでもう見たなら見ない)
    let changed = false;
    if (!pose.done || frameNo === undefined || pose.frameNo !== frameNo) {
      pose.frameNo = frameNo ?? NaN;
      changed = this.updatePose(mesh, pose, data);
    }

    // 物の空間 (左手系) のカメラ
    _inv.copy(mesh.matrixWorld).invert();
    _eye.copy(eyeWorld).applyMatrix4(_inv);
    const ex = _eye.x, ey = _eye.y, ez = -_eye.z;
    const pe = pose.prevEye;
    if (changed || pe[0] !== ex || pe[1] !== ey || pe[2] !== ez || pe[3] !== tanHalfFovY) {
      pe[0] = ex; pe[1] = ey; pe[2] = ez; pe[3] = tanHalfFovY;
      expandEdges(pose.pos, pose.nrm, data.vertexEdgeSize, [ex, ey, ez], tanHalfFovY, pose.edgePos);
      pose.edgeAttr.needsUpdate = true;
    }
    pose.done = true;
    return pose.out;
  }

  // MMD でない物 (形・ステージの静的な部分): 左手系の写し。元の形の属性と version が同じあいだは作り直さない
  plain(mesh: THREE.Mesh): MmeGeometry {
    const geo = mesh.geometry;
    const a = geo.attributes;
    const sources = [a.position, a.normal, geo.index, ...UV_NAMES.map(n => a[n])].map(x => x ?? null);
    const versions = [a.position, a.normal, geo.index].map(x => (x && ('version' in x ? x.version : x.data.version)) || 0);
    const old = this.plains.get(geo);
    if (old && !old.copy.released && old.sources.every((s, i) => s === sources[i]) && old.versions.every((v, i) => v === versions[i])) return old.out;
    if (old) this.release(old.copy);

    const g = new THREE.BufferGeometry();
    const owned = new Set<THREE.BufferAttribute>();
    if (a.position) {
      const pos = new THREE.BufferAttribute(lhArray(a.position), 3);
      g.setAttribute('a_POSITION', pos);
      g.setAttribute('position', pos);
      owned.add(pos);
    }
    if (a.normal) {
      const nrm = new THREE.BufferAttribute(lhArray(a.normal), 3);
      g.setAttribute('a_NORMAL', nrm);
      owned.add(nrm);
    }
    const index = d3dIndex(geo);
    owned.add(index);
    this.shareRest(g, geo, index);
    const out: MmeGeometry = { geometry: g, edge: null };
    this.plains.set(geo, { out, copy: this.track(geo, [{ geometry: g, owned }]), sources, versions });
    return out;
  }

  // .pmx の読み込みが終わる (失敗しても) と終わる。まだ読み始めていなければ読み始める。MMD モデルでなければすぐ終わる
  settled(mesh: THREE.SkinnedMesh): Promise<void> {
    const file = this.fileOf(mesh);
    return file && !this.disposed ? this.source(file).promise : Promise.resolve();
  }

  // 読み込みに失敗した (.pmx が読めない、または形と頂点の数が合わない)。読み込み中や、まだ呼んでいないときは false
  failed(mesh: THREE.SkinnedMesh): boolean {
    const file = this.fileOf(mesh);
    return this.mismatched.has(mesh) || (!!file && !!this.sources.get(file)?.failed);
  }

  // 読み終えた変形の情報 (材質のフラグに使う)。まだ、または読めなかったときは null
  data(mesh: THREE.SkinnedMesh): MmdData | null {
    const file = this.fileOf(mesh);
    return file ? this.sources.get(file)?.data ?? null : null;
  }

  dispose(): void {
    this.disposed = true;
    for (const c of [...this.live]) this.release(c);
    this.poses = new WeakMap();
    this.plains = new WeakMap();
    this.rests = new WeakMap();
  }

  // .pmx。形に登録されたものを先に見る (SkeletonUtils.clone は userData を JSON で写すので、File が落ちる)
  private fileOf(mesh: THREE.SkinnedMesh): Blob | null {
    const f = mmdSourceOf(mesh.geometry) ?? mesh.userData.sourceFile;
    return f instanceof Blob ? f : null;
  }

  private report(mesh: THREE.Object3D, err: unknown): void {
    if (this.reported.has(mesh)) return;
    this.reported.add(mesh);
    console.error(err);
  }

  private source(file: Blob): Source {
    let s = this.sources.get(file);
    if (!s) {
      const entry: Source = { promise: Promise.resolve(), data: null, error: undefined, failed: false };
      entry.promise = readMmdData(file).then(
        d => { entry.data = d; },
        err => { entry.failed = true; entry.error = err; },
      );
      this.sources.set(file, entry);
      s = entry;
    }
    return s;
  }

  // 写しを登録する。元の形が dispose されたら写しも捨てる
  private track(source: THREE.BufferGeometry, parts: Copy['parts']): Copy {
    const copy: Copy = { parts, source, released: false, onDispose: () => this.release(copy) };
    source.addEventListener('dispose', copy.onDispose);
    this.live.add(copy);
    return copy;
  }

  // 写しを GPU から捨てる。元の形と共有している属性 (UV・index・法線) は、写しから外してから dispose する
  // (geometry.dispose() は、その形の全部の属性のバッファを消すので、共有のものは元の形の分まで消えてしまう)
  private release(copy: Copy): void {
    if (copy.released) return;
    copy.released = true;
    copy.source.removeEventListener('dispose', copy.onDispose);
    this.live.delete(copy);
    for (const { geometry, owned } of copy.parts) {
      for (const name of Object.keys(geometry.attributes)) {
        if (!owned.has(geometry.attributes[name] as THREE.BufferAttribute)) geometry.deleteAttribute(name);
      }
      if (geometry.index && !owned.has(geometry.index)) geometry.setIndex(null);
      geometry.dispose();
    }
  }

  // UV (a_TEXCOORDn)・groups は元の形のものを共有する。index は D3D の向きにしたもの
  private shareRest(g: THREE.BufferGeometry, src: THREE.BufferGeometry, index: THREE.BufferAttribute): void {
    UV_NAMES.forEach((n, i) => { if (src.attributes[n]) g.setAttribute(`a_TEXCOORD${i}`, src.attributes[n]); });
    g.setIndex(index);
    for (const grp of src.groups) g.addGroup(grp.start, grp.count, grp.materialIndex);
  }

  private createPose(mesh: THREE.SkinnedMesh): Pose {
    const src = mesh.geometry;
    let rest = this.rests.get(src);
    if (!rest) {
      rest = { pos: lhArray(src.attributes.position), nrm: lhArray(src.attributes.normal), deltas: [] };
      this.rests.set(src, rest);
    }
    const count = src.attributes.position.count;
    const posAttr = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
    const nrmAttr = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
    const edgeAttr = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
    for (const a of [posAttr, nrmAttr, edgeAttr]) a.setUsage(THREE.DynamicDrawUsage);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('a_POSITION', posAttr);
    geometry.setAttribute('position', posAttr);
    geometry.setAttribute('a_NORMAL', nrmAttr);
    const index = d3dIndex(src);
    this.shareRest(geometry, src, index);
    // 輪郭線は a_POSITION だけ別で、ほかは geometry と同じ属性
    const edge = new THREE.BufferGeometry();
    edge.setAttribute('a_POSITION', edgeAttr);
    edge.setAttribute('position', edgeAttr);
    edge.setAttribute('a_NORMAL', nrmAttr);
    this.shareRest(edge, src, index);
    const copy = this.track(src, [
      { geometry, owned: new Set([posAttr, nrmAttr, index]) },
      { geometry: edge, owned: new Set([edgeAttr]) },
    ]);

    return {
      source: src,
      copy,
      rest,
      out: { geometry, edge },
      pos: posAttr.array as Float32Array,
      nrm: nrmAttr.array as Float32Array,
      edgePos: edgeAttr.array as Float32Array,
      posAttr, nrmAttr, edgeAttr,
      morphed: new Float32Array(count * 3),
      bones: new Float32Array(0),
      prevBones: new Float32Array(0),
      prevInfluences: [],
      prevEye: [NaN, 0, 0, 0],
      done: false,
      frameNo: NaN,
      activeDeltas: [],
      activeWeights: [],
    };
  }

  // 骨の行列とモーフの重みを前と比べて、変わっていれば (初めてなら) 変形し直す。変形し直したら true
  private updatePose(mesh: THREE.SkinnedMesh, pose: Pose, data: MmdData): boolean {
    this.boneMatrices(mesh, pose);
    const inf = mesh.morphTargetInfluences ?? [];
    let changed = !pose.done;
    if (!changed) {
      for (let i = 0; i < pose.bones.length; i++) if (pose.bones[i] !== pose.prevBones[i]) { changed = true; break; }
    }
    if (!changed) {
      if (inf.length !== pose.prevInfluences.length) changed = true;
      else for (let i = 0; i < inf.length; i++) if (inf[i] !== pose.prevInfluences[i]) { changed = true; break; }
    }
    if (changed) {
      pose.prevBones.set(pose.bones);
      pose.prevInfluences = [...inf];
      this.skinMesh(pose, data, inf);
      pose.posAttr.needsUpdate = true;
      pose.nrmAttr.needsUpdate = true;
    }
    return changed;
  }

  // bindMatrixInverse · boneMatrix · bindMatrix を左手系 (S·m·S) にして、骨ごとに 16 個ずつ pose.bones に置く
  private boneMatrices(mesh: THREE.SkinnedMesh, pose: Pose): void {
    const skeleton = mesh.skeleton;
    skeleton.update();
    const n = skeleton.bones.length;
    if (pose.bones.length !== n * 16) {
      pose.bones = new Float32Array(n * 16);
      pose.prevBones = new Float32Array(n * 16);
      pose.done = false;
    }
    const bm = skeleton.boneMatrices;
    if (!bm) return;
    for (let b = 0; b < n; b++) {
      _bone.fromArray(bm, b * 16);
      _bone.premultiply(mesh.bindMatrixInverse).multiply(mesh.bindMatrix);
      const e = _bone.elements, o = b * 16, out = pose.bones;
      // S·m·S は、行と列のどちらか一方だけが z の要素 (2・6・14・8・9・11) の符号を反転する (coords.ts の toMmd と同じ)
      for (let i = 0; i < 16; i++) out[o + i] = e[i];
      out[o + 2] = -e[2]; out[o + 6] = -e[6]; out[o + 14] = -e[14];
      out[o + 8] = -e[8]; out[o + 9] = -e[9]; out[o + 11] = -e[11];
    }
  }

  // 頂点モーフを足してから、骨で変形する
  private skinMesh(pose: Pose, data: MmdData, inf: ArrayLike<number>): void {
    const { rest } = pose;
    const targets = pose.source.morphAttributes.position ?? [];
    pose.activeDeltas.length = 0;
    pose.activeWeights.length = 0;
    for (let m = 0; m < targets.length && m < inf.length; m++) {
      if (!inf[m]) continue;
      pose.activeDeltas.push(this.delta(pose.source, rest, m));
      pose.activeWeights.push(inf[m]);
    }
    let base = rest.pos;
    if (pose.activeDeltas.length) {
      applyMorphs(rest.pos, pose.activeDeltas, pose.activeWeights, pose.morphed);
      base = pose.morphed;
    }
    skin(data.skin, base, rest.nrm, pose.bones, pose.pos, pose.nrm);
  }

  // モーフの差分 (左手系)。MMDLoader のモーフは位置に差分を足した値 (morphTargetsRelative = false) なので、位置を引く
  private delta(geo: THREE.BufferGeometry, rest: Rest, m: number): Float32Array {
    let d = rest.deltas[m];
    if (!d) {
      d = lhArray(geo.morphAttributes.position![m]);
      if (!geo.morphTargetsRelative) for (let i = 0; i < d.length; i++) d[i] -= rest.pos[i];
      rest.deltas[m] = d;
    }
    return d;
  }
}
