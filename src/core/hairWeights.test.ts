import { describe, expect, it } from 'vitest';
import { findHairWeights, type RigBody, type RigJoint } from './hairWeights';

// げのげ式初音ミクの組み方をまねた剛体と関節:
// 頭 (ボーン 1) → 髪 1 → 髪 2 の鎖に、それぞれ錘を固定でつなぎ、錘どうしは補助の関節 (動く) でつなぐ。
// 上半身 (ボーン 0) → 胸 に錘を固定でつなぎ、胸の錘と髪の錘も補助の関節でつながっている
const HEAD = 1, BODY = 0;
const bodies: RigBody[] = [
  { type: 0, groupTarget: 0xffff, boneIndex: HEAD }, // 0: 頭
  { type: 1, groupTarget: 0xffb7, boneIndex: 2 },    // 1: 髪 1
  { type: 1, groupTarget: 0xffb7, boneIndex: 3 },    // 2: 髪 2
  { type: 1, groupTarget: 0, boneIndex: 4 },         // 3: 髪 1 の錘
  { type: 1, groupTarget: 0, boneIndex: 5 },         // 4: 髪 2 の錘
  { type: 0, groupTarget: 0xffff, boneIndex: BODY }, // 5: 上半身
  { type: 1, groupTarget: 0xff3e, boneIndex: 6 },    // 6: 胸
  { type: 1, groupTarget: 0, boneIndex: 7 },         // 7: 胸の錘
];
const joints: RigJoint[] = [
  { a: 0, b: 1, locked: false },
  { a: 1, b: 2, locked: false },
  { a: 1, b: 3, locked: true },
  { a: 2, b: 4, locked: true },
  { a: 3, b: 4, locked: false }, // 補助
  { a: 5, b: 6, locked: false },
  { a: 6, b: 7, locked: true },
  { a: 4, b: 7, locked: false }, // 補助 (髪の錘と胸の錘)
];
const isHead = (i: number) => i === HEAD;

describe('findHairWeights', () => {
  it('頭からぶら下がる髪の錘だけを見つけ、胸の錘は含めない', () => {
    expect(findHairWeights(bodies, joints, isHead)).toEqual([3, 4]);
  });

  it('頭に付いた剛体がなければ、何も見つけない', () => {
    expect(findHairWeights(bodies, joints, () => false)).toEqual([]);
  });

  it('固定でない関節で付いている、ぶつからない剛体は錘ではない', () => {
    const loose = joints.map(j => ({ ...j, locked: false }));
    expect(findHairWeights(bodies, loose, isHead)).toEqual([]);
  });

  it('何かとぶつかる剛体は、固定でつながっていても錘ではない', () => {
    const solid = bodies.map((b, i) => (i === 3 ? { ...b, groupTarget: 0x0001 } : b));
    expect(findHairWeights(solid, joints, isHead)).toEqual([4]);
  });
});
