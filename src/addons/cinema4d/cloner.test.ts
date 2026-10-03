import { describe, expect, it } from 'vitest';
import { CLONER_DEFAULT, clonerLayout, cloneCount, normalizeCloner, placeAround, type ClonerSettings, type Effector, type FieldLayer } from './cloner';
import { parseSelection, type LayoutEnv } from './effectors';

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
  it('設定をそろえる (数は 1 以上・グリッドは 50 まで・おかしな名前の並べ方は既定。アドオンの並べ方の名前は残す)', () => {
    const n = normalizeCloner({ mode: 'Spiral!' as never, count: 0, grid: [0, 99, 2.4] as never, radius: -1 });
    expect(n).toMatchObject({ mode: 'grid', count: 1, grid: [1, 50, 2], radius: 0 });
    expect(normalizeCloner({ mode: 'honeycomb', modeParams: { width: 4, bad: {} as never } })).toMatchObject({ mode: 'honeycomb', modeParams: { width: 4 } });
    expect(clonerLayout(normalizeCloner({ mode: 'honeycomb' }), 100)).toEqual([]); // (登録されていなければ並べない)
    expect(normalizeCloner(undefined)).toEqual(CLONER_DEFAULT);
  });
  it('エフェクタの設定をそろえる (登録されていない種類も残す。おかしな名前は外す。前の版の遅れは params に)', () => {
    const n = normalizeCloner({ effectors: [{ kind: 'shader' } as never, { kind: 'Bad Kind' } as never, { kind: 'delay', frames: 9999, scale: -1 } as never] });
    expect(n.effectors).toEqual([
      { kind: 'shader', enabled: true, position: [0, 0, 0], rotationDeg: 0, scale: 1, params: {}, select: '', fields: [] },
      { kind: 'delay', enabled: true, position: [0, 0, 0], rotationDeg: 0, scale: 0.01, params: { frames: 300 }, select: '', fields: [] },
    ]);
  });
  it('エフェクタは、登録された種類 (env) がなければかけない', () => {
    const l = clonerLayout(s({ mode: 'linear', count: 2, effectors: [{ kind: 'plain', enabled: true, position: [0, 1, 0], rotationDeg: 0, scale: 1, params: {}, select: '', fields: [] }] }), 100);
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

describe('MoGraph 選択とフィールド', () => {
  // 試しのエフェクタ (全部に y + 1) とフィールド (x が 0 以上なら 1)
  const env = (fields = true): LayoutEnv => ({
    effector: k => (k === 'up' ? { key: 'up', name: '上へ' } : undefined),
    field: k => (fields && k === 'half' ? { key: 'half', name: '半分', value: p => (p.x >= 0 ? 1 : 0) } : undefined),
    time: 0, origin: { x: 0, y: 0, z: 0, r: 0 },
  });
  const up = (patch: Partial<Effector> = {}): Effector => ({ kind: 'up', enabled: true, position: [0, 1, 0], rotationDeg: 0, scale: 1, params: {}, select: '', fields: [], ...patch });
  const layer = (patch: Partial<FieldLayer> = {}): FieldLayer => ({ kind: 'half', enabled: true, blend: 'normal', opacity: 1, invert: false, params: {}, ...patch });
  const ys = (e: Effector, en = env()) => clonerLayout(s({ mode: 'linear', count: 5, step: [1, 0, 0], effectors: [e] }), 100, en).map(p => p.y);
  // (直線は 0, 1, 2, 3, 4 に並ぶので、真ん中を原点に寄せて試す)
  const centered = (e: Effector, en = env()) => clonerLayout(s({ mode: 'grid', grid: [5, 1, 1], spacing: [1, 1, 1], effectors: [e] }), 100, en).map(p => p.y);

  it('MoGraph 選択: 番号・範囲・偶数・奇数', () => {
    expect(ys(up({ select: '0-1, 4' }))).toEqual([1, 1, 0, 0, 1]);
    expect(ys(up({ select: '3-' }))).toEqual([0, 0, 0, 1, 1]);
    expect(ys(up({ select: '偶数' }))).toEqual([1, 0, 1, 0, 1]);
    expect(ys(up({ select: '奇数' }))).toEqual([0, 1, 0, 1, 0]);
    expect(parseSelection('', 3)).toBeNull();
  });
  it('フィールド: 範囲の中だけ効き、反転・不透明度・重ね方が効く。登録されていなければ全体に効く', () => {
    expect(centered(up({ fields: [layer()] }))).toEqual([0, 0, 1, 1, 1]);
    expect(centered(up({ fields: [layer({ invert: true })] }))).toEqual([1, 1, 0, 0, 0]);
    expect(centered(up({ fields: [layer({ opacity: 0.5 })] }))).toEqual([0, 0, 0.5, 0.5, 0.5]);
    expect(centered(up({ fields: [layer(), layer({ invert: true, blend: 'max' })] }))).toEqual([1, 1, 1, 1, 1]);
    expect(centered(up({ fields: [layer(), layer({ invert: true, blend: 'multiply' })] }))).toEqual([0, 0, 0, 0, 0]);
    expect(centered(up({ fields: [layer()] }), env(false))).toEqual([1, 1, 1, 1, 1]);
  });
});
