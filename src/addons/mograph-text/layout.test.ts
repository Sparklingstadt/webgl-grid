import { describe, expect, it } from 'vitest';
import { layoutText, unitsOf } from './layout';

const opts = { size: 1, spacing: 0, lineSpacing: 1.5, align: 'center' as const, advance: (ch: string) => (ch === ' ' ? 0.25 : 0.5) };

describe('MoText の並べ方', () => {
  it('1 行: 真ん中に並べ、空白は文字にしない', () => {
    const l = layoutText('AB C', opts);
    expect(l.chars.map(c => [c.ch, c.x])).toEqual([['A', -0.875], ['B', -0.375], ['C', 0.375]]);
    expect(l.width).toBe(1.75);
  });
  it('2 行: 下の行のベースラインが床から少し上、上の行は行間ぶん上。揃え', () => {
    const l = layoutText('AB\nC', { ...opts, align: 'left' });
    expect(l.chars.map(c => [c.ch, c.x, +c.y.toFixed(2), c.line])).toEqual([['A', -0.5, 1.72, 0], ['B', 0, 1.72, 0], ['C', -0.5, 0.22, 1]]);
    expect(layoutText('AB\nC', { ...opts, align: 'right' }).chars[2].x).toBe(0);
  });
  it('字間・大きさ', () => {
    const l = layoutText('AB', { ...opts, size: 2, spacing: 0.1 });
    expect(l.width).toBeCloseTo(2.2);
    expect(l.chars[1].x - l.chars[0].x).toBeCloseTo(1.2);
  });
  it('単位: 文字・単語・行・全体', () => {
    const l = layoutText('ab cd\nef', opts);
    expect(unitsOf(l, 'letters')).toHaveLength(6);
    expect(unitsOf(l, 'words')).toEqual([[0, 1], [2, 3], [4, 5]]);
    expect(unitsOf(l, 'lines')).toEqual([[0, 1, 2, 3], [4, 5]]);
    expect(unitsOf(l, 'all')).toEqual([[0, 1, 2, 3, 4, 5]]);
  });
});
