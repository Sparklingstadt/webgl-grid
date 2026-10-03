import { describe, expect, it } from 'vitest';
import { CLONER_DEFAULT, clonerLayout, cloneCount, normalizeCloner, type ClonerSettings } from './cloner';

const s = (p: Partial<ClonerSettings>): ClonerSettings => normalizeCloner({ ...CLONER_DEFAULT, ...p });
const r2 = (p: { x: number; y: number; z: number; ry: number }) => [p.x, p.y, p.z, p.ry].map(v => Math.round(v * 100) / 100 + 0);

describe('クローナーの並べ方', () => {
  it('直線: 元の位置から 1 つずつずらし、回す', () => {
    const l = clonerLayout(s({ mode: 'linear', count: 3, step: [2, 0.5, 0], stepRotDeg: 90 }), 100);
    expect(l.map(r2)).toEqual([[0, 0, 0, 0], [2, 0.5, 0, 1.57], [4, 1, 0, 3.14]]);
  });
  it('放射: 一周なら等分 (端が重ならない)、範囲なら両端を含める。外を向く', () => {
    const full = clonerLayout(s({ mode: 'radial', count: 4, radius: 2 }), 100);
    expect(full.map(r2)).toEqual([[0, 0, 2, 0], [2, 0, 0, 1.57], [0, 0, -2, 3.14], [-2, 0, 0, 4.71]]);
    const half = clonerLayout(s({ mode: 'radial', count: 3, radius: 1, startDeg: 0, endDeg: 180, align: false }), 100);
    expect(half.map(r2)).toEqual([[0, 0, 1, 0], [1, 0, 0, 0], [0, 0, -1, 0]]);
  });
  it('グリッド: 横は元の物を真ん中に、縦は地面から上へ', () => {
    const l = clonerLayout(s({ mode: 'grid', grid: [3, 2, 1], spacing: [1, 2, 1] }), 100);
    expect(l.map(r2)).toEqual([[-1, 0, 0, 0], [0, 0, 0, 0], [1, 0, 0, 0], [-1, 2, 0, 0], [0, 2, 0, 0], [1, 2, 0, 0]]);
    expect(cloneCount(s({ mode: 'grid', grid: [3, 2, 1] }), 100)).toBe(6);
  });
  it('数の上限で切る', () => {
    expect(clonerLayout(s({ mode: 'grid', grid: [10, 10, 10] }), 25)).toHaveLength(25);
    expect(cloneCount(s({ mode: 'grid', grid: [10, 10, 10] }), 25)).toBe(25);
  });
  it('ばらつき: 同じシードなら同じ、シードを変えると変わる。範囲を超えない', () => {
    const a = clonerLayout(s({ mode: 'linear', count: 20, step: [0, 0, 0], random: { position: 0.5, rotationDeg: 30, seed: 7 } }), 100);
    const b = clonerLayout(s({ mode: 'linear', count: 20, step: [0, 0, 0], random: { position: 0.5, rotationDeg: 30, seed: 7 } }), 100);
    const c = clonerLayout(s({ mode: 'linear', count: 20, step: [0, 0, 0], random: { position: 0.5, rotationDeg: 30, seed: 8 } }), 100);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    for (const p of a) {
      expect(Math.abs(p.x)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(p.ry)).toBeLessThanOrEqual(Math.PI / 6 + 1e-9);
      expect(p.y).toBe(0);
    }
  });
  it('設定をそろえる (数は 1 以上・グリッドは 50 まで・知らない並べ方は既定)', () => {
    const n = normalizeCloner({ mode: 'spiral' as never, count: 0, grid: [0, 99, 2.4] as never, radius: -1 });
    expect(n).toMatchObject({ mode: 'grid', count: 1, grid: [1, 50, 2], radius: 0 });
    expect(normalizeCloner(undefined)).toEqual(CLONER_DEFAULT);
  });
});
