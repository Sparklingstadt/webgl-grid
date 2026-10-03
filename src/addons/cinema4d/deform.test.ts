import { describe, expect, it } from 'vitest';
import { deformArrays, deformPoint, newDeformer, normalizeDeformers, type Box, type Deformer } from './deform';

// 底 y=0・上 y=2、x・z は -1〜1 の箱
const box: Box = { min: [-1, 0, -1], max: [1, 2, 1] };
const d = (p: Partial<Deformer> & Pick<Deformer, 'kind'>): Deformer => ({ ...newDeformer(p.kind), ...p });
const r = (v: number[]) => v.map(x => Math.round(x * 1000) / 1000 + 0);

describe('デフォーマ', () => {
  it('ツイスト: 上ほど軸まわりに回る (底はそのまま)', () => {
    const tw = [d({ kind: 'twist', amount: 90 })];
    expect(r(deformPoint([1, 0, 0], tw, box))).toEqual([1, 0, 0]);
    expect(r(deformPoint([1, 2, 0], tw, box))).toEqual([0, 2, 1]);
    expect(r(deformPoint([1, 1, 0], tw, box))).toEqual(r([Math.SQRT1_2, 1, Math.SQRT1_2]));
  });
  it('テーパーは上を細く、バルジはまん中をふくらませる', () => {
    expect(r(deformPoint([1, 2, 1], [d({ kind: 'taper', amount: -0.5 })], box))).toEqual([0.5, 2, 0.5]);
    expect(r(deformPoint([1, 1, 0], [d({ kind: 'bulge', amount: 0.5 })], box))).toEqual([1.5, 1, 0]);
    expect(r(deformPoint([1, 2, 0], [d({ kind: 'bulge', amount: 0.5 })], box))).toEqual([1, 2, 0]);
  });
  it('ベンド: 90° で、上の真ん中は円弧にそって横へ倒れる (長さは変わらない)。向きも変えられる', () => {
    const L = 2, R = L / (Math.PI / 2);
    expect(r(deformPoint([0, 2, 0], [d({ kind: 'bend', amount: 90 })], box))).toEqual(r([R, R, 0]));
    expect(r(deformPoint([0, 2, 0], [d({ kind: 'bend', amount: 90, directionDeg: 90 })], box))).toEqual(r([0, R, R]));
  });
  it('軸を X にすると、X にそって変形する', () => {
    const xbox: Box = { min: [0, -1, -1], max: [2, 1, 1] };
    expect(r(deformPoint([2, 1, 0], [d({ kind: 'taper', amount: -0.5, axis: 'x' })], xbox))).toEqual([2, 0.5, 0]);
  });
  it('強さ 0・オフはそのまま。重ねると順にかかる', () => {
    expect(deformPoint([0.3, 1.2, -0.4], [d({ kind: 'bend', amount: 0 }), d({ kind: 'twist', enabled: false })], box)).toEqual([0.3, 1.2, -0.4]);
    const both = deformPoint([1, 2, 0], [d({ kind: 'taper', amount: -0.5 }), d({ kind: 'twist', amount: 90 })], box);
    expect(r(both)).toEqual([0, 2, 0.5]);
  });
  it('法線も変形に合わせて回る (ツイストした横の面)', () => {
    const { positions, normals } = deformArrays([1, 2, 0], [1, 0, 0], [d({ kind: 'twist', amount: 90 })], box);
    expect(r([...positions])).toEqual([0, 2, 1]);
    expect(r([...normals!])).toEqual([0, 0, 1]);
  });
  it('設定をそろえる (知らない種類は外し、強さは範囲に収める)', () => {
    expect(normalizeDeformers([{ kind: 'melt' }, { kind: 'taper', amount: 9, axis: 'w' }])).toEqual([{ kind: 'taper', enabled: true, axis: 'y', amount: 2, directionDeg: 0 }]);
  });
});
