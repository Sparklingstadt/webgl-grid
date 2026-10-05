import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { ACCESSORY_DEFAULTS, ACCESSORY_ITEMS, accessoryMatrix, accessoryNameFor } from './accessory.ts';

// D3D の行ベクトル v·M で点を動かす。elements は D3D の行ごとの並び
function apply(m: { elements: number[] }, v: Vector3): Vector3 {
  const e = m.elements;
  return new Vector3(
    v.x * e[0] + v.y * e[4] + v.z * e[8] + e[12],
    v.x * e[1] + v.y * e[5] + v.z * e[9] + e[13],
    v.x * e[2] + v.y * e[6] + v.z * e[10] + e[14],
  );
}

function near(a: Vector3, x: number, y: number, z: number): void {
  expect(a.x).toBeCloseTo(x, 6);
  expect(a.y).toBeCloseTo(y, 6);
  expect(a.z).toBeCloseTo(z, 6);
}

describe('ACCESSORY', () => {
  it('項目と既定値', () => {
    expect([...ACCESSORY_ITEMS]).toEqual(['X', 'Y', 'Z', 'Rx', 'Ry', 'Rz', 'Si', 'Tr']);
    expect(ACCESSORY_DEFAULTS).toEqual({ X: 0, Y: 0, Z: 0, Rx: 0, Ry: 0, Rz: 0, Si: 1, Tr: 1 });
  });
});

describe('accessoryMatrix', () => {
  it('既定値は単位行列', () => {
    expect(accessoryMatrix({}).elements).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    expect(accessoryMatrix(ACCESSORY_DEFAULTS).elements).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  });

  it('Si = 2・X = 1 は拡大 2・位置 x = 1 (D3D の並びで e[0] = 2、e[12] = 1)', () => {
    const m = accessoryMatrix({ X: 1, Si: 2 });
    expect(m.elements[0]).toBe(2);
    expect(m.elements[5]).toBe(2);
    expect(m.elements[10]).toBe(2);
    expect(m.elements[12]).toBe(1);
    near(apply(m, new Vector3(1, 1, 1)), 3, 2, 2);
  });

  it('Ry = 90 で +X が −Z へ回る (左手系で Y 軸に +)', () => {
    near(apply(accessoryMatrix({ Ry: 90 }), new Vector3(1, 0, 0)), 0, 0, -1);
  });

  it('Rx = 90 で +Y が +Z へ、Rz = 90 で +X が +Y へ回る', () => {
    near(apply(accessoryMatrix({ Rx: 90 }), new Vector3(0, 1, 0)), 0, 0, 1);
    near(apply(accessoryMatrix({ Rz: 90 }), new Vector3(1, 0, 0)), 0, 1, 0);
  });

  it('回転の順は Z → X → Y (D3DXMatrixRotationYawPitchRoll: Ry がヨー、Rx がピッチ、Rz がロール)', () => {
    // +X を Rz = 90 で +Y に、その +Y を Rx = 90 で +Z に、その +Z を Ry = 90 で +X に
    near(apply(accessoryMatrix({ Rx: 90, Ry: 90, Rz: 90 }), new Vector3(1, 0, 0)), 1, 0, 0);
    // +Y は Rz で −X、Rx では動かず、Ry で −X が +Z へ
    near(apply(accessoryMatrix({ Rx: 90, Ry: 90, Rz: 90 }), new Vector3(0, 1, 0)), 0, 0, 1);
  });

  it('拡大 → 回転 → 位置の順', () => {
    const m = accessoryMatrix({ Si: 2, Ry: 90, X: 5 });
    near(apply(m, new Vector3(1, 0, 0)), 5, 0, -2);
  });

  it('Tr は行列に入らない', () => {
    expect(accessoryMatrix({ Tr: 0.3 }).elements).toEqual(accessoryMatrix({}).elements);
  });

  it('accessoryNameFor: ポストエフェクトの .fx のファイル名の拡張子を .x に (フォルダは除く。大文字の .FX も)', () => {
    expect(accessoryNameFor('ray.fx')).toBe('ray.x');
    expect(accessoryNameFor('Main/sub/ray.FX')).toBe('ray.x');
    expect(accessoryNameFor('a\\b.fx')).toBe('b.x');
    expect(accessoryNameFor('post')).toBe('post.x');
  });
});
