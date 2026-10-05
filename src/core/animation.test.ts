import { describe, expect, it } from 'vitest';
import {
  LINEAR, animationFromJson, animationFromPoseKeys, animationToJson, copyKeys, createAnimation, curveAt, insertMmeKeys, insertPropKeys, isEmpty, pasteKeys, deleteKeys, evaluate, insertKeys, keyFrames, moveKeys,
  type Animation, type Curve,
} from './animation';
import { ZERO_BONE, type BoneValue } from './types';

const bone = (v: Partial<BoneValue>): BoneValue => ({ ...ZERO_BONE, ...v });
const pose = (...p: [number, Partial<BoneValue>][]) => new Map(p.map(([i, v]) => [i, bone(v)]));

// 0 フレームで右腕 (1) 0°・まばたき (1) 1、30 フレームで右腕 60°・位置 3・まばたき 0
function sample(curve: Curve = LINEAR): Animation {
  const a = createAnimation();
  insertKeys(a, 0, pose([1, { rz: 0 }]), [0, 1]);
  insertKeys(a, 30, pose([1, { rz: 60, px: 3 }]), [0, 0]);
  a.bones.get(1)!.get(30)!.curve = curve;
  return a;
}

describe('補間曲線', () => {
  it('直線は時間どおり、なめらかは始めと終わりがゆっくり', () => {
    for (const x of [0, 0.1, 0.5, 0.9, 1]) expect(curveAt(LINEAR, x)).toBeCloseTo(x, 4);
    const ease: Curve = [0.42, 0, 0.58, 1];
    expect(curveAt(ease, 0.1)).toBeLessThan(0.05);
    expect(curveAt(ease, 0.5)).toBeCloseTo(0.5, 3);
    expect(curveAt(ease, 0.9)).toBeGreaterThan(0.95);
  });
});

describe('チャンネルごとのキーフレーム', () => {
  it('キーのちょうどの位置ではその値、あいだは回転を球面線形補間・位置と表情を線形補間する', () => {
    const a = sample();
    expect(evaluate(a, 0).pose.get(1)!.rz).toBeCloseTo(0);
    expect(evaluate(a, 30).pose.get(1)!.rz).toBeCloseTo(60);
    const mid = evaluate(a, 15);
    expect(mid.pose.get(1)!.rz).toBeCloseTo(30);
    expect(mid.pose.get(1)!.px).toBeCloseTo(1.5);
    expect(mid.morphs.get(1)).toBeCloseTo(0.5);
    expect(mid.morphs.has(0)).toBe(false); // 0 のままの表情にはチャンネルを作らない
  });
  it('補間曲線は行き先のキーに付き、そのあいだの進み方を変える', () => {
    const a = sample([0.42, 0, 1, 1]); // ゆっくり始まる
    expect(evaluate(a, 6).pose.get(1)!.rz).toBeLessThan(60 * 6 / 30 - 3);
    expect(evaluate(a, 15).morphs.get(1)).toBeCloseTo(0.5); // 表情のチャンネルは直線のまま
  });
  it('最初より前・最後より後は、端のキーの値のまま。回転は近いほうへ回る', () => {
    const a = sample();
    expect(evaluate(a, -5).pose.get(1)!.rz).toBeCloseTo(0);
    expect(evaluate(a, 100).pose.get(1)!.rz).toBeCloseTo(60);
    const b = createAnimation();
    insertKeys(b, 0, pose([0, { ry: 170 }]), null);
    insertKeys(b, 10, pose([0, { ry: -170 }]), null);
    expect(Math.abs(evaluate(b, 5).pose.get(0)!.ry)).toBeCloseTo(180);
  });
  it('ボーンごとに別のフレームへキーを打てる (ほかのボーンは動かない)', () => {
    const a = createAnimation();
    insertKeys(a, 0, pose([1, { rz: 0 }], [2, { rx: 0 }]), null);
    insertKeys(a, 20, pose([2, { rx: 40 }]), null, [2]); // 2 だけ
    expect(keyFrames(a)).toEqual([0, 20]);
    expect([...a.bones.get(1)!.keys()]).toEqual([0]);
    expect(evaluate(a, 10).pose.get(2)!.rx).toBeCloseTo(20);
    expect(evaluate(a, 10).pose.get(1)!.rz).toBeCloseTo(0);
  });
  it('打ち直すと値だけ替わり、補間曲線はそのまま', () => {
    const a = sample([0, 0, 0.58, 1]);
    insertKeys(a, 30, pose([1, { rz: 90 }]), null);
    expect(a.bones.get(1)!.get(30)).toEqual({ v: bone({ rz: 90 }), curve: [0, 0, 0.58, 1] });
  });
  it('フレームのキーを、すべてのチャンネル (か 1 つ) から消す・ずらす', () => {
    const a = sample();
    expect(deleteKeys(a, [30], { kind: 'morph', index: 1 })).toBe(1);
    expect(keyFrames(a)).toEqual([0, 30]);
    expect(moveKeys(a, [30], 5)).toEqual([35]);
    expect([...a.bones.get(1)!.keys()]).toEqual([0, 35]);
    expect(deleteKeys(a, [0, 35])).toBe(3);
    expect(a.bones.size + a.morphs.size).toBe(0);
  });
  it('あとから作ったチャンネルは、最初のキーのフレームの 0 からつなぐ', () => {
    const a = createAnimation();
    insertKeys(a, 0, pose([1, { rz: 0 }]), [0, 0]);
    insertKeys(a, 30, pose([1, { rz: 0 }], [2, { rx: 60 }]), [1, 0]);
    expect(evaluate(a, 15).pose.get(2)!.rx).toBeCloseTo(30);
    expect(evaluate(a, 15).morphs.get(0)).toBeCloseTo(0.5);
    expect([...a.bones.get(2)!.keys()]).toEqual([0, 30]);
  });
  it('JSON にして戻すと同じ', () => {
    const a = sample([0.1, 0.2, 0.3, 0.4]);
    expect(animationFromJson(JSON.parse(JSON.stringify(animationToJson(a))))).toEqual(a);
  });
  it('前の形 (フレームごとのポーズ全体) から変換すると、同じ動きになる (片方にしかないボーンは 0 とみなす)', () => {
    const a = animationFromPoseKeys([
      [0, { pose: [], morphs: [0, 1] }],
      [10, { pose: [[2, bone({ rx: 40 })]], morphs: [0, 0] }],
    ]);
    expect(evaluate(a, 5).pose.get(2)!.rx).toBeCloseTo(20);
    expect(evaluate(a, 5).morphs.get(1)).toBeCloseTo(0.5);
    expect(a.morphs.has(0)).toBe(false);
  });
});

describe('キーのコピー・貼り付け', () => {
  it('選んだフレームのキーを、いちばん前からの差で写し、ほかのフレームへ貼る (写しは元と別。重なったキーは上書き)', () => {
    const a = createAnimation();
    insertPropKeys(a, 10, [[0, 1], [1, 2], [2, 0], [3, 1]]);
    insertPropKeys(a, 14, [[0, 3], [1, 4], [2, 0], [3, 1]]);
    insertPropKeys(a, 30, [[0, 9], [1, 9], [2, 9], [3, 9]]);
    const clip = copyKeys(a, [10, 14]);
    expect(clip.map(c => [c.kind, c.index, c.keys.map(k => k[0])])).toEqual([['prop', 0, [0, 4]], ['prop', 1, [0, 4]], ['prop', 2, [0, 4]], ['prop', 3, [0, 4]]]);
    expect(pasteKeys(a, clip, 30)).toEqual([30, 34]);
    expect(keyFrames(a)).toEqual([10, 14, 30, 34]);
    expect(a.props.get(0)!.get(30)!.v).toBe(1); // (上書き)
    a.props.get(0)!.get(30)!.v = 5;
    expect(a.props.get(0)!.get(10)!.v).toBe(1); // (元は変わらない)
  });
});

describe('MME のチャンネル (名前の一覧の番号ごと)', () => {
  // 0 フレームで チャンネル 0 (Si) = 1、30 フレームで 3。チャンネル 1 は 10 フレームだけ
  function mme(): Animation {
    const a = createAnimation();
    insertMmeKeys(a, 0, [[0, 1]]);
    insertMmeKeys(a, 30, [[0, 3]]);
    insertMmeKeys(a, 10, [[1, 0.5]]);
    return a;
  }
  it('あいだは補間曲線にそって線形補間し、キーのフレームにも数える', () => {
    const a = mme();
    expect(isEmpty(a)).toBe(false);
    expect(evaluate(a, 15).mme.get(0)).toBeCloseTo(2);
    expect(evaluate(a, 15).mme.get(1)).toBe(0.5);
    expect(keyFrames(a)).toEqual([0, 10, 30]);
  });
  it('打ち直すと値だけ替わり、補間曲線はそのまま', () => {
    const a = mme();
    a.mme.get(0)!.get(30)!.curve = [0.42, 0, 0.58, 1];
    insertMmeKeys(a, 30, [[0, 5]]);
    expect(a.mme.get(0)!.get(30)).toEqual({ v: 5, curve: [0.42, 0, 0.58, 1] });
  });
  it('消す・ずらす・写す・貼るは、MME のキーも動かす', () => {
    const a = mme();
    expect(deleteKeys(a, [10], { kind: 'mme', index: 1 })).toBe(1);
    expect(a.mme.has(1)).toBe(false);
    expect(moveKeys(a, [30], 5)).toEqual([35]);
    expect([...a.mme.get(0)!.keys()]).toEqual([0, 35]);
    const clip = copyKeys(a, [0, 35]);
    expect(clip.map(c => [c.kind, c.index, c.keys.map(k => k[0])])).toEqual([['mme', 0, [0, 35]]]);
    expect(pasteKeys(a, clip, 100)).toEqual([100, 135]);
    expect(evaluate(a, 135).mme.get(0)).toBe(3);
    expect(deleteKeys(a, [0, 35, 100, 135])).toBe(4);
    expect(isEmpty(a)).toBe(true);
  });
  it('JSON にして戻すと同じ。MME のキーのない古い JSON も読め、MME のキーがなければ JSON にも入れない', () => {
    const a = mme();
    expect(animationFromJson(JSON.parse(JSON.stringify(animationToJson(a))))).toEqual(a);
    const old = animationFromJson({ bones: [], morphs: [[0, [[0, 1, [...LINEAR] as Curve]]]] });
    expect(old.mme.size).toBe(0);
    expect(evaluate(old, 0).mme.size).toBe(0);
    expect('mme' in animationToJson(old)).toBe(false);
  });
});
