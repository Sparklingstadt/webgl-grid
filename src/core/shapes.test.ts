import { describe, expect, it } from 'vitest';
import { MODEL_KIND, SHAPES, findShape, shapeDef, shapeName } from './shapes';

describe('置ける形', () => {
  it('番号は重ならず、MMD モデルの番号 (3) は使わない', () => {
    const ss = SHAPES.map(d => d.s);
    expect(new Set(ss).size).toBe(ss.length);
    expect(ss).not.toContain(MODEL_KIND);
    expect(ss).toEqual(expect.arrayContaining([0, 1, 2])); // 前からある形の番号はそのまま (保存したプロジェクトのため)
  });
  it('名前・キー・番号から探す', () => {
    expect(findShape('sphere')).toBe(4);
    expect(findShape('円柱')).toBe(5);
    expect(findShape(2)).toBe(2);
    expect(findShape(3)).toBeNull();
    expect(findShape('dodecahedron')).toBeNull();
    expect(shapeName(3)).toBe('MMD モデル');
    expect(shapeDef(99).key).toBe('cube');
  });
});
