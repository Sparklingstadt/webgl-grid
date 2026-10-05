import { describe, expect, it } from 'vitest';
import { Diagnostics, FxError } from './diagnostics.ts';
import { preprocess } from './preprocess.ts';
import type { FileAccess } from './source.ts';
import type { Token } from './lexer.ts';

const files = (record: Record<string, string>): FileAccess => ({
  readFile: p => (p in record ? new TextEncoder().encode(record[p]) : null),
  listFiles: () => Object.keys(record),
});
const texts = (t: Token[]) => t.filter(x => x.kind !== 'eof').map(x => x.text);
const run = (src: string, defines?: Record<string, string>, diags = new Diagnostics()) =>
  preprocess('main.fx', files({ 'main.fx': src }), { defines }, diags);
const codes = (d: Diagnostics) => [...d.errors, ...d.warnings].map(x => x.code);

describe('前処理: include', () => {
  it('#include を、include したファイルのフォルダ → エントリーのフォルダの順に、大文字小文字を無視して探す', () => {
    const fs = files({ 'fx/main.fx': '#include "..\\Shader\\common.FXSUB"\nB', 'shader/Common.fxsub': 'A' });
    const t = preprocess('fx/main.fx', fs, {}, new Diagnostics());
    expect(texts(t)).toEqual(['A', 'B']);
    expect(t[0].loc).toMatchObject({ file: 'shader/Common.fxsub', line: 1, includedFrom: [{ file: 'fx/main.fx', line: 1 }] });
    expect(t[1].loc.includedFrom).toBeUndefined();
  });
  it('include したファイルのフォルダになければ、エントリーのフォルダから探す', () => {
    const fs = files({ 'main.fx': '#include "sub/a.fxsub"\nZ', 'sub/a.fxsub': '#include "b.fxsub"', 'b.fxsub': 'B' });
    expect(texts(preprocess('main.fx', fs, {}, new Diagnostics()))).toEqual(['B', 'Z']);
  });
  it('includedFrom は外側 (エントリー) から順に、include した場所を並べる', () => {
    const fs = files({ 'main.fx': '\n#include "a.fx"', 'a.fx': 'x\n#include "b.fx"', 'b.fx': 'y' });
    const t = preprocess('main.fx', fs, {}, new Diagnostics());
    expect(t[1].loc).toMatchObject({
      file: 'b.fx', line: 1,
      includedFrom: [{ file: 'main.fx', line: 2 }, { file: 'a.fx', line: 2 }],
    });
    expect(t[0].loc.includedFrom).toEqual([{ file: 'main.fx', line: 2 }]);
  });
  it('#include <x> も "x" と同じに探す', () => {
    const fs = files({ 'main.fx': '#include <inc/a.h>\nB', 'inc/a.h': 'A' });
    expect(texts(preprocess('main.fx', fs, {}, new Diagnostics()))).toEqual(['A', 'B']);
  });
  it('偽の #if の中の #include は読まない', () => expect(texts(run('#if 0\n#include "nope.fx"\n#endif\nx'))).toEqual(['x']));
  it('include の中の #define は、あとのファイルでも使える', () => {
    const fs = files({ 'main.fx': '#include "d.fxsub"\nV', 'd.fxsub': '#define V 7' });
    expect(texts(preprocess('main.fx', fs, {}, new Diagnostics()))).toEqual(['7']);
  });
  it('見つからない include は FX-PP-INCLUDE-NOT-FOUND (続けて読む)', () => {
    const d = new Diagnostics();
    expect(texts(run('#include "nope.fx"\nx', undefined, d))).toEqual(['x']);
    expect(d.errors).toMatchObject([{ code: 'FX-PP-INCLUDE-NOT-FOUND', file: 'main.fx', line: 1 }]);
  });
  it('include の深さは 64 まで。65 で FX-PP-INCLUDE-DEPTH', () => {
    const chain = (n: number) => {
      const rec: Record<string, string> = { 'f0.fx': '#include "f1.fx"' };
      for (let i = 1; i < n; i++) rec[`f${i}.fx`] = `#include "f${i + 1}.fx"`;
      rec[`f${n}.fx`] = 'end';
      return files(rec);
    };
    const ok = new Diagnostics();
    expect(texts(preprocess('f0.fx', chain(64), {}, ok))).toEqual(['end']);
    expect(ok.errors).toEqual([]);
    const over = new Diagnostics();
    preprocess('f0.fx', chain(65), {}, over);
    expect(codes(over)).toEqual(['FX-PP-INCLUDE-DEPTH']);
    const self = new Diagnostics();
    preprocess('s.fx', files({ 's.fx': '#include "s.fx"' }), {}, self);
    expect(codes(self)).toEqual(['FX-PP-INCLUDE-DEPTH']);
  });
  it('エントリーがなければ FX-IO-NOT-FOUND', () => {
    const d = new Diagnostics();
    expect(() => preprocess('none.fx', files({}), {}, d)).toThrow(FxError);
    expect(codes(d)).toEqual(['FX-IO-NOT-FOUND']);
  });
});

describe('前処理: マクロ', () => {
  it('引数付きマクロ・# と ##・自分自身は展開しない', () => {
    const src = '#define CAT(a,b) a##b\n#define STR(x) #x\n#define SELF SELF+1\nCAT(fo,o) STR(z) SELF';
    expect(texts(run(src))).toEqual(['foo', '"z"', 'SELF', '+', '1']);
  });
  it('引数付きマクロの名前だけ (括弧なし) は展開しない', () => {
    expect(texts(run('#define min3(a,b,c) min(a,min(b,c))\nfloat min3;'))).toEqual(['float', 'min3', ';']);
  });
  it('名前と ( の間の空白や改行は許す。引数は複数行にまたがってよい', () => {
    expect(texts(run('#define ADD(a,b) a+b\nADD\n(1,\n 2)'))).toEqual(['1', '+', '2']);
  });
  it('引数の中の括弧のカンマでは分けない。引数は先に展開される', () => {
    const src = '#define ID(x) x\n#define TWO(a,b) a b\n#define N 5\nTWO(ID((1,2)), N)';
    expect(texts(run(src))).toEqual(['(', '1', ',', '2', ')', '5']);
  });
  it('展開した結果のあとの ( を使って、続けて展開する', () => {
    const src = '#define F(x) [x]\n#define G F\nG(1)';
    expect(texts(run(src))).toEqual(['[', '1', ']']);
  });
  it('相互に参照するマクロも止まる', () => {
    expect(texts(run('#define A B\n#define B A\nA'))).toEqual(['A']);
  });
  it('# は引数の文字列の " と \\ を逃がし、空白は詰める', () => {
    expect(texts(run('#define S(x) #x\nS( a   +  "q\\n" )'))).toEqual(['"a + \\"q\\\\n\\""']);
  });
  it('## は引数の左右にも使え、つないだ結果は字句になる', () => {
    const src = '#define V(n) v_##n##_x\n#define CAT(a,b) a##b\nV(1) CAT(1,2) CAT(a,) CAT(,b)';
    expect(texts(run(src))).toEqual(['v_1_x', '12', 'a', 'b']);
  });
  it('つなげない ## は FX-PP-DIRECTIVE', () => {
    const d = new Diagnostics();
    run('#define CAT(a,b) a##b\nCAT(+,1)', undefined, d);
    expect(codes(d)).toEqual(['FX-PP-DIRECTIVE']);
  });
  it('マクロから出た字句の loc は使った場所 (include の連なりも)', () => {
    const fs = files({ 'main.fx': '#include "h.fx"\nQ', 'h.fx': '#define Q a b\n  x Q' });
    const t = preprocess('main.fx', fs, {}, new Diagnostics());
    expect(texts(t)).toEqual(['x', 'a', 'b', 'a', 'b']);
    expect(t[1].loc).toMatchObject({ file: 'h.fx', line: 2, column: 5, includedFrom: [{ file: 'main.fx', line: 1 }] });
    expect(t[2].loc).toMatchObject({ file: 'h.fx', line: 2, column: 5 });
    expect(t[3].loc).toMatchObject({ file: 'main.fx', line: 2, column: 1 });
    expect(t[3].loc.includedFrom).toBeUndefined();
  });
  it('#undef で消せる', () => expect(texts(run('#define A 1\n#undef A\nA'))).toEqual(['A']));
  it('引数の数が違えば FX-PP-MACRO-ARGS', () => {
    for (const call of ['F(1)', 'F(1,2,3)', 'F()', 'G(1)', 'F(1,2']) {
      const d = new Diagnostics();
      run(`#define F(a,b) a\n#define G() 0\n${call}`, undefined, d);
      expect(codes(d)).toEqual(['FX-PP-MACRO-ARGS']);
    }
  });
  it('引数なしのマクロの呼び出し G() は展開する', () => expect(texts(run('#define G() 0\nG()'))).toEqual(['0']));
  it('options.defines は最初から定義される', () => {
    const d = new Diagnostics();
    expect(texts(run('A B', { A: '1 + 2', B: '' }, d))).toEqual(['1', '+', '2']);
    expect(d.warnings).toEqual([]);
  });
  it('ファイルの #define で違う値にすると FX-WARN-REDEFINE-MACRO (新しい値になる)', () => {
    const d = new Diagnostics();
    expect(texts(run('#define A 2\nA', { A: '1' }, d))).toEqual(['2']);
    expect(d.warnings).toMatchObject([{ code: 'FX-WARN-REDEFINE-MACRO', file: 'main.fx', line: 1 }]);
    expect(d.errors).toEqual([]);
  });
  it('同じ内容の #define し直しは警告しない', () => {
    const d = new Diagnostics();
    run('#define A 1\n#define A 1\n#define F(x) x\n#define F(x) x', {}, d);
    run('#define B 1', { B: '1' }, d);
    expect(codes(d)).toEqual([]);
  });
  it('違う内容の #define し直し (引数・本文) は警告する', () => {
    const d = new Diagnostics();
    run('#define F(x) x\n#define F(y) y\n#define A 1\n#define A 1 2', undefined, d);
    expect(codes(d)).toEqual(['FX-WARN-REDEFINE-MACRO', 'FX-WARN-REDEFINE-MACRO']);
  });
  it('#define の本文は行末の \\ でつなげる', () => expect(texts(run('#define A 1 \\\n + 2\nA'))).toEqual(['1', '+', '2']));
});

describe('前処理: 条件', () => {
  it('#if・#elif・defined・知らない名前は 0', () => {
    expect(texts(run('#define Q 2\n#if Q == 1\na\n#elif defined(Q) && !NOPE\nb\n#else\nc\n#endif'))).toEqual(['b']);
  });
  it('#ifdef・#ifndef・#else', () => {
    expect(texts(run('#define A\n#ifdef A\n1\n#else\n2\n#endif\n#ifndef A\n3\n#else\n4\n#endif'))).toEqual(['1', '4']);
  });
  it('入れ子の偽の中の #else・#elif は読まない。取った枝のあとの #elif は評価しない', () => {
    const src = '#if 0\n#if 1\na\n#else\nb\n#endif\n#elif 1\nc\n#elif 1/0\nd\n#else\ne\n#endif';
    const d = new Diagnostics();
    expect(texts(run(src, undefined, d))).toEqual(['c']);
    expect(d.errors).toEqual([]);
  });
  it('defined X (括弧なし) と、マクロを展開したあとの値', () => {
    expect(texts(run('#define V (1+2)\n#define W V*2\n#if defined V && W == 6\nyes\n#endif'))).toEqual(['yes']);
  });
  it('引数付きマクロも #if の中で使える', () => {
    expect(texts(run('#define LT(a,b) ((a)<(b))\n#if LT(1,2)\nyes\n#endif'))).toEqual(['yes']);
  });
  it('演算子と優先順位', () => {
    const cases: [string, number][] = [
      ['1 + 2 * 3', 7], ['(1 + 2) * 3', 9], ['7 / 2', 3], ['-7 % 4', -3], ['1 << 4 >> 2', 4], ['5 & 3 | 8 ^ 1', 9],
      ['~0', -1], ['!5', 0], ['3 > 2 && 2 >= 2', 1], ['1 < 1 || 2 <= 1', 0], ['1 != 2', 1], ['0x10', 16],
      ['1 ? 2 : 3', 2], ['0 ? 2 : 1 ? 4 : 5', 4], ['0 && (1/0)', 0], ['1 || (1/0)', 1], ['+3 - -2', 5],
    ];
    for (const [expr, want] of cases) {
      expect(texts(run(`#if (${expr}) == ${want}\nok\n#endif`)), expr).toEqual(['ok']);
    }
  });
  it('壊れた #if の式は FX-PP-DIRECTIVE (偽として続ける)', () => {
    for (const expr of ['', '1 +', '(1', '1 2', '1/0', '1 ? 2']) {
      const d = new Diagnostics();
      expect(texts(run(`#if ${expr}\nx\n#endif\ny`, undefined, d))).toEqual(['y']);
      expect(codes(d), expr).toEqual(['FX-PP-DIRECTIVE']);
    }
  });
  it('閉じていない #if は FX-PP-UNTERMINATED-IF (#if の場所)。include をまたがない', () => {
    const d = new Diagnostics();
    run('\n#if 1\nx', undefined, d);
    expect(d.errors).toMatchObject([{ code: 'FX-PP-UNTERMINATED-IF', line: 2 }]);
    const d2 = new Diagnostics();
    preprocess('main.fx', files({ 'main.fx': '#include "a.fx"\n#endif', 'a.fx': '#if 1' }), {}, d2);
    expect(codes(d2)).toEqual(['FX-PP-UNTERMINATED-IF', 'FX-PP-DIRECTIVE']);
  });
  it('対応のない #endif・#else・#elif、#else のあとの #else は FX-PP-DIRECTIVE', () => {
    for (const src of ['#endif', '#else', '#elif 1', '#if 1\n#else\n#else\n#endif', '#if 1\n#else\n#elif 1\n#endif']) {
      const d = new Diagnostics();
      run(src, undefined, d);
      expect(codes(d), src).toEqual(['FX-PP-DIRECTIVE']);
    }
  });
  it('#error は FX-PP-ERROR。偽の中では出ない', () => {
    const d = new Diagnostics();
    run('#error  no good\n#if 0\n#error hidden\n#endif', undefined, d);
    expect(d.errors).toMatchObject([{ code: 'FX-PP-ERROR', line: 1 }]);
    expect(d.errors[0].message).toContain('no good');
  });
  it('#pragma・#line・空の # は読み飛ばし、知らない指令は FX-PP-DIRECTIVE (偽の中では読み飛ばす)', () => {
    const d = new Diagnostics();
    expect(texts(run('#pragma once\n#line 5\n#\nx\n#if 0\n#bogus\n#endif', undefined, d))).toEqual(['x']);
    expect(d.errors).toEqual([]);
    run('#bogus', undefined, d);
    expect(codes(d)).toEqual(['FX-PP-DIRECTIVE']);
  });
  it('#define の書き方が違えば FX-PP-DIRECTIVE', () => {
    for (const src of ['#define', '#define 1', '#define F(a,) a', '#define F(a', '#ifdef', '#undef', '#include', '#include x']) {
      const d = new Diagnostics();
      run(src.startsWith('#ifdef') ? `${src}\n#endif` : src, undefined, d);
      expect(codes(d), src).toEqual(['FX-PP-DIRECTIVE']);
    }
  });
});

describe('前処理: 字句の列', () => {
  it('Ray-MMD のように、注釈の文字列の途中に #if を挟める', () => {
    const src = 'string Script = "Pass=A;"\n#if USE_B\n "Pass=B;"\n#endif\n "Pass=C;";';
    expect(texts(run(src))).toEqual(['string', 'Script', '=', '"Pass=A;"', '"Pass=C;"', ';']);
    expect(texts(run(src, { USE_B: '1' }))).toEqual(['string', 'Script', '=', '"Pass=A;"', '"Pass=B;"', '"Pass=C;"', ';']);
  });
  it('最後は eof の字句 1 つ', () => {
    const t = run('a');
    expect(t.map(x => x.kind)).toEqual(['ident', 'eof']);
    expect(run('').map(x => x.kind)).toEqual(['eof']);
  });
  it('Shift-JIS のファイルも読める', () => {
    const fs: FileAccess = { readFile: p => (p === 'main.fx' ? new Uint8Array([0x2f, 0x2f, 0x93, 0xfa, 0x0a, 0x78]) : null) };
    expect(texts(preprocess('main.fx', fs, {}, new Diagnostics()))).toEqual(['x']);
  });
});
