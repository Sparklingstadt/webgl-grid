import { describe, expect, it } from 'vitest';
import { bool, hex, int, num, oneOf, vec3 } from './normalize';
import { seededRandom } from './random';

describe('値をそろえる', () => {
  it('数・整数・真偽・色・一覧のどれか・3 つの数', () => {
    expect([num(2, 0), num('2', 7), num(NaN, 7), num(Infinity, 7), num(-5, 0, 0, 1), num(5, 0, 0, 1)]).toEqual([2, 7, 7, 7, 0, 1]);
    expect([int(2.6, 0, 0, 10), int(99, 0, 0, 10), int(null, 3, 0, 10)]).toEqual([3, 10, 3]);
    expect([bool(false, true), bool('yes', true)]).toEqual([false, true]);
    expect([hex('#AABBCC', '#000000'), hex('aabbcc', '#000000'), hex('red', '#000000')]).toEqual(['#aabbcc', '#aabbcc', '#000000']);
    const list = [{ key: 'a' }, { key: 'b' }] as const;
    expect([oneOf('b', list, 'a'), oneOf('z', list, 'a')]).toEqual(['b', 'a']);
    expect([vec3([1, 'x', 3], [0, 0, 0]), vec3(5, [1, 2, 3])]).toEqual([[1, 0, 3], [1, 2, 3]]);
  });
});

describe('同じシードなら同じ並びの乱数', () => {
  it('0 以上 1 未満で、シードが同じなら同じ、違えば違う', () => {
    const a = seededRandom(7), b = seededRandom(7), c = seededRandom(8);
    const xs = Array.from({ length: 50 }, a);
    expect(xs.every(x => x >= 0 && x < 1)).toBe(true);
    expect(Array.from({ length: 50 }, b)).toEqual(xs);
    expect(Array.from({ length: 50 }, c)).not.toEqual(xs);
  });
});
