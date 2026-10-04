import { describe, expect, it } from 'vitest';
import { Diagnostics, FxError, type Loc } from './diagnostics.ts';

const loc: Loc = { file: 'a.fx', line: 1, column: 1 };

describe('診断', () => {
  it('誤りと警告を分けて積む', () => {
    const d = new Diagnostics();
    d.error('FX-PARSE', loc, 'e');
    d.warn('FX-WARN-STATE', loc, 'w');
    expect(d.errors.map(e => [e.severity, e.code, e.message])).toEqual([['error', 'FX-PARSE', 'e']]);
    expect(d.warnings.map(e => [e.severity, e.code])).toEqual([['warning', 'FX-WARN-STATE']]);
    expect(d.errors[0].file).toBe('a.fx');
  });
  it('fatal は積んでから FxError を投げる', () => {
    const d = new Diagnostics();
    expect(() => d.fatal('FX-INTERNAL', loc, 'x')).toThrow(FxError);
    expect(d.errors.map(e => e.code)).toEqual(['FX-INTERNAL']);
  });
  it('20 個を超える誤りで FX-TYPE-TOO-MANY を足して止める', () => {
    const d = new Diagnostics();
    for (let i = 0; i < 20; i++) d.error('FX-TYPE-MISMATCH', { ...loc, column: i + 1 }, 'x');
    expect(() => d.error('FX-TYPE-MISMATCH', { ...loc, column: 21 }, 'x')).toThrow(FxError);
    expect(d.errors.map(e => e.code).at(-1)).toBe('FX-TYPE-TOO-MANY');
  });
  it('同じ誤り・警告は 1 回だけ積み、上限にも数えない', () => {
    const d = new Diagnostics();
    for (let i = 0; i < 30; i++) d.error('FX-UNSUPPORTED', loc, 'x');
    d.warn('FX-WARN-STATE', loc, 'w');
    d.warn('FX-WARN-STATE', loc, 'w');
    expect(d.errors.map(e => e.code)).toEqual(['FX-UNSUPPORTED']);
    expect(d.warnings).toHaveLength(1);
    // 文・code・場所のどれかが違えば別のもの
    d.error('FX-UNSUPPORTED', loc, 'y');
    d.error('FX-PARSE', loc, 'x');
    d.error('FX-UNSUPPORTED', { ...loc, line: 2 }, 'x');
    d.error('FX-UNSUPPORTED', { ...loc, column: 2 }, 'x');
    d.error('FX-UNSUPPORTED', { ...loc, file: 'b.fx' }, 'x');
    expect(d.errors).toHaveLength(6);
  });
});
