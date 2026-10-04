import { describe, expect, it } from 'vitest';
import type { Expr, FileNode, FunctionDecl, GlobalDecl, Stmt, StructDecl } from './ast.ts';
import { Diagnostics, FxError } from './diagnostics.ts';
import { lex } from './lexer.ts';
import { parse } from './parser.ts';

const parseSrc = (s: string, d = new Diagnostics()): FileNode => parse(lex(s, 'f.fx', d), d);
// 本体の 1 つ目の文
const stmts = (body: string): Stmt[] => {
  const f = parseSrc(`void f() { ${body} }`).items[0] as FunctionDecl;
  return (f.body as { kind: 'block'; body: Stmt[] }).body;
};
const expr = (s: string): Expr => (stmts(`${s};`)[0] as { kind: 'expr'; expr: Expr }).expr;
// 式を、前置は (-x)・後置は (x++)・ほかは (左 演算子 右) の形で書き出す
function show(e: Expr): string {
  switch (e.kind) {
    case 'number': return String(e.value);
    case 'bool': return String(e.value);
    case 'string': return JSON.stringify(e.value);
    case 'ident': return e.name;
    case 'unary': return e.postfix ? `(${show(e.operand)}${e.op})` : `(${e.op}${show(e.operand)})`;
    case 'binary': return `(${show(e.left)} ${e.op} ${show(e.right)})`;
    case 'assign': return `(${show(e.target)} ${e.op} ${show(e.value)})`;
    case 'ternary': return `(${show(e.cond)} ? ${show(e.then)} : ${show(e.else)})`;
    case 'call': return `${e.callee}(${e.args.map(show).join(', ')})`;
    case 'construct': return `<construct>(${e.args.map(show).join(', ')})`;
    case 'cast': return `<cast>${show(e.value)}`;
    case 'member': return `(${show(e.object)}.${e.name})`;
    case 'index': return `(${show(e.object)}[${show(e.index)}])`;
    case 'initList': return `{${e.items.map(show).join(', ')}}`;
    case 'sequence': return `(${e.items.map(show).join(', ')})`;
    default: return `<${e.kind}>`;
  }
}
// 誤りで投げたとき、積まれた最初の診断を返す
function failure(src: string) {
  const d = new Diagnostics();
  expect(() => parseSrc(src, d)).toThrow(FxError);
  return d.errors[0];
}

describe('構文解析: 関数', () => {
  it('関数・引数の修飾子とセマンティクス', () => {
    const f = parseSrc('float4 VS(in float4 p : POSITION, out float2 t : TEXCOORD0, uniform float2 o) : POSITION { t = o; return p; }').items[0] as FunctionDecl;
    expect(f).toMatchObject({
      name: 'VS', retSemantic: 'POSITION',
      params: [{ modifier: 'in', semantic: 'POSITION' }, { modifier: 'out' }, { modifier: 'uniform', semantic: null }],
    });
  });
  it('修飾子のない引数は in、in out は inout。ほかの修飾子と (void) は読み飛ばす', () => {
    const f = parseSrc('void g(float a, in out float b, const float c = 1) {} void h(void) {}').items;
    expect((f[0] as FunctionDecl).params.map(p => p.modifier)).toEqual(['in', 'inout', 'in']);
    expect((f[0] as FunctionDecl).params[2].init).toMatchObject({ kind: 'number', value: 1 });
    expect((f[1] as FunctionDecl).params).toEqual([]);
  });
  it('本体のないものはプロトタイプ', () => {
    const f = parseSrc('float f(float x);').items[0] as FunctionDecl;
    expect(f).toMatchObject({ kind: 'function', name: 'f', body: null });
  });
});

describe('構文解析: 式', () => {
  it('演算子の優先順位と結合', () => {
    expect(show(expr('a = b ? c : d + e * f'))).toBe('(a = (b ? c : (d + (e * f))))');
    expect(show(expr('a || b && c | d ^ e & f == g < h << i + j * k'))).toBe(
      '(a || (b && (c | (d ^ (e & (f == (g < (h << (i + (j * k))))))))))',
    );
    expect(show(expr('a - b - c'))).toBe('((a - b) - c)');
    expect(show(expr('a = b += c'))).toBe('(a = (b += c))');
    expect(show(expr('a ? b : c ? d : e'))).toBe('(a ? b : (c ? d : e))');
  });
  it('後置の ++ は x.y[2] に付き、前置のマイナスはその結果にかかる', () => {
    expect(show(expr('-x.y[2]++'))).toBe('(-(((x.y)[2])++))');
    expect(show(expr('++a.b'))).toBe('(++(a.b))');
    expect(show(expr('!f(a, b)[0]'))).toBe('(!(f(a, b)[0]))');
  });
  it('カンマは sequence になる。引数の中のカンマは区切り', () => {
    expect(expr('a = 1, b = 2')).toMatchObject({ kind: 'sequence', items: [{ kind: 'assign' }, { kind: 'assign' }] });
    expect(show(expr('f(a = 1, b)'))).toBe('f((a = 1), b)');
  });
  it('数・真偽・文字列・型の名前の構築・初期化リスト', () => {
    expect(expr('1.5f')).toMatchObject({ kind: 'number', value: 1.5, isFloat: true });
    expect(expr('3')).toMatchObject({ kind: 'number', value: 3, isFloat: false });
    expect(expr('true')).toMatchObject({ kind: 'bool', value: true });
    expect(expr('float4(a, 0, 0, 1).xyz')).toMatchObject({
      kind: 'member', name: 'xyz', object: { kind: 'construct', typeRef: { kind: 'builtin', type: { k: 'vector', s: 'float', n: 4 } }, args: [{}, {}, {}, {}] },
    });
    expect(expr('f(1).w._m01')).toMatchObject({ kind: 'member', name: '_m01', object: { kind: 'member', name: 'w' } });
  });
  it('隣り合う文字列は 1 つにつなぎ、\\ の書き方を読む', () => {
    const g = parseSrc('string s = "ab" "c\\\\d\\"e";').items[0] as GlobalDecl;
    expect(g.decl.init).toMatchObject({ kind: 'string', value: 'abc\\d"e' });
  });
  it('キャストと括弧の見分け (構造体と typedef の名前を覚える)', () => {
    const file = parseSrc('struct S { float a : TEXCOORD0; }; typedef float3 V; float f() { S s = (S)0; V v = (V)1; return (a)+b; }');
    const body = ((file.items[2] as FunctionDecl).body as { kind: 'block'; body: Stmt[] }).body;
    expect(body[0]).toMatchObject({ kind: 'var', decls: [{ name: 's', type: { kind: 'named', name: 'S' }, init: { kind: 'cast', typeRef: { kind: 'named', name: 'S' }, value: { kind: 'number' } } }] });
    expect(body[1]).toMatchObject({ kind: 'var', decls: [{ init: { kind: 'cast', typeRef: { kind: 'named', name: 'V' } } }] });
    expect(body[2]).toMatchObject({ kind: 'return', value: { kind: 'binary', op: '+', left: { kind: 'ident', name: 'a' } } });
  });
  it('組み込みの型へのキャストはキャストの対象が単項の式で、(a)-1 は引き算', () => {
    expect(show(expr('(float3)x.y + 1'))).toBe('(<cast>(x.y) + 1)');
    expect(expr('(int)-1')).toMatchObject({ kind: 'cast', value: { kind: 'unary', op: '-' } });
    expect(show(expr('(a)-1'))).toBe('(a - 1)');
    expect(expr('(vector<float, 3>)x')).toMatchObject({ kind: 'cast', typeRef: { kind: 'builtin', type: { k: 'vector', n: 3 } } });
  });
  it('字句の lineStart には頼らない', () => {
    const d = new Diagnostics();
    const tokens = lex('float f() { x = a ? (float2)b : c[1]++; }', 'f.fx', d);
    for (const tk of tokens) tk.lineStart = true;
    expect(parse(tokens, d)).toEqual(parseSrc('float f() { x = a ? (float2)b : c[1]++; }'));
  });
  it('論理演算以外の複合代入 (&= など) は FX-UNSUPPORTED', () => {
    expect(failure('void f() { a &= 1; }').code).toBe('FX-UNSUPPORTED');
  });
});

describe('構文解析: 型と宣言', () => {
  it('グローバル変数: 記憶域・配列・カンマで分けた宣言・register は読み飛ばす', () => {
    const items = parseSrc('static const float2 k[2] = { {1,2}, {3,4} }, j = 0; float4x4 W : WORLD register(c0);').items as GlobalDecl[];
    expect(items).toHaveLength(3);
    expect(items[0].decl).toMatchObject({
      name: 'k', storage: ['static', 'const'], semantic: null, annotations: [],
      type: { kind: 'builtin', type: { k: 'vector', s: 'float', n: 2 } },
      arrayDims: [{ kind: 'number', value: 2 }],
      init: { kind: 'initList', items: [{ kind: 'initList', items: [{}, {}] }, { kind: 'initList' }] },
    });
    expect(items[1].decl).toMatchObject({ name: 'j', storage: ['static', 'const'], arrayDims: [], init: { kind: 'number', value: 0 } });
    expect(items[2].decl).toMatchObject({ name: 'W', semantic: 'WORLD', init: null, type: { type: { k: 'matrix', rows: 4, cols: 4 } } });
  });
  it('register は : を付けた書き方も、長さのない配列も読める', () => {
    const items = parseSrc('float4 A : register(c1); float4 B : COLOR0 : register(c2); float C[];').items as GlobalDecl[];
    expect(items.map(i => i.decl.semantic)).toEqual([null, 'COLOR0', null]);
    expect(items[2].decl.arrayDims).toEqual([null]);
  });
  it('構造体: フィールドのカンマ・配列・セマンティクス', () => {
    const s = parseSrc('struct S { float4 p : POSITION; float a, b[2]; };').items[0] as StructDecl;
    expect(s).toMatchObject({ kind: 'struct', name: 'S' });
    expect(s.fields.map(f => [f.name, f.semantic, f.arrayDims.length])).toEqual([['p', 'POSITION', 0], ['a', null, 0], ['b', null, 1]]);
  });
  it('typedef は配列も取れる', () => {
    const td = parseSrc('typedef float2 P[2]; P x;').items;
    expect(td[0]).toMatchObject({ kind: 'typedef', name: 'P', arrayDims: [{ value: 2 }] });
    expect(td[1]).toMatchObject({ kind: 'global', decl: { type: { kind: 'named', name: 'P' } } });
  });
  it('vector<float, 3> と matrix<float, 4, 4>', () => {
    const items = parseSrc('vector<float, 3> v; matrix<half, 3, 2> m; vector<bool, 1> b; vector u; matrix w;').items as GlobalDecl[];
    expect(items.map(i => i.decl.type)).toMatchObject([
      { type: { k: 'vector', s: 'float', n: 3 } },
      { type: { k: 'matrix', s: 'float', rows: 3, cols: 2 } },
      { type: { k: 'scalar', s: 'bool' } },
      { type: { k: 'vector', s: 'float', n: 4 } },
      { type: { k: 'matrix', s: 'float', rows: 4, cols: 4 } },
    ]);
    expect(parseSrc('matrix<float, 4, 4> m;').items[0]).toMatchObject({ decl: { type: { type: { k: 'matrix', rows: 4, cols: 4 } } } });
  });
  it('型の大きさが 1〜4 でなければ FX-PARSE (例外は出さない)', () => {
    for (const src of ['vector<float, 5> v;', 'vector<float, 0> v;', 'matrix<float, 4, 9> m;', 'matrix<float, 0, 2> m;']) {
      expect(failure(src).code).toBe('FX-PARSE');
    }
    expect(failure('vector<foo, 3> v;').code).toBe('FX-PARSE');
    expect(failure('vector<float, x> v;').code).toBe('FX-PARSE');
  });
  it('知らない型の名前は FX-PARSE', () => {
    expect(failure('Foo x;')).toMatchObject({ code: 'FX-PARSE', line: 1, column: 1 });
  });
});

describe('構文解析: 文', () => {
  it('for・while・do・switch・discard・属性 [unroll] は読み飛ばす', () => {
    const body = stmts(`
      [unroll(4)] for (int i = 0, j = 1; i < 4; i++, j--) { if (i == 2) continue; else break; }
      for (;;) {}
      for (i = 0; ; ) discard;
      [loop] while (x) x--;
      do { x++; } while (x < 3);
      switch (n) { case 1: case 2: y = 1; break; default: { y = 2; } }
      return;
    `);
    expect(body.map(s => s.kind)).toEqual(['for', 'for', 'for', 'while', 'do', 'switch', 'return']);
    expect(body[0]).toMatchObject({
      kind: 'for',
      init: { kind: 'var', decls: [{ name: 'i' }, { name: 'j' }] },
      cond: { kind: 'binary', op: '<' },
      step: { kind: 'sequence', items: [{ kind: 'unary', op: '++', postfix: true }, { kind: 'unary', op: '--', postfix: true }] },
      // oxlint-disable-next-line unicorn/no-thenable
      body: { kind: 'block', body: [{ kind: 'if', then: { kind: 'continue' }, else: { kind: 'break' } }] },
    });
    expect(body[1]).toMatchObject({ init: null, cond: null, step: null });
    expect(body[2]).toMatchObject({ init: { kind: 'expr' }, cond: null, body: { kind: 'discard' } });
    expect(body[5]).toMatchObject({
      kind: 'switch',
      cases: [
        { value: { value: 1 }, body: [] },
        { value: { value: 2 }, body: [{ kind: 'expr' }, { kind: 'break' }] },
        { value: null, body: [{ kind: 'block' }] },
      ],
    });
    expect(body[6]).toMatchObject({ kind: 'return', value: null });
  });
  it('宣言と式の見分け: 型の名前で始まり、続く名前があれば宣言', () => {
    const body = stmts('float x = 1; static const float s = 1; x = 2; float3(1, 2, 3); ;');
    expect(body.map(s => s.kind)).toEqual(['var', 'var', 'expr', 'expr', 'empty']);
    expect(body[1]).toMatchObject({ decls: [{ storage: ['static', 'const'] }] });
  });
});

describe('構文解析: 誤り', () => {
  it('閉じていない括弧は FX-PARSE で、場所は元の行と列', () => {
    expect(failure('float f() {\n  return (a + b;\n}')).toMatchObject({ code: 'FX-PARSE', file: 'f.fx', line: 2, column: 16 });
    // 行末の \ でつないだ行も、元の行と列で数える
    expect(failure('float f() {\n  return (a + \\\n b;\n}')).toMatchObject({ code: 'FX-PARSE', line: 3, column: 3 });
  });
  it('閉じていない { は入力の終わりで FX-PARSE', () => {
    expect(failure('float f() { return 1;').code).toBe('FX-PARSE');
    expect(failure('struct S { float a;').code).toBe('FX-PARSE');
  });
  it('式がない所・; がない所も FX-PARSE', () => {
    expect(failure('void f() { x = ; }').code).toBe('FX-PARSE');
    expect(failure('void f() { x = 1 }').code).toBe('FX-PARSE');
    expect(failure('float x = 1').code).toBe('FX-PARSE');
  });
  it('SM4 以降の書き方 (cbuffer・tbuffer・Texture2D・SamplerState・t.Sample(…)) と asm は FX-UNSUPPORTED (FX-PARSE ではなく)', () => {
    const sources = [
      'cbuffer C { float4 a; };',
      'tbuffer T { float4 a; };',
      'Texture2D tex;',
      'TextureCube tex;',
      'SamplerState smp;',
      'SamplerComparisonState smp;',
      'float4 f(Texture3D t) { return 0; }',
      'float4 f() { Texture1D t; return 0; }',
      'float4 f() { return tex.Sample(smp, uv); }',
      'float4 f() { return tex.Load(int3(0, 0, 0)); }',
      'float4 f() { asm { mov r0, c0 }; }',
      'float4 g = asm { };',
    ];
    for (const src of sources) expect(failure(src).code, src).toBe('FX-UNSUPPORTED');
    expect(failure('Texture2D tex;')).toMatchObject({ line: 1, column: 1 });
    expect(failure('float4 f() { return tex.Sample(smp, uv); }')).toMatchObject({ column: 25 });
  });
});
