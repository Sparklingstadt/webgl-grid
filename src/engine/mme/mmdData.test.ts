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
  it('BDEF2・BDEF4・QDEF の骨と重み。使わない骨 (-1) は 0', async () => {
    // BDEF1 (骨 1 つ) の頂点を差し替える。頂点は 41 バイトずつで、後ろから差し替えれば前の頂点の位置は変わらない
    const src = makePmx();
    const head = new Uint8Array(new Float32Array([-2, 0, -2, -1, 0, -1, 0, 0]).buffer); // 最初の頂点の位置・法線・UV
    const first = src.findIndex((_, i) => head.every((b, k) => src[i + k] === b));
    const skinBytes = (type: number, bones: number[], weights: number[]) => {
      const q = new DataView(new ArrayBuffer(1 + bones.length * 4 + weights.length * 4));
      q.setUint8(0, type);
      bones.forEach((b, k) => q.setInt32(1 + k * 4, b, true));
      weights.forEach((w, k) => q.setFloat32(1 + bones.length * 4 + k * 4, w, true));
      return new Uint8Array(q.buffer);
    };
    let bytes = src;
    const replace = (v: number, skin: Uint8Array) => {
      const at = first + v * 41 + 32;
      bytes = new Uint8Array([...bytes.slice(0, at), ...skin, ...bytes.slice(at + 5)]);
    };
    replace(2, skinBytes(2, [1, 0, 1, -1], [0.125, 0.25, 0.5, 0.125])); // BDEF4
    replace(1, skinBytes(1, [0, 1], [0.25]));                           // BDEF2 (重みは 1 つだけ書く)
    replace(0, skinBytes(4, [0, -1, -1, -1], [1, 0, 0, 0]));            // QDEF
    const d = await readMmdData(buf(bytes));
    expect([...d.skin.type]).toEqual([4, 1, 2, 0, 0, 0, 0, 0]);
    expect([...d.skin.bones.slice(0, 12)]).toEqual([0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 1, 0]);
    expect([...d.skin.weights.slice(0, 12)]).toEqual([1, 0, 0, 0, 0.25, 0.75, 0, 0, 0.125, 0.25, 0.5, 0.125]);
    expect(d.skin.bones[12]).toBe(0); // 4 番目はそのまま BDEF1 (骨 0)
    expect(d.materials).toHaveLength(1);
  });
  it('vertexEdgeSize: 材質の太さ × 頂点の倍率。最初に使う材質が決める。使われない頂点は 0', async () => {
    const d = await readMmdData(buf(makePmx('t', {
      parts: [
        { faces: [0, 1, 2, 1, 2, 3], edgeSize: 2 },
        { faces: [2, 3, 4, 4, 5, 6], edgeSize: 3 }, // 2・3 は最初の材質が使っている
      ],
      edgeRatios: [0.5, 1, 1, 1, 0.5, 1, 1, 0.7], // 7 番目 (添字 7) はどの面にも使われない
    })));
    expect(d.materials.map(m => m.edgeSize)).toEqual([2, 3]);
    expect([...d.vertexEdgeSize]).toEqual([1, 2, 2, 2, 1.5, 3, 3, 0]);
  });
});
