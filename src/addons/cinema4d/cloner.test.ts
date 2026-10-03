import { describe, expect, it } from 'vitest';
import { CLONER_DEFAULT, clonerLayout, cloneCount, normalizeCloner, placeAround, type ClonerSettings } from './cloner';

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
  it('エフェクタの設定をそろえる (登録されていない種類も残す。おかしな名前は外す。前の版の遅れは params に)', () => {
    const n = normalizeCloner({ effectors: [{ kind: 'shader' } as never, { kind: 'Bad Kind' } as never, { kind: 'delay', frames: 9999, scale: -1 } as never] });
    expect(n.effectors).toEqual([
      { kind: 'shader', enabled: true, position: [0, 0, 0], rotationDeg: 0, scale: 1, params: {} },
      { kind: 'delay', enabled: true, position: [0, 0, 0], rotationDeg: 0, scale: 0.01, params: { frames: 300 } },
    ]);
  });
  it('エフェクタは、登録された種類 (env) がなければかけない', () => {
    const l = clonerLayout(s({ mode: 'linear', count: 2, effectors: [{ kind: 'plain', enabled: true, position: [0, 1, 0], rotationDeg: 0, scale: 1, params: {} }] }), 100);
    expect(l.map(p => p.y)).toEqual([0, 0]);
  });
});

describe('クローンの置き場所を外から見た位置にする', () => {
  it('元の物の向きで回してから、元の物の位置へずらす', () => {
    const p = { x: 1, y: 0, z: 0, ry: 0.2, scale: 1, delay: 0 };
    expect(placeAround(p, 5, 3, 0)).toEqual({ x: 6, z: 3, r: 0.2 });
    const q = placeAround(p, 5, 3, Math.PI / 2); // 縦軸まわりに 90° (+X は -Z へ)
    expect([+q.x.toFixed(6), +q.z.toFixed(6), +q.r.toFixed(6)]).toEqual([5, 2, +(Math.PI / 2 + 0.2).toFixed(6)]);
  });
});
