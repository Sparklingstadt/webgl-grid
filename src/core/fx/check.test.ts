import { describe, expect, it } from 'vitest';
import type { Expr, FunctionDecl, GlobalDecl, Stmt, TechniqueNode, VarDecl } from './ast.ts';
import { check, type CheckedEffect } from './check.ts';
import { Diagnostics, FxError } from './diagnostics.ts';
import { parse } from './parser.ts';
import { preprocess } from './preprocess.ts';
import { matrixOf, vectorOf, type Type } from './types.ts';

const F: Type = { k: 'scalar', s: 'float' };
const I: Type = { k: 'scalar', s: 'int' };
const F2 = vectorOf('float', 2);
const F3 = vectorOf('float', 3);
const F4 = vectorOf('float', 4);

// 前処理 → 構文解析 → 型チェック
function checkSrcWithDiags(src: string): { checked: CheckedEffect; diags: Diagnostics } {
  const diags = new Diagnostics();
  const tokens = preprocess('f.fx', { readFile: p => (p === 'f.fx' ? new TextEncoder().encode(src) : null) }, {}, diags);
  return { checked: check(parse(tokens, diags), diags), diags };
}
// 誤りがあれば投げる
function checkSrc(src: string): CheckedEffect {
  const { checked, diags } = checkSrcWithDiags(src);
  if (diags.errors.length > 0) throw new Error(diags.errors.map(e => `${e.code}: ${e.message}`).join('\n'));
  return checked;
}
const diagsOf = (src: string): Diagnostics => checkSrcWithDiags(src).diags;
const codesOf = (src: string) => diagsOf(src).errors.map(e => e.code);

const PS_PASS = ' technique T { pass P { PixelShader = compile ps_3_0 PS(); } }';
const PS_PASS_RETURNING = (e: string) => `float4 PS() : COLOR0 { return ${e}; }${PS_PASS}`;
const PASS_USING = (e: string) => ` float4 PS() : COLOR0 { return ${e}; }${PS_PASS}`;
// PS の中身 (body) を型チェックする
const PS_BODY = (decls: string, body: string) => `${decls} float4 PS() : COLOR0 { ${body} return 0; }${PS_PASS}`;

const fnOf = (c: CheckedEffect, name: string): FunctionDecl =>
  c.file.items.find((i): i is FunctionDecl => i.kind === 'function' && i.name === name && i.body !== null) as FunctionDecl;
const bodyOf = (c: CheckedEffect, name: string): Stmt[] => (fnOf(c, name).body as { kind: 'block'; body: Stmt[] }).body;
const passOf = (c: CheckedEffect) => (c.file.items.find(i => i.kind === 'technique') as TechniqueNode).passes[0];
const globalDecl = (c: CheckedEffect, name: string): VarDecl =>
  (c.file.items.find((i): i is GlobalDecl => i.kind === 'global' && i.decl.name === name) as GlobalDecl).decl;
// 式を、convert は <型>(…) の形で書き出す
function show(e: Expr): string {
  switch (e.kind) {
    case 'number': return String(e.value);
    case 'bool': return String(e.value);
    case 'ident': return e.name;
    case 'convert': return `<${e.to.k === 'scalar' ? e.to.s : e.to.k === 'vector' ? `${e.to.s}${e.to.n}` : e.to.k}>(${show(e.value)})`;
    case 'binary': return `(${show(e.left)} ${e.op} ${show(e.right)})`;
    case 'ternary': return `(${show(e.cond)} ? ${show(e.then)} : ${show(e.else)})`;
    case 'member': return `${show(e.object)}.${e.name}`;
    case 'call': return `${e.callee}(${e.args.map(show).join(', ')})`;
    case 'construct': return `ctor(${e.args.map(show).join(', ')})`;
    default: return `<${e.kind}>`;
  }
}

describe('型チェック: グローバル変数', () => {
  it('static の初期値が uniform を使えば needsInit、定数なら値', () => {
    const c = checkSrc('float u; static float a = lerp(1, 2, u); static const float b = 2 * 3; const float4 BackColor = 0.0;' + PASS_USING('a + b'));
    expect(c.globals.get('a')).toMatchObject({ storage: 'static', needsInit: true });
    expect(c.globals.get('b')?.value).toEqual({ kind: 'num', type: F, values: [6] });
    expect(c.globals.get('BackColor')).toMatchObject({ storage: 'const', value: { values: [0, 0, 0, 0] } });
    expect(c.globals.get('u')?.storage).toBe('uniform');
  });
  it('記憶域: セマンティクス付きや初期値が定数でない const は uniform、uniform の初期値は定数でなければ FX-TYPE-CONST', () => {
    const c = checkSrc('const float4x4 W : WORLD; const float k = 2; extern float e = 1; static float s; row_major float4x4 M;' + PASS_USING('k'));
    expect([...c.globals.values()].map(g => [g.decl.name, g.storage, g.needsInit])).toEqual([
      ['W', 'uniform', false], ['k', 'const', false], ['e', 'uniform', false], ['s', 'static', false], ['M', 'uniform', false]]);
    expect(c.globals.get('e')?.value).toEqual({ kind: 'num', type: F, values: [1] });
    expect(codesOf('float u; float v = u * 2;' + PASS_USING('v'))).toEqual(['FX-TYPE-CONST']);
  });
  it('構造体の uniform・int の行列・1xN の行列は FX-UNSUPPORTED', () => {
    expect(codesOf('struct S { float a; }; S s; int2x2 m; float1x3 r;' + PASS_USING('1'))).toEqual(['FX-UNSUPPORTED', 'FX-UNSUPPORTED', 'FX-UNSUPPORTED']);
    expect(codesOf('struct S { float a; }; static S s = (S)0;' + PASS_USING('s.a'))).toEqual([]);
  });
  it('注釈の値は定数に計算する (string・float2 = {1, 1})', () => {
    const c = checkSrc('const float k = 3; float x < string UIName = "x" "y"; float2 R = {1, 1}; float K = k * 2; > = 0.5;' + PASS_USING('x'));
    const [name, r, k] = globalDecl(c, 'x').annotations.map(a => c.constEval(a.value));
    expect(name).toEqual({ kind: 'str', value: 'xy' });
    expect(r).toEqual({ kind: 'num', type: F2, values: [1, 1] });
    expect(k).toEqual({ kind: 'num', type: F, values: [6] });
    expect(codesOf('float u; float x < float K = u; >;' + PASS_USING('x'))).toEqual(['FX-TYPE-CONST']);
  });
  it('初期値のリストと大きさを書かない配列', () => {
    const c = checkSrc('static const float W[] = { 1, 2.5, 3 }; static const float2x2 M = { 1, 2, float2(3, 4) };' + PASS_USING('W[1] + M._m10'));
    expect(c.globals.get('W')).toMatchObject({ type: { k: 'array', of: F, length: 3 }, value: { values: [1, 2.5, 3] } });
    expect(c.globals.get('M')?.value).toEqual({ kind: 'num', type: matrixOf('float', 2, 2), values: [1, 2, 3, 4] });
    expect(codesOf('static float2 v = { 1, 2, 3 };' + PASS_USING('v.x'))).toEqual(['FX-TYPE-MISMATCH']);
  });
});

describe('型チェック: 関数', () => {
  it('暗黙の型変換に convert を挟み、切り詰めは警告', () => {
    const { checked, diags } = checkSrcWithDiags('float4 PS() : COLOR0 { float3 t = float4(1,2,3,4); return t.xyzz; }' + PS_PASS);
    expect(diags.errors).toEqual([]);
    expect(diags.warnings.map(w => w.code)).toEqual(['FX-WARN-TRUNCATION']);
    const decl = (bodyOf(checked, 'PS')[0] as { kind: 'var'; decls: VarDecl[] }).decls[0];
    expect(show(decl.init as Expr)).toBe('<float3>(ctor(<float>(1), <float>(2), <float>(3), <float>(4)))');
    expect(decl.resolved).toEqual(F3);
  });
  it('二項演算の両辺・条件・return・引数にも convert', () => {
    const c = checkSrc(PS_BODY('float f(float x) { return x; }', 'int i = 1; float3 v = 0; float r = i + 2.0; if (i) v = v * i; r = f(i);'));
    const s = bodyOf(c, 'PS');
    const exprOf = (k: number) => (s[k] as { kind: 'expr'; expr: Expr }).expr;
    expect(show((s[2] as { kind: 'var'; decls: VarDecl[] }).decls[0].init as Expr)).toBe('(<float>(i) + 2)');
    const ifs = s[3] as { kind: 'if'; cond: Expr; then: Stmt };
    expect(show(ifs.cond)).toBe('<bool>(i)');
    expect(show((ifs.then as { kind: 'expr'; expr: Expr }).expr)).toBe('<assign>');
    expect(show(exprOf(4))).toBe('<assign>');
    expect(show((exprOf(4) as { kind: 'assign'; value: Expr }).value)).toBe('f(<float>(i))');
    expect(show((s[5] as { kind: 'return'; value: Expr }).value)).toBe('<float4>(0)');
  });
  it('使われていない関数の中の誤りでは失敗しない', () => {
    expect(() => checkSrc('float unused() { return nope; }' + PS_PASS_RETURNING('1'))).not.toThrow();
    expect(() => checkSrc('int2x2 unused(int2x2 m) { return m; }' + PS_PASS_RETURNING('1'))).not.toThrow();
  });
  it('使われている関数の誤りは集めて出す (知らない名前・合わない引数)', () => {
    const d = diagsOf('float4 PS() : COLOR0 { return nope + tex2D(1, 2); }' + PS_PASS);
    expect(d.errors.map(e => e.code)).toEqual(['FX-TYPE-UNDEFINED', 'FX-TYPE-NO-OVERLOAD']);
  });
  it('functions は pass から呼び出しをたどって使う関数だけ (見つけた順)', () => {
    const c = checkSrc('float b(); float a() { return b(); } float b() { return 1; } float unused() { return 2; }' + PS_PASS_RETURNING('a()'));
    expect(c.functions.map(f => f.decl.name)).toEqual(['PS', 'a', 'b']);
    const call = (bodyOf(c, 'a')[0] as { kind: 'return'; value: Expr }).value as Expr & { kind: 'call' };
    expect(call.target).toMatchObject({ kind: 'function', fn: fnOf(c, 'b') });
    expect(c.functions[0]).toMatchObject({ params: [], ret: F4 });
  });
  it('ユーザーの関数を組み込み関数より先に探し、オーバーロードを選ぶ', () => {
    const c = checkSrc('float lerp(float a) { return a; } float g(float x) { return x; } float g(float3 x) { return x.x; }' + PS_PASS_RETURNING('lerp(1) + g(float3(1, 2, 3)) + saturate(2)'));
    expect(c.functions.map(f => f.decl.name)).toEqual(['PS', 'lerp', 'g']);
    expect(c.functions[2].params).toEqual([F3]);
    expect(codesOf('float g(float2 x) { return 1; } float g(float3 x) { return 2; }' + PS_PASS_RETURNING('g(1)'))).toEqual(['FX-TYPE-AMBIGUOUS']);
  });
  it('組み込み関数の引数を変換し、target に params を書く', () => {
    const c = checkSrc(PS_BODY('sampler S;', 'float2 uv = 0; float4 c = tex2D(S, uv) + lerp(1, float4(1, 2, 3, 4), 0.5);'));
    const init = (bodyOf(c, 'PS')[1] as { kind: 'var'; decls: VarDecl[] }).decls[0].init as Expr & { kind: 'binary' };
    expect(init.left).toMatchObject({ kind: 'call', target: { kind: 'intrinsic', name: 'tex2D', params: [{ k: 'sampler', dim: '2D' }, F2] } });
    expect(show(init.right)).toBe('lerp(<float4>(1), ctor(<float>(1), <float>(2), <float>(3), <float>(4)), <float4>(0.5))');
  });
  it('noise・関数の中の static・ビット演算は誤り', () => {
    expect(codesOf(PS_PASS_RETURNING('noise(1.0)'))).toEqual(['FX-UNSUPPORTED']);
    expect(codesOf(PS_BODY('', 'static float s = 1;'))).toEqual(['FX-UNSUPPORTED']);
    expect(codesOf(PS_BODY('', 'int a = 1; int b = a & 2; int c = ~a;'))).toEqual(['FX-TYPE-MISMATCH', 'FX-TYPE-MISMATCH']);
  });
  it('代入できない左辺は FX-TYPE-LVALUE (式・const・uniform・uniform の引数)', () => {
    expect(codesOf(PS_BODY('', 'float a = 0, b = 0, c = 1; c ? a : b = 3; a + b = c; 1++;'))).toEqual(['FX-TYPE-LVALUE', 'FX-TYPE-LVALUE', 'FX-TYPE-LVALUE']);
    expect(codesOf(PS_BODY('float u; const float k = 1; static const float sk = 1; static float s;', 'u = 1; k = 2; sk = 3; s = 4; const float l = 1; l += 1;')))
      .toEqual(['FX-TYPE-LVALUE', 'FX-TYPE-LVALUE', 'FX-TYPE-LVALUE', 'FX-TYPE-LVALUE']);
    expect(codesOf('float4 PS(uniform float k) : COLOR0 { k = 1; return k; } technique T { pass P { PixelShader = compile ps_3_0 PS(1); } }')).toEqual(['FX-TYPE-LVALUE']);
  });
  it('out の引数は同じ型の変数', () => {
    expect(codesOf(PS_BODY('void f(out float x) { x = 1; }', 'float a; f(a); f(1); float2 b; f(b); float s, c; sincos(1.0, s, c);'))).toEqual(['FX-TYPE-LVALUE', 'FX-TYPE-MISMATCH']);
  });
  it('for の変数はループのあとも見え、2 つ目の for (int i …) は同じ変数を使う', () => {
    const c = checkSrc(PS_BODY('', 'float s = 0; for (int i = 0; i < 3; i++) s += i; s += i; for (int i = 0; i < 2; i++) s += i;'));
    const s = bodyOf(c, 'PS');
    const first = ((s[1] as { kind: 'for'; init: Stmt }).init as { kind: 'var'; decls: VarDecl[] }).decls[0];
    const second = ((s[3] as { kind: 'for'; init: Stmt }).init as { kind: 'var'; decls: VarDecl[] }).decls[0];
    expect(second.reuses).toBe(first);
    expect(first.reuses).toBeUndefined();
    const after = ((s[2] as { kind: 'expr'; expr: Expr }).expr as Expr & { kind: 'assign' }).value as Expr;
    const ident = after.kind === 'convert' ? after.value : after;
    expect(ident).toMatchObject({ kind: 'ident', sym: { kind: 'local', decl: first } });
    expect(codesOf(PS_BODY('', 'for (int i = 0; i < 3; i++) {} for (float i = 0; i < 2; i++) {}'))).toEqual(['FX-TYPE-REDEFINED']);
    expect(codesOf(PS_BODY('', 'float a = 0; float a = 1;'))).toEqual(['FX-TYPE-REDEFINED']);
  });
  it('break・continue はループの中だけ、return の値は関数に合わせる', () => {
    expect(codesOf(PS_BODY('void f() { return 1; } float g() { return; }', 'break; f(); g(); switch (1) { case 0: break; }'))).toEqual(['FX-TYPE-MISMATCH', 'FX-TYPE-MISMATCH', 'FX-TYPE-MISMATCH']);
  });
  it('誤りが 20 個を越えると FX-TYPE-TOO-MANY で止める', () => {
    const d = new Diagnostics();
    const src = `float4 PS() : COLOR0 { ${Array.from({ length: 25 }, (_, i) => `x${i};`).join(' ')} return 0; }${PS_PASS}`;
    expect(() => check(parse(preprocess('f.fx', { readFile: () => new TextEncoder().encode(src) }, {}, d), d), d)).toThrow(FxError);
    expect(d.errors.length).toBe(21);
    expect(d.errors[20].code).toBe('FX-TYPE-TOO-MANY');
  });
});

describe('型チェック: 式', () => {
  it('スワズルの誤り (xr を混ぜる・float2 の .z) は FX-TYPE-SWIZZLE、x.xx = … は FX-TYPE-LVALUE', () => {
    expect(codesOf(PS_BODY('', 'float2 v = 0; float a = v.xr; float b = v.z; float c = v.xyzwx;'))).toEqual(['FX-TYPE-SWIZZLE', 'FX-TYPE-SWIZZLE', 'FX-TYPE-SWIZZLE']);
    expect(codesOf(PS_BODY('', 'float2 x = 0; x.xx = 1;'))).toEqual(['FX-TYPE-LVALUE']);
    const c = checkSrc(PS_BODY('', 'float s = 1; float3 v = s.xxx; float4 w = v.rgbr; w.yx = v.xy;'));
    const s = bodyOf(c, 'PS');
    expect(((s[1] as { kind: 'var'; decls: VarDecl[] }).decls[0].init as Expr)).toMatchObject({ kind: 'member', access: { kind: 'swizzle', comps: [0, 0, 0] }, type: F3 });
    expect(((s[2] as { kind: 'var'; decls: VarDecl[] }).decls[0].init as Expr)).toMatchObject({ access: { kind: 'swizzle', comps: [0, 1, 2, 0] } });
  });
  it('行列の要素 _m00・_11 と添字', () => {
    const c = checkSrc(PS_BODY('float4x3 M;', 'float2 a = M._m01_m30; float b = M._43; float3 r = M[3]; float e = r[1];'));
    const inits = bodyOf(c, 'PS').slice(0, 4).map(st => (st as { kind: 'var'; decls: VarDecl[] }).decls[0].init as Expr);
    expect(inits[0]).toMatchObject({ access: { kind: 'matrix', elems: [[0, 1], [3, 0]] }, type: F2 });
    expect(inits[1]).toMatchObject({ access: { kind: 'matrix', elems: [[3, 2]] }, type: F });
    expect(inits[2]).toMatchObject({ kind: 'index', type: F3 });
    expect(codesOf(PS_BODY('float4x3 M;', 'float a = M._m03; float b = M._14; float3 r = M[4];'))).toEqual(['FX-TYPE-SWIZZLE', 'FX-TYPE-SWIZZLE', 'FX-TYPE-MISMATCH']);
  });
  it('構造体のメンバー・キャスト・コンストラクタ', () => {
    const c = checkSrc('struct VO { float4 Pos : POSITION; float2 Tex : TEXCOORD0; };' + PS_BODY('', 'VO o = (VO)0; o.Tex = 1; float4 p = o.Pos; int2 i = (int2)p.xy;'));
    expect(c.structs.get('VO')).toEqual({ k: 'struct', name: 'VO', fields: [{ name: 'Pos', type: F4, semantic: 'POSITION' }, { name: 'Tex', type: F2, semantic: 'TEXCOORD0' }] });
    expect(codesOf('struct VO { float a; };' + PS_BODY('', 'VO o = (VO)0; float b = o.nope; float3 v = float3(1, 2); float4 w = float4(v, v);')))
      .toEqual(['FX-TYPE-UNDEFINED', 'FX-TYPE-MISMATCH', 'FX-TYPE-MISMATCH']);
  });
  it('条件がベクトルの三項は、両辺を条件の形にそろえる。スカラーなら共通の型', () => {
    const c = checkSrc(PS_BODY('', 'float3 x = 0; float3 a = (x > 2) ? 10.0 : 20; float4 b = true ? 1 : float4(1, 2, 3, 4);'));
    const inits = bodyOf(c, 'PS').slice(1, 3).map(st => (st as { kind: 'var'; decls: VarDecl[] }).decls[0].init as Expr);
    expect(show(inits[0])).toBe('((x > <float3>(2)) ? <float3>(10) : <float3>(20))');
    expect(inits[0]).toMatchObject({ type: F3, cond: { type: vectorOf('bool', 3) } });
    expect(show(inits[1])).toBe('(true ? <float4>(1) : ctor(<float>(1), <float>(2), <float>(3), <float>(4)))');
  });
});

describe('型チェック: pass', () => {
  it('pass の uniform の引数を関数の引数の型に変換し、数が違えば FX-PASS-FUNCTION', () => {
    const src = (args: string) => `float4 PS(float2 uv : TEXCOORD0, uniform float k, uniform bool b = true) : COLOR0 { return k; }
      technique T { pass P { PixelShader = compile ps_3_0 PS(${args}); } }`;
    const c = checkSrc(src('2'));
    const e = c.entries.get(passOf(c));
    expect(e?.vs).toBeNull();
    expect(e?.ps).toMatchObject({ profile: 'ps_3_0', fn: { decl: { name: 'PS' } } });
    expect(e?.ps?.uniformArgs.map(a => [show(a), a.type])).toEqual([['<float>(2)', F], ['true', { k: 'scalar', s: 'bool' }]]);
    expect(codesOf(src(''))).toEqual(['FX-PASS-FUNCTION']);
    expect(codesOf(src('1, true, 3'))).toEqual(['FX-PASS-FUNCTION']);
    expect(codesOf('technique T { pass P { VertexShader = compile vs_3_0 nope(); } }')).toEqual(['FX-PASS-FUNCTION']);
  });
  it('同じ名前の関数がいくつかあれば uniform の引数が合うものを選ぶ', () => {
    const c = checkSrc(`float4 VS(float4 p : POSITION, uniform float3 k) : POSITION { return p; }
      float4 VS(float4 p : POSITION, uniform sampler s, uniform float k) : POSITION { return p; } sampler S;
      technique T { pass P { VertexShader = compile vs_2_0 VS(S, 1); } }`);
    expect(c.entries.get(passOf(c))?.vs?.fn.params).toEqual([F4, { k: 'sampler', dim: null }, F]);
  });
  it('vs_1_1 は FX-UNSUPPORTED', () => {
    expect(codesOf('float4 VS() : POSITION { return 0; } technique T { pass P { VertexShader = compile vs_1_1 VS(); } }')).toEqual(['FX-UNSUPPORTED']);
    expect(codesOf('float4 PS() : COLOR { return 0; } technique T { pass P { PixelShader = compile ps_2_b PS(); } }')).toEqual([]);
  });
  it('sampler の dim を sampler_state の Texture の型、なければ使い方から決める', () => {
    const c = checkSrc('texture2D T; textureCUBE TC; texture TN; sampler A = sampler_state { Texture = <T>; }; sampler B = sampler_state { texture = <TN>; }; sampler C; sampler D;'
      + PS_PASS_RETURNING('tex2D(A, 0) + texCUBE(B, 0) + tex3D(C, 0)'));
    expect(['A', 'B', 'C', 'D'].map(n => c.globals.get(n)?.type)).toEqual([
      { k: 'sampler', dim: '2D' }, { k: 'sampler', dim: 'CUBE' }, { k: 'sampler', dim: '3D' }, { k: 'sampler', dim: null }]);
    const tex = (globalDecl(c, 'A').init as Expr & { kind: 'samplerState' }).states[0].value;
    expect(tex).toMatchObject({ kind: 'ident', sym: { kind: 'global', name: 'T' } });
    expect(codesOf('textureCUBE TC; sampler A = sampler_state { Texture = <TC>; }; sampler C;' + PS_PASS_RETURNING('tex2D(A, 0) + tex2D(C, 0) + tex3D(C, 0)')))
      .toEqual(['FX-TYPE-MISMATCH', 'FX-TYPE-MISMATCH']);
    expect(codesOf('textureCUBE TC; sampler2D A = sampler_state { Texture = <TC>; }; sampler B = sampler_state { Texture = <nope>; };' + PS_PASS_RETURNING('1')))
      .toEqual(['FX-TYPE-MISMATCH', 'FX-TYPE-UNDEFINED']);
  });
});

describe('型チェック: 定数の計算', () => {
  const evalIn = (decls: string, e: string) => {
    const c = checkSrc(`${decls} static const float4 X__ = 0; static float R__ = ${e};${PASS_USING('R__')}`);
    const init = globalDecl(c, 'R__').init as Expr;
    return c.constEval(init.kind === 'convert' ? init.value : init);
  };
  it('演算・組み込み関数・const と static の参照', () => {
    expect(evalIn('', '7 / 2')).toEqual({ kind: 'num', type: I, values: [3] });
    expect(evalIn('', '-7 % 3 + 0.5')).toEqual({ kind: 'num', type: F, values: [-0.5] });
    expect(evalIn('static const float3 v = float3(3, 0, 4);', 'length(v)')).toEqual({ kind: 'num', type: F, values: [5] });
    expect(evalIn('static const float3 v = float3(3, 0, 4);', 'normalize(v).z')).toEqual({ kind: 'num', type: F, values: [0.8] });
    expect(evalIn('const float2 a = float2(1, 2);', 'dot(a, a) + max(1, 3) + pow(2, 3) + saturate(1.5) + frac(2.25) + lerp(0, 10, 0.5)')).toEqual({ kind: 'num', type: F, values: [5 + 3 + 8 + 1 + 0.25 + 5] });
    expect(evalIn('', '(1 < 2) ? 3 : 4')).toEqual({ kind: 'num', type: I, values: [3] });
    expect(evalIn('float u;', 'u + 1')).toBeNull();
    expect(evalIn('static float s = 2;', 's * 2')).toEqual({ kind: 'num', type: F, values: [4] });
  });
  it('行列は行ごと、切り詰めと bool', () => {
    expect(evalIn('static const float3x3 M = float3x3(1, 2, 3, 4, 5, 6, 7, 8, 9);', '(float2x2)M')).toEqual({ kind: 'num', type: matrixOf('float', 2, 2), values: [1, 2, 4, 5] });
    expect(evalIn('static const float3x3 M = float3x3(1, 2, 3, 4, 5, 6, 7, 8, 9);', 'M[1]')).toEqual({ kind: 'num', type: F3, values: [4, 5, 6] });
    expect(evalIn('', 'float3(1, 2, 3) > 2')).toEqual({ kind: 'num', type: vectorOf('bool', 3), values: [0, 0, 1] });
  });
  it('型チェックしていない式 (ステートの値) も計算する', () => {
    const c = checkSrc('const float k = 2;' + PS_PASS_RETURNING('1'));
    const e = (src: string) => (parse(preprocess('s.fx', { readFile: () => new TextEncoder().encode(`static float z = ${src};`) }, {}, new Diagnostics()), new Diagnostics()).items[0] as GlobalDecl).decl.init as Expr;
    expect(c.constEval(e('1 | 2 | 4'))).toEqual({ kind: 'num', type: I, values: [7] });
    expect(c.constEval(e('k * 3'))).toEqual({ kind: 'num', type: F, values: [6] });
    expect(c.constEval(e('float4(1, 1, 0, 1)'))).toEqual({ kind: 'num', type: F4, values: [1, 1, 0, 1] });
  });
});
