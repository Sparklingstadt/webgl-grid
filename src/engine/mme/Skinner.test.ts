import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { describe, expect, it, vi } from 'vitest';
import { toMmdVec } from '../../core/mme/coords.ts';
import { makePmx } from '../../core/testing/pmx';
import { readMmdData } from './mmdData.ts';
import { Skinner } from './Skinner.ts';

vi.mock('./mmdData.ts', async (orig) => {
  const actual = await orig<typeof import('./mmdData.ts')>();
  return { ...actual, readMmdData: vi.fn(actual.readMmdData) };
});

// makePmx と同じ 8 頂点の SkinnedMesh を three.js (右手系) で手で組む。
// 下の 4 頂点は骨 0 (センター)、上の 4 頂点は骨 1 (右腕、センターの子)。morph: まばたき (上の頂点を y に −2)
function makeMesh(opts: { relative?: boolean; pmx?: Uint8Array } = {}) {
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
  mesh.userData.sourceFile = new File([(opts.pmx ?? makePmx('t')) as BlobPart], 't.pmx');
  mesh.updateMatrixWorld(true);
  return { mesh, center, arm };
}

const eye = new THREE.Vector3(0, 10, 50);

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
    // position も同じ属性。UV・index・groups は元の形のもの
    expect(g.geometry.getAttribute('position')).toBe(p);
    expect(g.geometry.getAttribute('a_TEXCOORD0')).toBe(mesh.geometry.getAttribute('uv'));
    expect(g.geometry.getAttribute('a_TEXCOORD1')).toBeUndefined();
    expect(g.geometry.index).toBe(mesh.geometry.index);
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
    // SkeletonUtils.clone (クローナーと同じ) は userData を JSON で写すので、File は引き継がれない
    const clone = cloneSkinned(mesh) as THREE.SkinnedMesh;
    clone.userData.sourceFile = mesh.userData.sourceFile;
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

  it('.pmx がない物や読めない物は null のまま (onReady も呼ばない)', async () => {
    const sk = new Skinner();
    const none = makeMesh().mesh;
    delete none.userData.sourceFile;
    const bad = makeMesh({ pmx: new Uint8Array(4) }).mesh;
    const onReady = vi.fn();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(sk.mmd(none, eye, 0.5, onReady)).toBeNull();
    expect(sk.mmd(bad, eye, 0.5, onReady)).toBeNull();
    await new Promise(r => setTimeout(r, 50));
    expect(sk.mmd(bad, eye, 0.5, onReady)).toBeNull();
    expect(onReady).not.toHaveBeenCalled();
    expect(sk.data(bad)).toBeNull();
    expect(err).toHaveBeenCalledTimes(1);
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
    expect(g.geometry.index).toBe(src.index);
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

  it('同じ形を使う物は写しを共有する。法線や uv がなくても作れる', () => {
    const a = box(), b = new THREE.Mesh(a.geometry);
    const sk = new Skinner();
    expect(sk.plain(b)).toBe(sk.plain(a));
    const bare = new THREE.Mesh(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 1, 1, 0, 1, 0, 1, 1], 3)));
    const g = sk.plain(bare);
    expect(g.geometry.getAttribute('a_NORMAL')).toBeUndefined();
    expect((g.geometry.getAttribute('a_POSITION') as THREE.BufferAttribute).getZ(0)).toBe(-1);
  });

  it('dispose は作った形を捨てる', async () => {
    const sk = new Skinner();
    const { mesh } = makeMesh();
    const g = await ready(sk, mesh);
    const gp = sk.plain(box());
    const spies = [g.geometry, g.edge!, gp.geometry].map(x => vi.spyOn(x, 'dispose'));
    sk.dispose();
    for (const s of spies) expect(s).toHaveBeenCalledTimes(1);
  });
});
