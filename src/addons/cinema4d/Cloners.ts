import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { MAX_CLONES, MAX_DELAY_FRAMES, clonerLayout, type ClonerSettings, type Placement } from './cloner';
import { hasLive, type LayoutEnv } from './effectors';
import type { Viewport } from '../../engine/render/Viewport';
import { isModel, type Any, type Obj } from '../../engine/types';
import type { World } from '../../engine/world/World';

const GROUP = '__clones';
const noRaycast = () => {};
// MMD モデルの、あるフレームの姿勢 (ディレイのために覚えておく)
interface PoseSnap { pos: Float32Array; quat: Float32Array; morphs: Float32Array | null }

// --- クローナー (Cinema 4D のクローナー) ---
// 物をクローナーにすると、元の物は隠し、その位置と向きを中心に、クローンを直線・放射・グリッドに並べる (cloner.ts)。
// クローンは物の three.js のグループ (node) の子なので、元の物を動かす・回すと一緒に動く。
// 形のクローンは同じ形状と材質を使う普通のメッシュ。MMD モデルのクローンは骨ごと複製し、
// 毎フレーム元のモデルの骨と表情を写す (モーション・物理演算・手で動かしたボーンが、そのまま全部のクローンに出る)。
// ディレイのエフェクタがあれば、元のモデルの姿勢をフレームごとに覚えておき、遅れたクローンには前のフレームの姿勢を写す
// (再生していくと覚えるので、飛んだ直後はまだ遅れない)
export class Cloners {
  private history = new WeakMap<Obj, Map<number, PoseSnap>>();
  // 焼き付けた置き場所 (MoGraph キャッシュのアドオン)。あれば、エフェクタで計算する代わりに使う
  cacheOf: ((obj: Obj, frame: number) => Placement[] | null) | null = null;

  // settingsOf: 物のクローナーの設定 (アドオンの物ごとの値。なければ普通の物)
  // envOf: 並べるときに使うもの (登録されたエフェクタ・時刻・物の位置)
  constructor(private world: World, private viewport: Viewport, private frameNow: () => number,
              private settingsOf: (obj: Obj) => ClonerSettings | null, private envOf: (obj: Obj) => LayoutEnv) {}

  // クローンを、いまの設定で作り直す (設定がなければ、クローンを消して元の物を出す)
  rebuild(obj: Obj) {
    this.build(obj);
    this.viewport.requestDraw();
  }
  private build(obj: Obj) {
    const cloner = this.settingsOf(obj);
    const old = obj.node.getObjectByName(GROUP);
    if (old) { obj.node.remove(old); disposeClones(old); }
    const src: THREE.Mesh | undefined = isModel(obj) ? obj.model : obj.mesh;
    if (!src) return; // (形のない物 (ライト・カメラ・MME の物) は並べない)
    const proxy = obj.node.children.find(c => c.userData.pickProxy) as THREE.Mesh | undefined;
    // 元の物は隠し、クリックでも当たらないようにする (クローンのどれかを押すと、この物が選ばれる)
    src.visible = !cloner;
    setPickable(isModel(obj) ? proxy : src, !cloner);
    if (!cloner) return;
    const group = new THREE.Group();
    group.name = GROUP;
    for (const p of this.layout(obj, cloner)) {
      const g = new THREE.Group();
      place(g, p);
      if (isModel(obj)) {
        const m: Any = cloneSkinned(obj.model);
        m.visible = true;
        // 材質の配列は、クローンごとに別にする (中の材質は同じ)。輪郭線 (OutlineEffect) は描くあいだ配列の中身を入れ替えるので、
        // 同じ配列を共有すると、入れ替えと戻しが食い違う
        if (Array.isArray(m.material)) m.material = [...m.material];
        m.traverse((o: Any) => { if (o.isMesh) { o.raycast = noRaycast; o.castShadow = o.receiveShadow = true; } });
        g.add(m);
        if (proxy) { const pc = proxy.clone(); setPickable(pc, true); g.add(pc); } // 当たり判定は骨で変形しない複製で
      } else {
        const m = new THREE.Mesh(src.geometry, src.material);
        m.castShadow = m.receiveShadow = true;
        g.add(m);
      }
      group.add(g);
    }
    obj.node.add(group);
  }

  private layout(obj: Obj, cloner: ClonerSettings) { return this.cacheOf?.(obj, this.frameNow()) ?? this.compute(obj, cloner); }
  // エフェクタで計算した置き場所 (キャッシュを使わない。焼き付けるときに使う)
  compute(obj: Obj, cloner: ClonerSettings) { return clonerLayout(cloner, isModel(obj) ? MAX_CLONES.model : MAX_CLONES.shape, this.envOf(obj)); }

  private remember(obj: Obj, bones: THREE.Bone[], inf: number[] | undefined) {
    let map = this.history.get(obj);
    if (!map) this.history.set(obj, map = new Map());
    rememberPose(map, this.frameNow(), bones, inf);
    return map;
  }

  // クローンの数 (プロパティに出す)
  count(obj: Obj) { return this.settingsOf(obj) ? obj.node.getObjectByName(GROUP)?.children.length ?? 0 : 0; }

  // 描く前: 材質 (スロットを替えた・作り直した) と、MMD モデルの骨・表情を元の物に合わせる
  sync() {
    for (const obj of this.world.objects) {
      if (!this.settingsOf(obj)) continue;
      const group = obj.node.getObjectByName(GROUP);
      if (!group) continue;
      // 時刻・物の位置で変わるエフェクタがあれば、置き場所を並べ直す (クローンは作り直さない)
      const cloner = this.settingsOf(obj)!;
      const env = this.envOf(obj);
      if (hasLive(cloner.effectors, env) || env.mode?.(cloner.mode)?.live || this.cacheOf?.(obj, this.frameNow())) this.layout(obj, cloner).forEach((p, i) => { const g = group.children[i]; if (g) place(g, p); });
      if (!isModel(obj)) {
        for (const g of group.children) {
          const m = g.children[0] as THREE.Mesh;
          if (m.material !== obj.mesh!.material) m.material = obj.mesh!.material;
        }
        continue;
      }
      const src = obj.model, bones: THREE.Bone[] = src.skeleton.bones, inf: number[] | undefined = src.morphTargetInfluences;
      const delayed = group.children.some(g => g.userData.delay > 0);
      const snaps = delayed ? this.remember(obj, bones, inf) : null;
      const frame = this.frameNow();
      for (const g of group.children) {
        const m = g.children[0] as Any;
        syncMaterials(m, src);
        const cb: THREE.Bone[] = m.skeleton.bones;
        const snap = snaps && g.userData.delay > 0 ? nearest(snaps, frame - g.userData.delay) : null;
        if (snap) {
          for (let i = 0; i < bones.length; i++) {
            cb[i].position.fromArray(snap.pos, i * 3);
            cb[i].quaternion.fromArray(snap.quat, i * 4);
          }
          if (snap.morphs && m.morphTargetInfluences) for (let k = 0; k < snap.morphs.length; k++) m.morphTargetInfluences[k] = snap.morphs[k];
          continue;
        }
        for (let i = 0; i < bones.length; i++) {
          cb[i].position.copy(bones[i].position);
          cb[i].quaternion.copy(bones[i].quaternion);
          cb[i].scale.copy(bones[i].scale);
        }
        if (inf && m.morphTargetInfluences) for (let k = 0; k < inf.length; k++) m.morphTargetInfluences[k] = inf[k];
      }
    }
  }
}

// クローン 1 つの置き場所
function place(g: THREE.Object3D, p: Placement) {
  g.position.set(p.x, p.y, p.z);
  g.rotation.y = p.ry;
  g.scale.setScalar(Math.max(p.scale, 1e-4));
  g.userData.delay = Math.round(p.delay);
}

// いまのフレームの元のモデルの姿勢を覚え、遅れの範囲より前のものは捨てる
function rememberPose(map: Map<number, PoseSnap>, frame: number, bones: THREE.Bone[], inf: number[] | undefined) {
  let snap = map.get(frame);
  if (!snap) map.set(frame, snap = { pos: new Float32Array(bones.length * 3), quat: new Float32Array(bones.length * 4), morphs: inf ? new Float32Array(inf.length) : null });
  bones.forEach((b, i) => { b.position.toArray(snap.pos, i * 3); b.quaternion.toArray(snap.quat, i * 4); });
  if (inf && snap.morphs) snap.morphs.set(inf);
  for (const f of map.keys()) if (f > frame || f < frame - MAX_DELAY_FRAMES) map.delete(f); // (戻ったときは、先のフレームは捨てる)
}
// フレーム f にいちばん近い、覚えている姿勢
function nearest(map: Map<number, PoseSnap>, f: number): PoseSnap | null {
  let best: PoseSnap | null = null, bd = Infinity;
  for (const [k, s] of map) { const d = Math.abs(k - f); if (d < bd) { bd = d; best = s; } }
  return best;
}

// クローンの材質を元のモデルに合わせる (配列は別のまま、中身だけ)
function syncMaterials(m: Any, src: Any) {
  if (!Array.isArray(src.material)) { if (m.material !== src.material) m.material = src.material; return; }
  if (!Array.isArray(m.material) || m.material === src.material || m.material.length !== src.material.length) { m.material = [...src.material]; return; }
  for (let i = 0; i < src.material.length; i++) if (m.material[i] !== src.material[i]) m.material[i] = src.material[i];
}

// 当たり判定のオン・オフ (オフのあいだは、元の raycast を覚えておく)
function setPickable(o: THREE.Object3D | undefined, on: boolean) {
  if (!o) return;
  if (on) {
    if (o.userData.raycast) { o.raycast = o.userData.raycast; delete o.userData.raycast; }
  } else if (!o.userData.raycast) {
    o.userData.raycast = o.raycast;
    o.raycast = noRaycast;
  }
}
// クローンを片付ける (形状と材質は元の物のものなので捨てない。骨の情報だけ)
function disposeClones(group: THREE.Object3D) {
  group.traverse(o => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) (o as THREE.SkinnedMesh).skeleton.dispose(); });
}
