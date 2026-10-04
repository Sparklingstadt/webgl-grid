import { describe, expect, it } from 'vitest';
import { makePmx } from '../../core/testing/pmx';
import { readMmdData } from './mmdData.ts';

const buf = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

describe('readMmdData', () => {
  it('変形の種類・骨・重み・材質のフラグ・輪郭線', async () => {
    const d = await readMmdData(buf(makePmx('t', { flags: 0x01 | 0x02 | 0x04 | 0x08 | 0x10, sdef: true })));
    expect(d.skin.count).toBe(8);
    expect([...d.skin.type]).toEqual([0, 0, 0, 0, 3, 3, 3, 3]);
    expect(d.materials).toEqual([{ flags: 0x1f, sphereMode: 0, edgeSize: 1 }]);
    expect(d.vertexEdgeSize[0]).toBe(1);
    expect(d.vertexEdgeSize.length).toBe(8);
    expect(d.skin.sdef.slice(36, 39)).not.toEqual(new Float32Array(3)); // 5 番目の頂点の C
    expect(d.skin.sdef.slice(0, 9)).toEqual(new Float32Array(9)); // BDEF1 は 0
    expect([...d.skin.bones.slice(16, 20)]).toEqual([0, 1, 0, 0]);
    expect([...d.skin.weights.slice(16, 20)]).toEqual([0.5, 0.5, 0, 0]);
    expect([...d.skin.bones.slice(0, 4)]).toEqual([0, 0, 0, 0]);
    expect([...d.skin.weights.slice(0, 4)]).toEqual([1, 0, 0, 0]);
  });
  it('Blob も読める。SDEF でなければ BDEF1 のまま (上の頂点は骨 1)', async () => {
    const d = await readMmdData(new Blob([buf(makePmx())]));
    expect([...d.skin.type]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(d.skin.bones[16]).toBe(1);
    expect(d.materials[0].flags).toBe(0x11);
  });
  it('QDEF (type 4) は QDEF。使わない骨 (-1) は 0', async () => {
    // 最初の頂点 (BDEF1: 骨 1 つ) を QDEF (骨 4 つ・重み 4 つ) に差し替える
    const src = makePmx();
    const head = new Uint8Array(new Float32Array([-2, 0, -2, -1, 0, -1, 0, 0]).buffer); // 位置・法線・UV
    const at = src.findIndex((_, i) => head.every((b, k) => src[i + k] === b)) + head.length;
    const q = new DataView(new ArrayBuffer(33));
    q.setUint8(0, 4);
    [0, -1, -1, -1].forEach((b, k) => q.setInt32(1 + k * 4, b, true));
    [1, 0, 0, 0].forEach((w, k) => q.setFloat32(17 + k * 4, w, true));
    const bytes = new Uint8Array([...src.slice(0, at), ...new Uint8Array(q.buffer), ...src.slice(at + 5)]);
    const d = await readMmdData(buf(bytes));
    expect([...d.skin.type]).toEqual([4, 0, 0, 0, 0, 0, 0, 0]);
    expect([...d.skin.bones.slice(0, 4)]).toEqual([0, 0, 0, 0]);
    expect([...d.skin.weights.slice(0, 4)]).toEqual([1, 0, 0, 0]);
    expect(d.materials).toHaveLength(1);
  });
});
