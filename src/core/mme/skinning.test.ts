import { describe, expect, it } from 'vitest';
import {
  BufferAttribute, BufferGeometry, Bone, Euler, Matrix4, Quaternion, Skeleton, SkinnedMesh, Vector3, Vector4,
} from 'three';
import { toMmd, toMmdVec } from './coords.ts';
import { SKIN, applyMorphs, expandEdges, skin, type SkinData } from './skinning.ts';

const close = (a: ArrayLike<number>, digits = 5) => Array.from(a).map(n => expect.closeTo(n, digits));

// 1 頂点ぶんの SkinData
function oneVertex(type: number, bones: number[], weights: number[], sdef: number[] = Array.from({ length: 9 }, () => 0)): SkinData {
  return {
    count: 1,
    type: Uint8Array.of(type),
    bones: Int32Array.from(bones),
    weights: Float32Array.from(weights),
    sdef: Float32Array.from(sdef),
  };
}

function boneArray(...ms: Matrix4[]): Float32Array {
  const a = new Float32Array(ms.length * 16);
  ms.forEach((m, i) => a.set(m.elements, i * 16));
  return a;
}

describe('BDEF', () => {
  it('three.js の applyBoneTransform と同じ (左手系に直して比べる)', () => {
    // 骨 2 本 (2 本目は 1 本目の子)。メッシュにも動きを付けて、bindMatrix が単位行列でない場合を確かめる
    const bone0 = new Bone(), bone1 = new Bone();
    bone1.position.set(0, 1, 0);
    bone0.add(bone1);
    const rest = [[0, 0, 0], [0.5, 1, 0.3], [-0.4, 1.5, 0.2], [0.2, 0.6, -0.5]];
    const idx = [[0, 0, 0, 0], [1, 0, 0, 0], [0, 1, 0, 0], [0, 1, 0, 1]];
    const wgt = [[1, 0, 0, 0], [1, 0, 0, 0], [0.3, 0.7, 0, 0], [0.1, 0.2, 0.3, 0.4]];
    const types = [SKIN.BDEF1, SKIN.BDEF1, SKIN.BDEF2, SKIN.BDEF4];
    const rnormal = [[0, 0, 1], [1, 0, 0], [0, 1, 0], [0.6, 0, 0.8]];

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(Float32Array.from(rest.flat()), 3));
    geometry.setAttribute('skinIndex', new BufferAttribute(Uint16Array.from(idx.flat()), 4));
    geometry.setAttribute('skinWeight', new BufferAttribute(Float32Array.from(wgt.flat()), 4));
    const mesh = new SkinnedMesh(geometry);
    mesh.position.set(2, -1, 0.5);
    mesh.rotation.set(0.2, 0.4, -0.1);
    mesh.add(bone0);
    const skeleton = new Skeleton([bone0, bone1]);
    mesh.bind(skeleton);
    bone1.rotation.z = Math.PI / 6; // 2 本目を z まわりに 30°
    bone0.position.set(0.1, 0.2, 0);
    mesh.updateMatrixWorld(true);
    skeleton.update();

    const boneMatrices = skeleton.boneMatrices;
    if (!boneMatrices) throw new Error('boneMatrices がない');
    // 骨の変形の行列 (右手系): bindInverse · (bone.matrixWorld · boneInverse) · bind
    const rh = [0, 1].map(i => new Matrix4().copy(mesh.bindMatrixInverse)
      .multiply(new Matrix4().fromArray(boneMatrices, i * 16))
      .multiply(mesh.bindMatrix));
    const bones = boneArray(...rh.map(toMmd));

    const data: SkinData = {
      count: 4,
      type: Uint8Array.from(types),
      bones: Int32Array.from(idx.flat()),
      weights: Float32Array.from(wgt.flat()),
      sdef: new Float32Array(36),
    };
    const pos = Float32Array.from(rest.flatMap(p => toMmdVec(new Vector3(...p)).toArray()));
    const nrm = Float32Array.from(rnormal.flatMap(n => toMmdVec(new Vector3(...n)).toArray()));
    const outPos = new Float32Array(12), outNrm = new Float32Array(12);
    skin(data, pos, nrm, bones, outPos, outNrm);

    for (let v = 0; v < 4; v++) {
      const p = new Vector3(...rest[v]);
      mesh.applyBoneTransform(v, p);
      expect(Array.from(outPos.subarray(v * 3, v * 3 + 3))).toEqual(close(toMmdVec(p).toArray()));

      // three.js の skinnormal_vertex と同じ: 重みで混ぜた行列の 3×3 で回す
      const blend = new Matrix4().set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
      for (let k = 0; k < 4; k++) {
        const m = rh[idx[v][k]].elements;
        for (let e = 0; e < 16; e++) blend.elements[e] += m[e] * wgt[v][k];
      }
      const n = new Vector4(...rnormal[v], 0).applyMatrix4(blend);
      const n3 = new Vector3(n.x, n.y, n.z).normalize();
      expect(Array.from(outNrm.subarray(v * 3, v * 3 + 3))).toEqual(close(toMmdVec(n3).toArray()));
    }
  });

  it('BDEF1 は重みの数字によらず骨 1 本ぶん', () => {
    const m = new Matrix4().makeRotationZ(0.5).setPosition(1, 2, 3);
    const out = new Float32Array(3), outN = new Float32Array(3);
    skin(oneVertex(SKIN.BDEF1, [0, 0, 0, 0], [0, 0, 0, 0]), Float32Array.of(1, 0, 0), Float32Array.of(1, 0, 0), boneArray(m), out, outN);
    expect(Array.from(out)).toEqual(close(new Vector3(1, 0, 0).applyMatrix4(m).toArray()));
  });

  it('QDEF は BDEF4 と同じに扱う', () => {
    const m0 = new Matrix4().makeRotationX(0.7).setPosition(1, 0, 0);
    const m1 = new Matrix4().makeRotationY(-0.4).setPosition(0, 2, 1);
    const bones = boneArray(m0, m1);
    const p = Float32Array.of(0.3, -0.2, 0.9), n = Float32Array.of(0, 0, 1);
    const a = new Float32Array(3), an = new Float32Array(3), b = new Float32Array(3), bn = new Float32Array(3);
    skin(oneVertex(SKIN.QDEF, [0, 1, 0, 1], [0.1, 0.4, 0.2, 0.3]), p, n, bones, a, an);
    skin(oneVertex(SKIN.BDEF4, [0, 1, 0, 1], [0.1, 0.4, 0.2, 0.3]), p, n, bones, b, bn);
    expect(Array.from(a)).toEqual(close(b, 7));
    expect(Array.from(an)).toEqual(close(bn, 7));
  });

  it('重みの合計が 0 の頂点は入力をそのまま写す', () => {
    const bones = boneArray(new Matrix4().makeTranslation(5, 5, 5));
    for (const type of [SKIN.BDEF2, SKIN.BDEF4, SKIN.QDEF, SKIN.SDEF]) {
      const out = new Float32Array(3), outN = new Float32Array(3);
      skin(oneVertex(type, [0, 0, 0, 0], [0, 0, 0, 0]), Float32Array.of(1, 2, 3), Float32Array.of(0, 1, 0), bones, out, outN);
      expect(Array.from(out)).toEqual([1, 2, 3]);
      expect(Array.from(outN)).toEqual([0, 1, 0]);
    }
  });
});

// 手で式のとおりに組んだ SDEF の値 (three.js の Quaternion・Vector3・Matrix4 を使い、本体とは別の経路で出す)
function sdefReference(m0: Matrix4, m1: Matrix4, w0: number, w1: number, c: Vector3, r0: Vector3, r1: Vector3, p: Vector3, n: Vector3) {
  const rw = r0.clone().multiplyScalar(w0).addScaledVector(r1, w1);
  const rr0 = c.clone().add(r0).sub(rw), rr1 = c.clone().add(r1).sub(rw);
  const cr0 = c.clone().add(rr0).multiplyScalar(0.5), cr1 = c.clone().add(rr1).multiplyScalar(0.5);
  const q0 = new Quaternion(), q1 = new Quaternion(), s = new Vector3(), t = new Vector3();
  m0.decompose(t, q0, s);
  m1.decompose(t, q1, s);
  if (q0.dot(q1) < 0) q1.set(-q1.x, -q1.y, -q1.z, -q1.w);
  const q = q0.clone().slerp(q1, w1);
  const pos = p.clone().sub(c).applyQuaternion(q)
    .add(cr0.applyMatrix4(m0).multiplyScalar(w0))
    .add(cr1.applyMatrix4(m1).multiplyScalar(w1));
  return { pos, nrm: n.clone().applyQuaternion(q) };
}

describe('SDEF', () => {
  const c = new Vector3(0.2, 1.1, -0.3), r0 = new Vector3(-0.4, 0.3, 0.1), r1 = new Vector3(0.5, -0.2, 0.25);
  const sdef = [...c.toArray(), ...r0.toArray(), ...r1.toArray()];
  const p = new Vector3(0.7, 0.4, -0.6), n = new Vector3(0.36, 0.48, 0.8);

  const euler = (x: number, y: number, z: number, scale: number, pos: [number, number, number]) =>
    new Matrix4().compose(new Vector3(...pos), new Quaternion().setFromEuler(new Euler(x, y, z)), new Vector3(scale, scale, scale));

  // 回転の向きごとに、四元数を取り出す 4 つの場合分け (trace > 0 と、x・y・z が最大の 3 つ) を通す
  const cases: [string, Matrix4, Matrix4][] = [
    ['小さい回転', euler(0.3, 0.5, 0.2, 1, [1, 2, 3]), euler(-0.4, 0.2, 0.9, 1, [-1, 0.5, 2])],
    ['x まわりに大きく', euler(3.0, 0.1, 0.2, 1, [0, 1, 0]), euler(-2.8, 0.3, -0.2, 1, [1, 0, 1])],
    ['y まわりに大きく', euler(0.1, 3.0, 0.2, 1, [0, 1, 0]), euler(0.2, -2.7, 0.1, 1, [1, 0, 1])],
    ['z まわりに大きく', euler(0.1, 0.2, 3.0, 1, [0, 1, 0]), euler(0.2, 0.1, -2.9, 1, [1, 0, 1])],
    ['拡縮つき (回転だけ取り出す)', euler(0.3, 0.5, 0.2, 2, [1, 2, 3]), euler(-0.4, 0.2, 0.9, 0.5, [-1, 0.5, 2])],
  ];

  for (const [name, m0, m1] of cases) {
    it(`式どおり (手で作った 1 頂点): ${name}`, () => {
      const w0 = 0.35, w1 = 0.65;
      const ref = sdefReference(m0, m1, w0, w1, c, r0, r1, p, n);
      const out = new Float32Array(3), outN = new Float32Array(3);
      skin(oneVertex(SKIN.SDEF, [0, 1, 0, 0], [w0, w1, 0, 0], sdef), Float32Array.from(p.toArray()), Float32Array.from(n.toArray()), boneArray(m0, m1), out, outN);
      expect(Array.from(out)).toEqual(close(ref.pos.toArray()));
      expect(Array.from(outN)).toEqual(close(ref.nrm.toArray()));
    });
  }

  it('重みが 1/0 のときは BDEF1 と同じ (剛体のとき)', () => {
    const m0 = euler(0.6, -0.3, 1.1, 1, [1, 2, 3]), m1 = euler(-0.9, 0.4, 0.2, 1, [-2, 0, 1]);
    const bones = boneArray(m0, m1);
    const pos = Float32Array.from(p.toArray()), nrm = Float32Array.from(n.toArray());
    for (const [w0, w1, bone] of [[1, 0, 0], [0, 1, 1]] as const) {
      const a = new Float32Array(3), an = new Float32Array(3), b = new Float32Array(3), bn = new Float32Array(3);
      skin(oneVertex(SKIN.SDEF, [0, 1, 0, 0], [w0, w1, 0, 0], sdef), pos, nrm, bones, a, an);
      skin(oneVertex(SKIN.BDEF1, [bone, 0, 0, 0], [1, 0, 0, 0]), pos, nrm, bones, b, bn);
      expect(Array.from(a)).toEqual(close(b));
      expect(Array.from(an)).toEqual(close(bn));
    }
  });

  it('四元数の内積が負なら短い方の弧で補う', () => {
    // x まわりに −30° と −170° の中間は −100° (長い方の弧なら +80° になる)。C・R・移動は 0
    const rx = (deg: number) => new Matrix4().makeRotationX(deg * Math.PI / 180);
    const out = new Float32Array(3), outN = new Float32Array(3);
    skin(oneVertex(SKIN.SDEF, [0, 1, 0, 0], [0.5, 0.5, 0, 0]), Float32Array.of(0, 1, 0), Float32Array.of(0, 1, 0), boneArray(rx(-30), rx(-170)), out, outN);
    const a = -100 * Math.PI / 180;
    expect(Array.from(out)).toEqual(close([0, Math.cos(a), Math.sin(a)]));
    expect(Array.from(outN)).toEqual(close([0, Math.cos(a), Math.sin(a)]));
  });

  it('SDEF と BDEF が混ざった頂点列でも、頂点ごとに正しく変形する', () => {
    const m0 = euler(0.3, 0.5, 0.2, 1, [1, 2, 3]), m1 = euler(-0.4, 0.2, 0.9, 1, [-1, 0.5, 2]);
    const data: SkinData = {
      count: 2,
      type: Uint8Array.of(SKIN.BDEF1, SKIN.SDEF),
      bones: Int32Array.of(1, 0, 0, 0, 0, 1, 0, 0),
      weights: Float32Array.of(1, 0, 0, 0, 0.35, 0.65, 0, 0),
      sdef: Float32Array.from([...Array.from({ length: 9 }, () => 0), ...sdef]),
    };
    const pos = Float32Array.from([...p.toArray(), ...p.toArray()]);
    const nrm = Float32Array.from([...n.toArray(), ...n.toArray()]);
    const out = new Float32Array(6), outN = new Float32Array(6);
    skin(data, pos, nrm, boneArray(m0, m1), out, outN);
    expect(Array.from(out.subarray(0, 3))).toEqual(close(p.clone().applyMatrix4(m1).toArray()));
    expect(Array.from(out.subarray(3, 6))).toEqual(close(sdefReference(m0, m1, 0.35, 0.65, c, r0, r1, p, n).pos.toArray()));
  });
});

describe('頂点モーフ', () => {
  it('頂点モーフは重み付きで足す', () => {
    const base = Float32Array.of(1, 2, 3, 4, 5, 6);
    const deltas = [Float32Array.of(1, 0, 0, 0, 0, 0), Float32Array.of(0, 2, 0, 0, 0, -2), Float32Array.of(9, 9, 9, 9, 9, 9)];
    const out = new Float32Array(6);
    applyMorphs(base, deltas, [0.5, 1, 0], out);
    expect(Array.from(out)).toEqual([1.5, 4, 3, 4, 5, 4]);
    expect(Array.from(base)).toEqual([1, 2, 3, 4, 5, 6]); // 元は変えない
  });

  it('重みが全部 0 なら base のまま、out が base と同じ配列でも動く', () => {
    const base = Float32Array.of(1, 2, 3);
    const out = new Float32Array(3);
    applyMorphs(base, [Float32Array.of(5, 5, 5)], [0], out);
    expect(Array.from(out)).toEqual([1, 2, 3]);
    applyMorphs(base, [Float32Array.of(1, 1, 1)], [2], base);
    expect(Array.from(base)).toEqual([3, 4, 5]);
  });
});

describe('expandEdges', () => {
  it('法線 × (太さ / 300) × 距離 × tan(半分の視野)', () => {
    const out = new Float32Array(3);
    expandEdges(Float32Array.of(0, 0, 0), Float32Array.of(1, 0, 0), Float32Array.of(300), [0, 0, -10], 0.5, out);
    expect(Array.from(out)).toEqual([5, 0, 0]);
  });

  it('頂点ごとに太さと距離が違う', () => {
    const out = new Float32Array(6);
    expandEdges(Float32Array.of(0, 0, 0, 0, 3, 0), Float32Array.of(0, 1, 0, 0, 0, 1), Float32Array.of(150, 0), [0, 0, -4], 1, out);
    // 1 つ目: 距離 4 → 0.5 × 4 = 2。2 つ目は太さ 0 で動かない
    expect(Array.from(out)).toEqual(close([0, 2, 0, 0, 3, 0]));
  });
});
