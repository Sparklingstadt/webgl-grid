import { describe, expect, it } from 'vitest';
import { Diagnostics, FxError } from './diagnostics.ts';
import { lex, numberValue } from './lexer.ts';

const texts = (s: string) => lex(s, 'f.fx', new Diagnostics()).map(x => x.text);

describe('字句解析', () => {
  it('行と列を数え、行末の \\ でつないだ行も 1 行として読む', () => {
    const t = lex('float a;\n#define X \\\n 1\n  b', 'f.fx', new Diagnostics());
    expect(t.map(x => x.text)).toEqual(['float', 'a', ';', '#', 'define', 'X', '1', 'b', '']);
    expect(t[3]).toMatchObject({ lineStart: true, loc: { line: 2, column: 1 } });
    expect(t[7].loc).toMatchObject({ line: 4, column: 3 });
  });
  it('lineStart は論理行の最初の字句だけ。つないだ行の続きは違う', () => {
    const t = lex('a b\n#define X \\\n 1\nc', 'f.fx', new Diagnostics());
    expect(t.map(x => x.lineStart)).toEqual([true, false, true, false, false, false, true, true]);
  });
  it('字句の種類とファイル名', () => {
    const t = lex('x 1 "s" +', 'g.fx', new Diagnostics());
    expect(t.map(x => x.kind)).toEqual(['ident', 'number', 'string', 'punct', 'eof']);
    expect(t[0].loc.file).toBe('g.fx');
  });
  it('spaceBefore は空白やコメントが直前にあるか', () => {
    const t = lex('a(b) c/**/d', 'f', new Diagnostics());
    expect(t.map(x => x.spaceBefore)).toEqual([false, false, false, false, true, true, false]);
  });
  it('コメントは捨てる。ブロックコメントの中の改行では行頭にならない', () => {
    expect(texts('a // b\nc /* d\n e */ f')).toEqual(['a', 'c', 'f', '']);
    const t = lex('a /* x\n y */ #', 'f', new Diagnostics());
    expect(t[1]).toMatchObject({ text: '#', lineStart: false, loc: { line: 2, column: 7 } });
    expect(texts('a // b \\\n c\nd')).toEqual(['a', 'd', '']);
  });
  it('数の書き方', () => {
    const v = (s: string) => numberValue(lex(s, 'f', new Diagnostics())[0]);
    expect(v('1.0f')).toEqual({ value: 1, isFloat: true }); expect(v('.5')).toEqual({ value: 0.5, isFloat: true });
    expect(v('1e-5')).toEqual({ value: 1e-5, isFloat: true }); expect(v('0x1F')).toEqual({ value: 31, isFloat: false });
    expect(v('2h')).toEqual({ value: 2, isFloat: true }); expect(v('10u')).toEqual({ value: 10, isFloat: false });
    expect(v('1.')).toEqual({ value: 1, isFloat: true }); expect(v('3')).toEqual({ value: 3, isFloat: false });
    expect(v('1E+2F')).toEqual({ value: 100, isFloat: true });
  });
  it('数の字句は後ろの文字を取りすぎない', () => {
    expect(texts('1.0f+2')).toEqual(['1.0f', '+', '2', '']);
    expect(texts('v.x')).toEqual(['v', '.', 'x', '']);
    expect(texts('a[0].y')).toEqual(['a', '[', '0', ']', '.', 'y', '']);
  });
  it('2 文字以上の記号と文字列', () => {
    expect(lex('a<<=b##c "x\\"y"', 'f', new Diagnostics()).map(x => x.text)).toEqual(['a', '<<=', 'b', '##', 'c', '"x\\"y"', '']);
  });
  it('記号は長い順に読む', () => {
    expect(texts('>>= ... -> ++ -- && || == != <= >= += -= *= /= %= &= |= ^= << >> # ? :')).toEqual(
      ['>>=', '...', '->', '++', '--', '&&', '||', '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '#', '?', ':', '']);
    expect(texts('a+++b')).toEqual(['a', '++', '+', 'b', '']);
  });
  it('最後は eof で、空の入力でも eof だけ返る', () => {
    const t = lex('', 'f', new Diagnostics());
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ kind: 'eof', text: '', loc: { line: 1, column: 1 } });
  });
  it('閉じていないコメント・文字列は FX-LEX-UNTERMINATED、知らない文字は FX-LEX-CHAR', () => {
    const code = (s: string) => {
      const d = new Diagnostics();
      expect(() => lex(s, 'f', d)).toThrow(FxError);
      return d.errors.map(e => e.code);
    };
    expect(code('a /* b')).toEqual(['FX-LEX-UNTERMINATED']);
    expect(code('a "b')).toEqual(['FX-LEX-UNTERMINATED']);
    expect(code('a "b\nc"')).toEqual(['FX-LEX-UNTERMINATED']);
    expect(code('a @ b')).toEqual(['FX-LEX-CHAR']);
    expect(code('a \\ b')).toEqual(['FX-LEX-CHAR']);
  });
  it('誤りの場所は問題の文字の位置', () => {
    const d = new Diagnostics();
    expect(() => lex('a\n  @', 'f.fx', d)).toThrow(FxError);
    expect(d.errors[0]).toMatchObject({ file: 'f.fx', line: 2, column: 3 });
  });
});
