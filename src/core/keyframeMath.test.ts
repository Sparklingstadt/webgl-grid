import { describe, expect, it } from 'vitest';
import { interpolateKeys } from './keyframeMath';
import { ZERO_BONE, type BoneValue, type PoseKey } from './types';

const bone = (v: Partial<BoneValue>): BoneValue => ({ ...ZERO_BONE, ...v });
const key = (pose: [number, Partial<BoneValue>][], morphs: number[] | null = null): PoseKey =>
  ({ pose: new Map(pose.map(([i, v]) => [i, bone(v)])), morphs: morphs && Float32Array.from(morphs) });

describe('interpolateKeys', () => {
  const keys = new Map<number, PoseKey>([
    [0, key([[1, { rz: 0, px: 0 }]], [0, 1])],
    [30, key([[1, { rz: 60, px: 3 }]], [1, 0])],
  ]);

  it('キーフレームのちょうどの位置では、その値になる', () => {
    expect(interpolateKeys(keys, 0).pose.get(1)!.rz).toBeCloseTo(0);
    expect(interpolateKeys(keys, 30).pose.get(1)!.rz).toBeCloseTo(60);
  });

  it('あいだは、回転を球面線形補間・位置と表情を線形補間する', () => {
    const { pose, morphs } = interpolateKeys(keys, 15);
    expect(pose.get(1)!.rz).toBeCloseTo(30);
    expect(pose.get(1)!.px).toBeCloseTo(1.5);
    expect([...morphs!]).toEqual([0.5, 0.5]);
    expect(interpolateKeys(keys, 10).pose.get(1)!.rz).toBeCloseTo(20);
  });

  it('最初より前・最後より後は、端のキーフレームの値のまま', () => {
    expect(interpolateKeys(keys, -5).pose.get(1)!.rz).toBeCloseTo(0);
    expect(interpolateKeys(keys, 100).pose.get(1)!.rz).toBeCloseTo(60);
    expect([...interpolateKeys(keys, 100).morphs!]).toEqual([1, 0]);
  });

  it('片方のキーフレームにしかないボーンは、もう片方を最初の姿勢 (0) とみなす', () => {
    const k = new Map([[0, key([])], [10, key([[2, { rx: 40 }]])]]);
    expect(interpolateKeys(k, 5).pose.get(2)!.rx).toBeCloseTo(20);
  });

  it('回転は近いほうへ回る (170° から -170° へは 180° をまたいで 20°)', () => {
    const k = new Map([[0, key([[0, { ry: 170 }]])], [10, key([[0, { ry: -170 }]])]]);
    expect(Math.abs(interpolateKeys(k, 5).pose.get(0)!.ry)).toBeCloseTo(180);
  });

  it('キーフレームが 1 つなら、どのフレームでもその値', () => {
    const k = new Map([[12, key([[0, { rx: 10 }]])]]);
    expect(interpolateKeys(k, 0).pose.get(0)!.rx).toBeCloseTo(10);
    expect(interpolateKeys(k, 99).pose.get(0)!.rx).toBeCloseTo(10);
  });

  it('キーフレームがなければ空', () => {
    expect(interpolateKeys(new Map(), 3)).toEqual({ pose: new Map(), morphs: null });
  });
});
