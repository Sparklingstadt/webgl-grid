import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { describe, expect, it, vi } from 'vitest';
import { toMmdVec } from '../../core/mme/coords.ts';
import { makePmx } from '../../core/testing/pmx';
import { readMmdData, registerMmdSource } from './mmdData.ts';
import { Skinner } from './Skinner.ts';

vi.mock('./mmdData.ts', async (orig) => {
  const actual = await orig<typeof import('./mmdData.ts')>();
  return { ...actual, readMmdData: vi.fn(actual.readMmdData) };
});

// makePmx と同じ 8 頂点の SkinnedMesh を three.js (右手系) で手で組む。
// 下の 4 頂点は骨 0 (センター)、上の 4 頂点は骨 1 (右腕、センターの子)。morph: まばたき (上の頂点を y に −2)
function makeMesh(opts: { relative?: boolean; pmx?: Uint8Array; register?: boolean } = {}) {
  const xs = [-2, 2, 2, -2], zs = [-2, -2, 2, 2];
  const pos: number[] = [], nrm: number[] = [], uv: number[] = [], idx: number[] = [], w: number[] = [];
  for (const y of [0, 20]) {
    for (let i = 0; i < 4; i++) {
      pos.push(xs[i], y, -zs[i]); // 右手系 (z を反転)
      nrm.push(xs[i] / 2, 0, -zs[i] / 2);
      uv.push(i / 4, y / 20);
      idx.push(y ? 1 : 0, 0, 0, 0);
      w.push(1, 0, 0, 0);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(w, 4));
  geometry.setIndex([0, 1, 5, 0, 5, 4, 1, 2, 6]);
  geometry.addGroup(0, 6, 0);
  geometry.addGroup(6, 3, 1);
  // MMDLoader の頂点モーフは、位置に差分を足した値 (相対ではない)
  const blink = pos.map((v, i) => v + (i % 3 === 1 && i >= 12 ? -2 : 0));
  const target = new THREE.Float32BufferAttribute(opts.relative ? blink.map((v, i) => v - pos[i]) : blink, 3);
  geometry.morphAttributes.position = [target];
  geometry.morphTargetsRelative = !!opts.relative;

  const center = new THREE.Bone(), arm = new THREE.Bone();
  center.position.set(0, 8, 0);
  arm.position.set(0, 7, 0);
  center.add(arm);
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
  mesh.add(center);
  mesh.bind(new THREE.Skeleton([center, arm]));
  mesh.updateMorphTargets();
  const file = new File([(opts.pmx ?? makePmx('t')) as BlobPart], 't.pmx');
  mesh.userData.sourceFile = file;
  if (opts.register !== false) registerMmdSource(geometry, file); // MmdLoader と同じ
  mesh.updateMatrixWorld(true);
  return { mesh, center, arm };
}

const eye = new THREE.Vector3(0, 10, 50);

// index は三角形ごとに 2 番目と 3 番目を入れ替えた (D3D の表は時計回り) もの
function reversed(src: THREE.BufferGeometry): number[] {
  const n = src.index ? src.index.count : src.attributes.position.count;
  const at = (i: number) => (src.index ? src.index.getX(i) : i);
  return Array.from({ length: n }, (_, i) => at(i % 3 === 0 ? i : i % 3 === 1 ? i + 1 : i - 1));
}

// 読み込みの終わりまで待って、形を返す
async function ready(sk: Skinner, mesh: THREE.SkinnedMesh, tan = 0.5) {
  const onReady = vi.fn();
  expect(sk.mmd(mesh, eye, tan, onReady)).toBeNull();
  await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
  const g = sk.mmd(mesh, eye, tan, onReady);
  expect(g).not.toBeNull();
  return g!;
}

// three.js の変形 (右手系) を左手系に直した、頂点 i の期待値
function expectedPos(mesh: THREE.SkinnedMesh, i: number, base?: THREE.Vector3) {
  mesh.skeleton.update();
  const v = base ?? new THREE.Vector3().fromBufferAttribute(mesh.geometry.attributes.position as THREE.BufferAttribute, i);
  return toMmdVec(mesh.applyBoneTransform(i, v));
}

describe('Skinner.mmd', () => {
  it('a_POSITION は applyBoneTransform を左手系に直した値。1 回目は null と onReady', async () => {
    const { mesh, center, arm } = makeMesh();
    center.position.x += 3;
    center.rotation.y = 0.4;
    arm.rotation.z = 0.7;
    mesh.updateMatrixWorld(true);
    const sk = new Skinner();
    const g = await ready(sk, mesh);
    const p = g.geometry.getAttribute('a_POSITION') as THREE.BufferAttribute;
    expect(p.count).toBe(8);
    for (let i = 0; i < 8; i++) {
      const e = expectedPos(mesh, i);
      expect(p.getX(i)).toBeCloseTo(e.x, 4);
      expect(p.getY(i)).toBeCloseTo(e.y, 4);
      expect(p.getZ(i)).toBeCloseTo(e.z, 4);
    }
    // 上の頂点は曲がっている (センターのままの位置ではない)
    expect(p.getY(5)).not.toBeCloseTo(20, 1);
    // 法線は回すだけ。左手系で、骨 0 の頂点はセンターの回転 (y 軸まわり) を受ける
    const n = g.geometry.getAttribute('a_NORMAL') as THREE.BufferAttribute;
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.4, 0));
    const e = toMmdVec(new THREE.Vector3(-1, 0, 1).normalize().applyQuaternion(q)); // 頂点 0 の右手系の法線 (−1, 0, +1)
    expect(n.getX(0)).toBeCloseTo(e.x, 4);
    expect(n.getY(0)).toBeCloseTo(e.y, 4);
    expect(n.getZ(0)).toBeCloseTo(e.z, 4);
    // position も同じ属性。UV・groups は元の形のもの。index は三角形の向きを逆にしたもの
    expect(g.geometry.getAttribute('position')).toBe(p);
    expect(g.geometry.getAttribute('a_TEXCOORD0')).toBe(mesh.geometry.getAttribute('uv'));
    expect(g.geometry.getAttribute('a_TEXCOORD1')).toBeUndefined();
    expect(Array.from(g.geometry.index!.array)).toEqual([0, 5, 1, 0, 4, 5, 1, 6, 2]);
    expect(Array.from(g.geometry.index!.array)).toEqual(reversed(mesh.geometry));
    expect(g.geometry.groups).toEqual(mesh.geometry.groups);
    expect(sk.data(mesh)?.skin.count).toBe(8);
  });

  it('頂点モーフ (相対でも、MMDLoader のような位置を足した値でも) を骨の前に足す', async () => {
    for (const relative of [false, true]) {
      const { mesh, arm } = makeMesh({ relative });
      mesh.morphTargetInfluences![0] = 0.5;
      arm.rotation.z = 0.7;
      mesh.updateMatrixWorld(true);
      const g = await ready(new Skinner(), mesh);
      const p = g.geometry.getAttribute('a_POSITION') as THREE.BufferAttribute;
      for (const i of [1, 5]) {
        const base = new THREE.Vector3().fromBufferAttribute(mesh.geometry.attributes.position as THREE.BufferAttribute, i);
        if (i >= 4) base.y -= 1; // まばたき 0.5 × (−2)
        const e = expectedPos(mesh, i, base);
        expect(p.getX(i)).toBeCloseTo(e.x, 4);
        expect(p.getY(i)).toBeCloseTo(e.y, 4);
        expect(p.getZ(i)).toBeCloseTo(e.z, 4);
      }
    }
  });

  it('モーフの重みを変えると作り直す', async () => {
    const { mesh } = makeMesh();
    const sk = new Skinner();
    const g = await ready(sk, mesh);
    const p = g.geometry.getAttribute('a_POSITION') as THREE.BufferAttribute;
    expect(p.getY(4)).toBeCloseTo(20, 4);
    mesh.morphTargetInfluences![0] = 1;
    sk.mmd(mesh, eye, 0.5, () => {});
    expect(p.getY(4)).toBeCloseTo(18, 4);
    expect(p.getY(0)).toBeCloseTo(0, 4);
  });

  it('骨もカメラも変わらなければ作り直さない (属性の version が変わらない)', async () => {
    const { mesh, arm } = makeMesh();
    const sk = new Skinner();
    const g = await ready(sk, mesh);
    const p = g.geometry.getAttribute('a_POSITION') as THREE.BufferAttribute;
    const n = g.geometry.getAttribute('a_NORMAL') as THREE.BufferAttribute;
    const ep = g.edge!.getAttribute('a_POSITION') as THREE.BufferAttribute;
    const v = [p.version, n.version, ep.version];
    expect(sk.mmd(mesh, eye, 0.5, () => {})).toBe(g);
    expect([p.version, n.version, ep.version]).toEqual(v);

    // 骨を動かすと、形も輪郭線も作り直す
    arm.rotation.z = 0.3;
    mesh.updateMatrixWorld(true);
    sk.mmd(mesh, eye, 0.5, () => {});
    expect([p.version, n.version, ep.version]).toEqual([v[0] + 1, v[1] + 1, v[2] + 1]);

    // カメラだけなら、輪郭線だけ
    sk.mmd(mesh, new THREE.Vector3(0, 10, 80), 0.5, () => {});
    expect([p.version, n.version, ep.version]).toEqual([v[0] + 1, v[1] + 1, v[2] + 2]);
    sk.mmd(mesh, new THREE.Vector3(0, 10, 80), 0.25, () => {});
    expect(ep.version).toBe(v[2] + 3);
    expect(p.version).toBe(v[0] + 1);
  });

  it('同じフレームの番号で 2 回呼ぶと、2 回目は骨の行列を計算しない (番号が変わるか、番号がなければ計算する)', async () => {
    const { mesh, arm } = makeMesh();
    const sk = new Skinner();
    const g = await ready(sk, mesh);
    const p = g.geometry.getAttribute('a_POSITION') as THREE.BufferAttribute;
    const ep = g.edge!.getAttribute('a_POSITION') as THREE.BufferAttribute;
    // 骨の行列の計算の回数 (計算のたびに skeleton.update を 1 回呼ぶ)
    const computed = vi.spyOn(mesh.skeleton, 'update');
    expect(sk.mmd(mesh, eye, 0.5, () => {}, 7)).toBe(g);
    expect(computed).toHaveBeenCalledTimes(1);
    const v = p.version;

    // 同じフレームのうちに骨が動いても、2 回目は計算しない (形はそのフレームの最初のもの)
    arm.rotation.z = 0.3;
    mesh.updateMatrixWorld(true);
    expect(sk.mmd(mesh, eye, 0.5, () => {}, 7)).toBe(g);
    expect(computed).toHaveBeenCalledTimes(1);
    expect(p.version).toBe(v);
    // カメラが違えば、輪郭線は広げ直す
    const ev = ep.version;
    sk.mmd(mesh, new THREE.Vector3(0, 10, 80), 0.5, () => {}, 7);
    expect(computed).toHaveBeenCalledTimes(1);
    expect(ep.version).toBe(ev + 1);

    // 次のフレームは計算する
    sk.mmd(mesh, eye, 0.5, () => {}, 8);
    expect(computed).toHaveBeenCalledTimes(2);
    expect(p.version).toBe(v + 1);
    // 番号を渡さなければ、毎回計算する
    sk.mmd(mesh, eye, 0.5, () => {});
    sk.mmd(mesh, eye, 0.5, () => {});
    expect(computed).toHaveBeenCalledTimes(4);
  });

  it('輪郭線の形は法線の向きに広がっている。ほかの属性・index・groups は共有', async () => {
    const { mesh } = makeMesh();
    mesh.position.set(5, 0, 0); // 物の空間のカメラは、世界のカメラを物の逆行列で直した位置
    mesh.updateMatrixWorld(true);
    const sk = new Skinner();
    const g = await ready(sk, mesh, 0.5); // 世界のカメラ (0, 10, 50)
    const edge = g.edge!;
    const p = g.geometry.getAttribute('a_POSITION') as THREE.BufferAttribute;
    const n = g.geometry.getAttribute('a_NORMAL') as THREE.BufferAttribute;
    const ep = edge.getAttribute('a_POSITION') as THREE.BufferAttribute;
    expect(edge.getAttribute('position')).toBe(ep);
    expect(ep).not.toBe(p);
    expect(edge.getAttribute('a_NORMAL')).toBe(n);
    expect(edge.getAttribute('a_TEXCOORD0')).toBe(g.geometry.getAttribute('a_TEXCOORD0'));
    expect(edge.index).toBe(g.geometry.index);
    expect(edge.groups).toEqual(g.geometry.groups);

    const eyeLocal = toMmdVec(new THREE.Vector3(-5, 10, 50)); // 左手系
    const edgeSize = sk.data(mesh)!.vertexEdgeSize[2]; // 1
    for (let i = 0; i < 8; i++) {
      const pos = new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i));
      const nor = new THREE.Vector3(n.getX(i), n.getY(i), n.getZ(i));
      const d = new THREE.Vector3(ep.getX(i), ep.getY(i), ep.getZ(i)).sub(pos);
      const k = (edgeSize / 300) * pos.distanceTo(eyeLocal) * 0.5;
      expect(d.length()).toBeCloseTo(k * nor.length(), 4);
      expect(d.clone().normalize().dot(nor.clone().normalize())).toBeCloseTo(1, 4);
    }
  });

  it('同じ .pmx の File は 1 回だけ読む (クローンも共有)。読み終わるまで onReady は 1 回', async () => {
    vi.mocked(readMmdData).mockClear();
    const { mesh } = makeMesh();
    // SkeletonUtils.clone (クローナーと同じ) は userData を JSON で写すので、File は引き継がれない。形は共有する
    const clone = cloneSkinned(mesh) as THREE.SkinnedMesh;
    expect(clone.userData.sourceFile).not.toBeInstanceOf(Blob);
    const sk = new Skinner();
    const a = vi.fn(), b = vi.fn();
    expect(sk.mmd(mesh, eye, 0.5, a)).toBeNull();
    expect(sk.mmd(mesh, eye, 0.5, a)).toBeNull(); // 同じ物の 2 回目は登録しない
    expect(sk.mmd(clone, eye, 0.5, b)).toBeNull();
    await vi.waitFor(() => expect(b).toHaveBeenCalledTimes(1));
    expect(a).toHaveBeenCalledTimes(1);
    expect(readMmdData).toHaveBeenCalledTimes(1);
    expect(sk.data(mesh)).not.toBeNull();
    expect(sk.mmd(clone, eye, 0.5, b)).not.toBeNull();
  });

  it('SkeletonUtils.clone したクローンも、userData.sourceFile がなくても変形した形を得る', async () => {
    const { mesh, arm } = makeMesh();
    const clone = cloneSkinned(mesh) as THREE.SkinnedMesh;
    expect(clone.userData.sourceFile).not.toBeInstanceOf(Blob);
    const sk = new Skinner();
    await ready(sk, mesh);
    const g = sk.mmd(clone, eye, 0.5, () => {});
    expect(g).not.toBeNull();
    expect(g).not.toBe(sk.mmd(mesh, eye, 0.5, () => {}));
    arm.rotation.z = 0.7; // 元は動かしても、クローンの骨は別
    expect((g!.geometry.getAttribute('a_POSITION') as THREE.BufferAttribute).getY(5)).toBeCloseTo(20, 4);
    expect(sk.data(clone)).not.toBeNull();
  });

  it('形に登録がなければ userData.sourceFile から読む', async () => {
    const { mesh } = makeMesh({ register: false });
    expect(mesh.userData.sourceFile).toBeInstanceOf(Blob);
    expect(await ready(new Skinner(), mesh)).not.toBeNull();
  });

  it('.pmx がない物や読めない物は null のまま (onReady も呼ばず、failed は読めない物だけ)。ログは物ごとに 1 回', async () => {
    const sk = new Skinner();
    const none = makeMesh({ register: false }).mesh;
    delete none.userData.sourceFile;
    const bad = makeMesh({ pmx: new Uint8Array(4) }).mesh;
    const bad2 = makeMesh({ pmx: new Uint8Array(4) }).mesh;
    const onReady = vi.fn();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(sk.mmd(none, eye, 0.5, onReady)).toBeNull();
    expect(sk.mmd(bad, eye, 0.5, onReady)).toBeNull();
    expect(sk.failed(bad)).toBe(false); // 読んでいるあいだは失敗ではない
    await vi.waitFor(() => expect(sk.failed(bad)).toBe(true));
    expect(sk.mmd(bad, eye, 0.5, onReady)).toBeNull();
    expect(sk.mmd(bad, eye, 0.5, onReady)).toBeNull();
    expect(err).toHaveBeenCalledTimes(1);
    sk.mmd(bad2, eye, 0.5, onReady);
    await vi.waitFor(() => expect(sk.failed(bad2)).toBe(true));
    sk.mmd(bad2, eye, 0.5, onReady);
    expect(err).toHaveBeenCalledTimes(2);
    expect(sk.failed(none)).toBe(false);
    expect(onReady).not.toHaveBeenCalled();
    expect(sk.data(bad)).toBeNull();
    err.mockRestore();
  });

  it('頂点の数が .pmx と合わない形は null で failed。ログは 1 回', async () => {
    const sk = new Skinner();
    const { mesh } = makeMesh();
    await ready(sk, mesh);
    const wrong = makeMesh().mesh;
    wrong.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(9), 3));
    registerMmdSource(wrong.geometry, mesh.userData.sourceFile);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(sk.failed(wrong)).toBe(false);
    expect(sk.mmd(wrong, eye, 0.5, () => {})).toBeNull(); // 読み込み中 (同じ File は読み終わっている)
    expect(sk.mmd(wrong, eye, 0.5, () => {})).toBeNull();
    expect(sk.failed(wrong)).toBe(true);
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0][0])).toContain('頂点の数');
    expect(sk.failed(mesh)).toBe(false);
    err.mockRestore();
  });
});

describe('Skinner.plain', () => {
  const box = () => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 3), new THREE.MeshBasicMaterial());
    m.geometry.setAttribute('uv1', new THREE.Float32BufferAttribute(new Float32Array(m.geometry.attributes.uv.count * 2), 2));
    return m;
  };

  it('形 (MMD でない) は z を反転した写しで、位置を変えるまで同じものを返す', () => {
    const mesh = box();
    const sk = new Skinner();
    const src = mesh.geometry;
    const z0 = src.attributes.position.getZ(0);
    const g = sk.plain(mesh);
    const p = g.geometry.getAttribute('a_POSITION') as THREE.BufferAttribute;
    const n = g.geometry.getAttribute('a_NORMAL') as THREE.BufferAttribute;
    expect(g.edge).toBeNull();
    expect(p.count).toBe(src.attributes.position.count);
    for (let i = 0; i < p.count; i++) {
      expect(p.getX(i)).toBe(src.attributes.position.getX(i));
      expect(p.getY(i)).toBe(src.attributes.position.getY(i));
      expect(p.getZ(i)).toBeCloseTo(-src.attributes.position.getZ(i), 6);
      expect(n.getZ(i)).toBeCloseTo(-src.attributes.normal.getZ(i), 6);
    }
    expect(g.geometry.getAttribute('position')).toBe(p);
    expect(g.geometry.getAttribute('a_TEXCOORD0')).toBe(src.attributes.uv);
    expect(g.geometry.getAttribute('a_TEXCOORD1')).toBe(src.attributes.uv1);
    expect(Array.from(g.geometry.index!.array)).toEqual(reversed(src));
    expect(g.geometry.groups).toEqual(src.groups);
    // 元の形は変えない
    expect(src.attributes.position.getZ(0)).toBe(z0);

    // 同じあいだは同じもの。位置を変える (version が上がる) と作り直す
    expect(sk.plain(mesh)).toBe(g);
    src.attributes.position.setZ(0, 7);
    src.attributes.position.needsUpdate = true;
    const g2 = sk.plain(mesh);
    expect((g2.geometry.getAttribute('a_POSITION') as THREE.BufferAttribute).getZ(0)).toBe(-7);
    expect(sk.plain(mesh)).toBe(g2);
  });

  it('index をその場で書き換える (version が上がる) と、向きを逆にした index も作り直す', () => {
    const mesh = box();
    const sk = new Skinner();
    const g = sk.plain(mesh);
    const idx = mesh.geometry.index!;
    idx.setX(0, idx.getX(1));
    idx.needsUpdate = true;
    const g2 = sk.plain(mesh);
    expect(g2).not.toBe(g);
    expect(Array.from(g2.geometry.index!.array)).toEqual(reversed(mesh.geometry));
  });

  it('同じ形を使う物は写しを共有する。法線や uv がなくても作れる', () => {
    const a = box(), b = new THREE.Mesh(a.geometry);
    const sk = new Skinner();
    expect(sk.plain(b)).toBe(sk.plain(a));
    const bare = new THREE.Mesh(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 1, 1, 0, 1, 0, 1, 1], 3)));
    const g = sk.plain(bare);
    expect(g.geometry.getAttribute('a_NORMAL')).toBeUndefined();
    expect((g.geometry.getAttribute('a_POSITION') as THREE.BufferAttribute).getZ(0)).toBe(-1);
    expect(Array.from(g.geometry.index!.array)).toEqual([0, 2, 1]); // index のない形にも作る
  });

  it('dispose は作った形を捨てる (二重には捨てない)', async () => {
    const sk = new Skinner();
    const { mesh } = makeMesh();
    const g = await ready(sk, mesh);
    const gp = sk.plain(box());
    const spies = [g.geometry, g.edge!, gp.geometry].map(x => vi.spyOn(x, 'dispose'));
    sk.dispose();
    sk.dispose();
    for (const s of spies) expect(s).toHaveBeenCalledTimes(1);
  });

  it('元の形を差し替えて dispose すると、写しも捨てる。元の形の属性は消さない', () => {
    const sk = new Skinner();
    const mesh = box();
    const old = mesh.geometry;
    const g = sk.plain(mesh);
    const spy = vi.spyOn(g.geometry, 'dispose');
    const ownPos = g.geometry.getAttribute('a_POSITION');
    const ownIndex = g.geometry.index;
    mesh.geometry = box().geometry; // デフォーマが形を差し替えて、前の形を dispose するのと同じ
    const g2 = sk.plain(mesh);
    expect(g2).not.toBe(g);
    expect(spy).not.toHaveBeenCalled(); // 元の形はまだ生きている
    old.dispose();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(g.geometry.getAttribute('a_POSITION')).toBe(ownPos); // 自分の属性は残る
    expect(g.geometry.getAttribute('a_TEXCOORD0')).toBeUndefined(); // 共有の UV は外してある
    expect(g.geometry.index).toBe(ownIndex); // index は自分のもの
    expect(old.attributes.uv).toBeDefined();
    expect(old.index).not.toBeNull();
    // 外れたあとの dispose() は二重に捨てない
    sk.dispose();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('MMD の写しも、元の形の dispose で捨てる (輪郭線の形と共有の法線を巻き込まない)', async () => {
    const sk = new Skinner();
    const { mesh } = makeMesh();
    const g = await ready(sk, mesh);
    const spies = [vi.spyOn(g.geometry, 'dispose'), vi.spyOn(g.edge!, 'dispose')];
    const nrm = g.geometry.getAttribute('a_NORMAL');
    mesh.geometry.dispose();
    for (const s of spies) expect(s).toHaveBeenCalledTimes(1);
    expect(g.edge!.getAttribute('a_NORMAL')).toBeUndefined();
    expect(g.geometry.getAttribute('a_NORMAL')).toBe(nrm);
    // 同じ物でもう一度呼ぶと、新しい写しを作る
    const g2 = sk.mmd(mesh, eye, 0.5, () => {});
    expect(g2).not.toBeNull();
    expect(g2).not.toBe(g);
  });
});
