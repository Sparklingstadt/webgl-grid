import { parser } from '@shaderfrog/glsl-parser';
import { describe, expect, it } from 'vitest';
import type { Expr, FunctionDecl, Stmt } from './ast.ts';
import { check, type CheckedEffect, type FunctionInfo } from './check.ts';
import { Diagnostics } from './diagnostics.ts';
import {
  emitExpr, emitFunctions, emitHelpers, emitStructs, glslName, glslType, newEmitContext, zeroOf, type EmitContext,
} from './emit.ts';
import { parse } from './parser.ts';
import { preprocess } from './preprocess.ts';
import { INTRINSIC_NAMES, resolveIntrinsic } from './intrinsics.ts';
import { matrixOf, vectorOf, type Type } from './types.ts';

const F4x3 = matrixOf('float', 4, 3);
const M44 = matrixOf('float', 4, 4);
const I2 = vectorOf('int', 2);
const samplerOf = (dim: '1D' | '2D' | '3D' | 'CUBE' | null): Type => ({ k: 'sampler', dim });

const PS_PASS = ' technique T { pass P { PixelShader = compile ps_3_0 PS(); } }';
const VS_PASS = ' technique T { pass P { VertexShader = compile vs_3_0 VS(); } }';

// 前処理 → 構文解析 → 型チェック (誤りがあれば投げる)
function checkSrc(src: string): CheckedEffect {
  const diags = new Diagnostics();
  const tokens = preprocess('f.fx', { readFile: p => (p === 'f.fx' ? new TextEncoder().encode(src) : null) }, {}, diags);
  const checked = check(parse(tokens, diags), diags);
  if (diags.errors.length > 0) throw new Error(diags.errors.map(e => `${e.code}: ${e.message}`).join('\n'));
  return checked;
}
const infoOf = (c: CheckedEffect, name: string): FunctionInfo => c.functions.find(f => f.decl.name === name) as FunctionInfo;
const bodyOf = (c: CheckedEffect, name: string): Stmt[] => ((infoOf(c, name).decl as FunctionDecl).body as { kind: 'block'; body: Stmt[] }).body;

// PS の中で vars を局所変数として宣言し、式 expr を書き出す
function exprCtx(expr: string, vars: Record<string, string>, stage: 'vertex' | 'fragment' = 'fragment'): { code: string; ctx: EmitContext } {
  const decls = Object.entries(vars).map(([n, ty]) => `${ty} ${n};`).join(' ');
  const c = stage === 'fragment'
    ? checkSrc(`float4 PS() : COLOR0 { ${decls} ${expr}; return 0; }${PS_PASS}`)
    : checkSrc(`float4 VS() : POSITION { ${decls} ${expr}; return 0; }${VS_PASS}`);
  const st = bodyOf(c, stage === 'fragment' ? 'PS' : 'VS')[Object.keys(vars).length] as { kind: 'expr'; expr: Expr };
  const ctx = newEmitContext(c, stage, new Diagnostics());
  return { code: emitExpr(st.expr, ctx), ctx };
}
const exprOf = (expr: string, vars: Record<string, string> = {}): string => exprCtx(expr, vars).code;
const exprCodes = (expr: string, vars: Record<string, string>, stage: 'vertex' | 'fragment' = 'fragment') =>
  exprCtx(expr, vars, stage).ctx.diags.errors.map(e => e.code);

// 型チェックまで通して、関数 name (と、それが呼ぶ関数) を書き出す
function emitFn(src: string, name: string, stage: 'vertex' | 'fragment' = 'fragment'): { code: string; ctx: EmitContext; c: CheckedEffect } {
  const c = checkSrc(src);
  const ctx = newEmitContext(c, stage, new Diagnostics());
  return { code: emitFunctions([infoOf(c, name)], ctx), ctx, c };
}

const HEADER = ['#version 300 es', 'precision highp float;', 'precision highp int;', 'precision highp sampler2D;', 'precision highp sampler3D;', 'precision highp samplerCube;'];

// 構造体・グローバル変数 (ここでは全部 uniform として)・helpers・関数をつないだシェーダー
function shaderOf(src: string, root: string): { glsl: string; ctx: EmitContext } {
  const { code, ctx, c } = emitFn(src, root);
  const globals = [...ctx.usedGlobals].map(n => `uniform ${glslType(c.globals.get(n)?.type as Type)} ${glslName(n)};`);
  const flip = ctx.helpers.has('mme_flipY') ? ['uniform float mme_flipY;'] : [];
  return { glsl: [...HEADER, emitStructs(ctx), ...globals, ...flip, emitHelpers(ctx), code].join('\n'), ctx };
}

describe('GLSL の書き出し: 名前と型', () => {
  it('glslName', () => {
    expect(['input', 'mix', 'color', 'gl_Foo', 'a__b', 'a_POSITION'].map(glslName)).toEqual(['input_', 'mix_', 'color', 'xgl_Foo', 'a_x_b', 'a_POSITION_']);
    expect(['texture', 'sample', 'main', 'mme_fmod', 'v_TEXCOORD0', 'o_COLOR0', 'Pos', 'x___y'].map(glslName))
      .toEqual(['texture_', 'sample_', 'main_', 'mme_fmod_', 'v_TEXCOORD0_', 'o_COLOR0_', 'Pos', 'x_x_y']);
    // 後ろに _ を足しても __ にならない。WebGL が予約する webgl_・_webgl_ は前に x
    const odd = ['a_A_', 'mme_', 'webgl_foo', '_webgl_bar'].map(glslName);
    expect(odd).toEqual(['a_A_x_', 'mme_x_', 'xwebgl_foo', 'x_webgl_bar']);
    for (const n of odd) expect(n).not.toMatch(/__|^(?:gl_|webgl_|_webgl_)/);
  });
  it('glslType', () => {
    expect([F4x3, M44, I2, samplerOf(null)].map(glslType)).toEqual(['mat4x3', 'mat4', 'ivec2', 'sampler2D']);
    const more: Type[] = [
      { k: 'scalar', s: 'float' }, vectorOf('float', 3), vectorOf('bool', 4), matrixOf('float', 2, 3), samplerOf('1D'), samplerOf('3D'), samplerOf('CUBE'),
      { k: 'array', of: vectorOf('float', 2), length: 3 }, { k: 'struct', name: 'input', fields: [] },
    ];
    expect(more.map(glslType)).toEqual(['float', 'vec3', 'bvec4', 'mat2x3', 'sampler2D', 'sampler3D', 'samplerCube', 'vec2[3]', 'input_']);
  });
  it('zeroOf', () => {
    const S: Type = { k: 'struct', name: 'S', fields: [{ name: 'a', type: { k: 'scalar', s: 'float' }, semantic: null }, { name: 'b', type: vectorOf('float', 2), semantic: null }] };
    const types: Type[] = [vectorOf('float', 3), S, I2, { k: 'scalar', s: 'bool' }, { k: 'array', of: { k: 'scalar', s: 'int' }, length: 2 }, M44];
    expect(types.map(zeroOf))
      .toEqual(['vec3(0.0)', 'S(0.0, vec2(0.0))', 'ivec2(0)', 'false', 'int[2](0, 0)', 'mat4(0.0)']);
  });
});

describe('GLSL の書き出し: 式', () => {
  it('mul と行列の要素', () => {
    expect(exprOf('mul(v, M)', { v: 'float4', M: 'float4x3' })).toBe('(M) * (v)');
    expect(exprOf('mul(M, v)', { v: 'float4', M: 'float3x4' })).toBe('(v) * (M)');
    expect(exprOf('M._m21', { M: 'float3x4' })).toBe('M[2][1]');
    expect(exprOf('A * B', { A: 'float4x4', B: 'float4x4' })).toBe('matrixCompMult(A, B)');
    expect(exprOf('mul(s, v)', { s: 'float', v: 'float3' })).toBe('s * v');
    expect(exprOf('mul(a, b)', { a: 'float3', b: 'float3' })).toBe('dot(a, b)');
    expect(exprOf('mul(A, B)', { A: 'float4x4', B: 'float4x4' })).toBe('(B) * (A)');
    expect(exprOf('M._m01_m10', { M: 'float3x4' })).toBe('vec2(M[0][1], M[1][0])');
    expect(exprOf('M._11', { M: 'float3x4' })).toBe('M[0][0]');
    expect(exprOf('M[1]', { M: 'float3x4' })).toBe('M[1]');
    expect(exprOf('(float3x3)M', { M: 'float4x4' })).toBe('mat3(M)');
    expect(exprOf('A * 2', { A: 'float4x4' })).toBe('A * 2.0');
  });
  it('fmod・int の割り算・ベクトルの比較と選択', () => {
    expect(exprOf('fmod(a, b)', { a: 'float', b: 'float' })).toBe('mme_fmod(a, b)');
    expect(exprOf('i / j', { i: 'int', j: 'int' })).toBe('mme_idiv(i, j)');
    // 型チェックは int の 10 : 20 を int3 にするので、float の選択は float の数で確かめる
    expect(exprOf('(x > 2) ? 10.0 : 20.0', { x: 'float3' })).toBe('mix(vec3(20.0), vec3(10.0), greaterThan(x, vec3(2.0)))');
    // int・uint・bool の成分ごとの選択は、短絡しない算術・ビット演算で (枝はどちらも 1 回だけ書く。条件は 2 回)
    expect(exprOf('(x > 2) ? 10 : 20', { x: 'float2' }))
      .toBe('ivec2(10) * ivec2(greaterThan(x, vec2(2.0))) + ivec2(20) * ivec2(not(greaterThan(x, vec2(2.0))))');
    expect(exprOf('c ? a : b', { c: 'bool3', a: 'uint3', b: 'uint3' })).toBe('a * uvec3(c) + b * uvec3(not(c))');
    expect(exprOf('c ? a : b', { c: 'bool2', a: 'bool2', b: 'bool2' })).toBe('bvec2((uvec2(c) & uvec2(a)) | (uvec2(not(c)) & uvec2(b)))');
    expect(exprCodes('(d = c) ? a : b', { c: 'bool2', d: 'bool2', a: 'int2', b: 'int2' })).toEqual(['FX-UNSUPPORTED']);
    expect(exprOf('c ? a : b', { c: 'bool', a: 'float', b: 'float' })).toBe('c ? a : b');
  });
  it('% と / の helpers (float・int・uint・ベクトルとスカラー)', () => {
    const { code, ctx } = exprCtx('i % j', { i: 'int', j: 'int' });
    expect(code).toBe('mme_imod(i, j)');
    expect([...ctx.helpers].sort()).toEqual(['mme_idiv', 'mme_imod']);
    expect(exprOf('v % s', { v: 'float3', s: 'float' })).toBe('mme_fmod(v, vec3(s))');
    expect(exprOf('v % 2', { v: 'float3' })).toBe('mme_fmod(v, vec3(2.0))');
    expect(exprOf('v / 2', { v: 'int2' })).toBe('mme_idiv(v, ivec2(2))');
    expect(exprOf('u / w', { u: 'uint', w: 'uint' })).toBe('u / w');
    expect(exprOf('a / b', { a: 'float', b: 'float' })).toBe('a / b');
  });
  it('スカラーのスワズル・暗黙の変換の数はたたむ', () => {
    expect(exprOf('s.xx', { s: 'float' })).toBe('vec2(s)');
    expect(exprOf('t = 1', { t: 'float3' })).toBe('t = vec3(1.0)');
    expect(exprOf('s.x = 2', { s: 'float' })).toBe('s = 2.0');
    expect(exprOf('i = -2.5', { i: 'int' })).toBe('i = -2');
    expect(exprOf('M = 0', { M: 'float2x2' })).toBe('M = mat2(0.0)');
    expect(exprOf('M = 1', { M: 'float2x3' })).toBe('M = mat2x3(1.0, 1.0, 1.0, 1.0, 1.0, 1.0)');
    expect(exprOf('M = s', { M: 'float2x3', s: 'float' })).toBe('M = outerProduct(vec3(s), vec2(1.0))');
    expect(exprOf('s = v', { s: 'float', v: 'float3' })).toBe('s = float(v)');
    expect(exprOf('b = 2', { b: 'bool' })).toBe('b = true');
  });
  it('数の書き方', () => {
    expect(exprOf('x = 3', { x: 'float' })).toBe('x = 3.0');
    expect(exprOf('x = 0.25', { x: 'float' })).toBe('x = 0.25');
    expect(exprOf('x = 1e-7', { x: 'float' })).toBe('x = 1e-07');
    expect(exprOf('x = 1e40', { x: 'float' })).toBe('x = uintBitsToFloat(0x7F800000u)');
    expect(exprOf('x = -1e40', { x: 'float' })).toBe('x = -uintBitsToFloat(0x7F800000u)');
    expect(exprOf('u = 3', { u: 'uint' })).toBe('u = 3u');
  });
  it('演算子の優先順位と括弧', () => {
    expect(exprOf('(a + b) * c', { a: 'float', b: 'float', c: 'float' })).toBe('(a + b) * c');
    expect(exprOf('a - (b - c)', { a: 'float', b: 'float', c: 'float' })).toBe('a - (b - c)');
    expect(exprOf('-(-a)', { a: 'float' })).toBe('-(-a)');
    expect(exprOf('(a + b).x', { a: 'float2', b: 'float2' })).toBe('(a + b).x');
    expect(exprOf('i++', { i: 'int' })).toBe('i++');
  });
  it('ベクトルの比較・論理・not', () => {
    expect(exprOf('a < b', { a: 'float2', b: 'float2' })).toBe('lessThan(a, b)');
    expect(exprOf('a == b', { a: 'float2', b: 'float2' })).toBe('equal(a, b)');
    expect(exprOf('a != b', { a: 'int3', b: 'int3' })).toBe('notEqual(a, b)');
    expect(exprOf('!v', { v: 'bool2' })).toBe('not(v)');
    expect(exprOf('!c', { c: 'bool' })).toBe('!c');
    // ベクトルの && || は短絡しない (HLSL は両方を計算する)
    expect(exprOf('a && b', { a: 'bool2', b: 'bool2' })).toBe('bvec2(uvec2(a) & uvec2(b))');
    expect(exprOf('a || (x > 0)', { a: 'bool3', x: 'float3' })).toBe('bvec3(uvec3(a) | uvec3(greaterThan(x, vec3(0.0))))');
    expect(exprOf('a || b', { a: 'bool', b: 'bool' })).toBe('a || b');
    expect(exprOf('a < b', { a: 'bool', b: 'bool' })).toBe('int(a) < int(b)');
  });
  it('組み込み関数の付け替え', () => {
    const v = { x: 'float3', y: 'float3', t: 'float' };
    expect(exprOf('lerp(x, y, t)', v)).toBe('mix(x, y, vec3(t))');
    expect(exprOf('frac(x) + rsqrt(x)', v)).toBe('fract(x) + inversesqrt(x)');
    expect(exprOf('atan2(t, t)', v)).toBe('atan(t, t)');
    expect(exprOf('saturate(x)', v)).toBe('clamp(x, 0.0, 1.0)');
    expect(exprOf('log10(x)', v)).toBe('(log(x) * 0.4342944819)');
    expect(exprOf('ldexp(x, y)', v)).toBe('(x * exp2(y))');
    expect(exprOf('isfinite(t)', v)).toBe('!(isnan(t) || isinf(t))');
    expect(exprOf('isfinite(x.xy)', v)).toBe('bvec2(!(isnan(x.xy.x) || isinf(x.xy.x)), !(isnan(x.xy.y) || isinf(x.xy.y)))');
    expect(exprOf('lit(t, t, t)', v)).toBe('mme_lit(t, t, t)');
    expect(exprOf('D3DCOLORtoUBYTE4(c)', { c: 'float4' })).toBe('ivec4(c.zyxw * 255.001953)');
    expect(exprOf('any(x)', v)).toBe('any(notEqual(x, vec3(0.0)))');
    expect(exprOf('all(t)', v)).toBe('t != 0.0');
    expect(exprOf('all(i)', { i: 'int2' })).toBe('all(notEqual(i, ivec2(0)))');
    expect(exprOf('any(b)', { b: 'bool2' })).toBe('any(b)');
    expect(exprOf('all(b)', { b: 'bool' })).toBe('b');
    expect(exprOf('sign(t) + abs(t) + modf(t, t)', v)).toBe('sign(t) + abs(t) + modf(t, t)');
  });
  it('ddy は mme_flipY を掛け、sincos は helper にする', () => {
    const d = exprCtx('ddy(x) + ddx(x)', { x: 'float' });
    expect(d.code).toBe('(-mme_flipY * dFdy(x)) + dFdx(x)');
    expect(d.ctx.helpers.has('mme_flipY')).toBe(true);
    const s = exprCtx('sincos(x, a, b)', { x: 'float2', a: 'float2', b: 'float2' });
    expect(s.code).toBe('mme_sincos(x, a, b)');
    expect([...s.ctx.helpers]).toEqual(['mme_sincos']);
  });
  it('テクスチャ', () => {
    const src = (e: string) => `texture Tx; sampler S1 : register(s0); sampler2D S2; sampler3D S3; samplerCUBE SC;
      float4 PS(float x : TEXCOORD0, float2 uv : TEXCOORD1, float3 d : TEXCOORD2, float4 q : TEXCOORD3) : COLOR0 { return ${e}; }${PS_PASS}`;
    const ret = (e: string) => {
      const c = checkSrc(src(e));
      const st = bodyOf(c, 'PS')[0] as { kind: 'return'; value: Expr };
      return emitExpr(st.value, newEmitContext(c, 'fragment', new Diagnostics()));
    };
    expect(ret('tex1D(S1, x)')).toBe('texture(S1, vec2(x, 0.5))');
    expect(ret('tex2D(S2, uv)')).toBe('texture(S2, uv)');
    expect(ret('tex2D(S2, uv, uv, uv)')).toBe('textureGrad(S2, uv, uv, uv)');
    expect(ret('tex2Dgrad(S2, uv, uv, uv)')).toBe('textureGrad(S2, uv, uv, uv)');
    expect(ret('tex2Dlod(S2, q)')).toBe('textureLod(S2, q.xy, q.w)');
    expect(ret('tex2Dbias(S2, q)')).toBe('texture(S2, q.xy, q.w)');
    expect(ret('tex2Dproj(S2, q)')).toBe('textureProj(S2, q)');
    expect(ret('tex3D(S3, d)')).toBe('texture(S3, d)');
    expect(ret('tex3Dlod(S3, q)')).toBe('textureLod(S3, q.xyz, q.w)');
    expect(ret('texCUBE(SC, d)')).toBe('texture(SC, d)');
    expect(ret('texCUBEproj(SC, q)')).toBe('texture(SC, q.xyz / q.w)');
    expect(ret('tex1Dgrad(S1, x, x, x)')).toBe('textureGrad(S1, vec2(x, 0.5), vec2(x, 0.0), vec2(x, 0.0))');
  });
  it('複合代入を開く', () => {
    expect(exprOf('x %= y', { x: 'float', y: 'float' })).toBe('x = mme_fmod(x, y)');
    expect(exprOf('v %= s', { v: 'float3', s: 'float' })).toBe('v = mme_fmod(v, vec3(s))');
    expect(exprOf('i /= j', { i: 'int', j: 'int' })).toBe('i = mme_idiv(i, j)');
    expect(exprOf('i %= j', { i: 'int', j: 'int' })).toBe('i = mme_imod(i, j)');
    expect(exprOf('A *= B', { A: 'float3x3', B: 'float3x3' })).toBe('A = matrixCompMult(A, B)');
    expect(exprOf('A *= 2', { A: 'float3x3' })).toBe('A *= 2.0');
    expect(exprOf('x /= y', { x: 'float', y: 'float' })).toBe('x /= y');
    expect(exprOf('i += 1', { i: 'int' })).toBe('i += 1');
  });
  it('左辺を 2 回書くと副作用が 2 回になるものは FX-UNSUPPORTED', () => {
    expect(exprCodes('a[i++] %= 2', { 'a[3]': 'float', i: 'int' })).toEqual(['FX-UNSUPPORTED']);
    expect(exprCodes('a[i] %= 2', { 'a[3]': 'float', i: 'int' })).toEqual([]);
    expect(exprCodes('isfinite(x + i++)', { x: 'float', i: 'int' })).toEqual(['FX-UNSUPPORTED']);
    expect(exprCodes('(x > 0) && b', { x: 'float2', b: 'bool2' })).toEqual([]);
    expect(exprCodes('(c = a) && b', { a: 'bool2', b: 'bool2', c: 'bool2' })).toEqual([]); // 1 回だけ書く
  });
  it('ベクトルの && || と int の選択は、discard する関数も条件によらず 1 回だけ呼ぶ (短絡しない)', () => {
    const logic = shaderOf(`float2 f(float2 x) { if (x.x < 0) discard; return x; }
      float4 PS(float2 uv : TEXCOORD0) : COLOR0 { bool2 b = (uv > 0.5) && (f(uv) > 0.25); return b.x ? 1 : 0; }${PS_PASS}`, 'PS');
    expect(logic.glsl).toContain('bvec2 b = bvec2(uvec2(greaterThan(uv, vec2(0.5))) & uvec2(greaterThan(f(uv), vec2(0.25))));');
    expect(logic.glsl.match(/f\(uv\)/g)).toHaveLength(1);
    expect(logic.glsl).not.toContain('&&');
    expect(logic.ctx.diags.errors).toEqual([]);
    expect(() => parser.parse(logic.glsl, { quiet: true, failOnWarn: true, stage: 'fragment' })).not.toThrow();
    const select = shaderOf(`static int n; int3 g() { n += 1; return n; }
      float4 PS(float2 uv : TEXCOORD0) : COLOR0 { bool3 c = uv.xyx > 0.5; int3 r = c ? int3(1, 2, 3) : g(); return r.x; }${PS_PASS}`, 'PS');
    expect(select.glsl).toContain('ivec3 r = ivec3(1, 2, 3) * ivec3(c) + g() * ivec3(not(c));');
    expect(select.glsl.match(/g\(\)/g)).toHaveLength(3); // プロトタイプ・定義と、呼び出しの 1 回
    expect(select.ctx.diags.errors).toEqual([]);
    expect(() => parser.parse(select.glsl, { quiet: true, failOnWarn: true, stage: 'fragment' })).not.toThrow();
  });
  it('外から見える副作用のないユーザーの関数は 2 回書き出してよい (out・inout の引数・グローバル変数への書き込みがなく、呼ぶ関数もそう)', () => {
    const codes = (fns: string) => emitFn(`sampler2D S; static float g; ${fns}
      float4 PS(float2 uv : TEXCOORD0) : COLOR0 { return tex2Dlod(S, float4(f(uv), 0, 0)); }${PS_PASS}`, 'PS').ctx.diags.errors.map(e => e.code);
    expect(codes('float2 h(float2 x) { float2 y = x; y *= 2; return y; } float2 f(float2 x) { float s, c; sincos(x.x, s, c); return h(x) * s; }')).toEqual([]);
    expect(emitFn(`sampler2D S; float2 f(float2 x) { return x * 2; }
      float4 PS(float2 uv : TEXCOORD0) : COLOR0 { return tex2Dlod(S, float4(f(uv), 0, 0)); }${PS_PASS}`, 'PS').code)
      .toContain('textureLod(S, vec4(f(uv), 0.0, 0.0).xy, vec4(f(uv), 0.0, 0.0).w)');
    expect(codes('float2 f(float2 x) { g += 1; return x; }')).toEqual(['FX-UNSUPPORTED']);
    expect(codes('float2 h(float2 x) { g = x.x; return x; } float2 f(float2 x) { return h(x); }')).toEqual(['FX-UNSUPPORTED']);
    expect(codes('void h(out float y) { y = 1; } float2 f(float2 x) { h(g); return x; }')).toEqual(['FX-UNSUPPORTED']);
    expect(codes('float2 f(float2 x) { float c; sincos(x.x, g, c); return x; }')).toEqual(['FX-UNSUPPORTED']);
    expect(codes('float2 f(inout float2 x) { return x; }')).toEqual(['FX-UNSUPPORTED']);
  });
  it('ddx・clip・discard は頂点シェーダーでは FX-UNSUPPORTED、行列への成分ごとの関数も FX-UNSUPPORTED', () => {
    expect(exprCodes('ddx(x)', { x: 'float' }, 'vertex')).toEqual(['FX-UNSUPPORTED']);
    const tex = (e: string, stage: 'vertex' | 'fragment') => emitFn(stage === 'vertex'
      ? `sampler2D S; float4 VS(float4 q : TEXCOORD0) : POSITION { return ${e}; }${VS_PASS}`
      : `sampler2D S; float4 PS(float4 q : TEXCOORD0) : COLOR0 { return ${e}; }${PS_PASS}`, stage === 'vertex' ? 'VS' : 'PS', stage).ctx.diags.errors.map(x => x.code);
    expect(tex('tex2Dbias(S, q)', 'vertex')).toEqual(['FX-UNSUPPORTED']);
    expect(tex('tex2Dbias(S, q)', 'fragment')).toEqual([]);
    expect(tex('tex2Dlod(S, q)', 'vertex')).toEqual([]);
    expect(exprCodes('abs(M)', { M: 'float2x2' })).toEqual(['FX-UNSUPPORTED']);
    expect(exprCodes('M % M', { M: 'float2x2' })).toEqual(['FX-UNSUPPORTED']);
    expect(exprCodes('M._m00_m11 = v', { M: 'float2x2', v: 'float2' })).toEqual(['FX-UNSUPPORTED']);
    expect(exprCodes('clip(x), x', { x: 'float' })).toEqual(['FX-UNSUPPORTED']);
    const codes = (src: string, name: string, stage: 'vertex' | 'fragment') => emitFn(src, name, stage).ctx.diags.errors.map(e => e.code);
    expect(codes(`float4 VS() : POSITION { if (1) discard; return 0; }${VS_PASS}`, 'VS', 'vertex')).toEqual(['FX-UNSUPPORTED']);
    expect(codes(`sampler2D S; float4 PS() : COLOR0 { sampler2D s = S; return tex2D(s, 0); }${PS_PASS}`, 'PS', 'fragment')).toEqual(['FX-UNSUPPORTED']);
  });
  it('使ったグローバル変数を usedGlobals に入れ、static も名前のまま書く', () => {
    const c = checkSrc(`float u; static float s = 2; const float K = 3; float4 PS() : COLOR0 { return u + s + K; }${PS_PASS}`);
    const ctx = newEmitContext(c, 'fragment', new Diagnostics());
    const st = bodyOf(c, 'PS')[0] as { kind: 'return'; value: Expr };
    expect(emitExpr(st.value, ctx)).toBe('vec4(u + s + K)');
    expect([...ctx.usedGlobals]).toEqual(['u', 's', 'K']);
  });
});

// 組み込み関数ごとに型の合う引数 (out の引数は変数)
const ARG_SETS: { names: string[]; types: Type[] }[] = [
  { names: ['a'], types: [{ k: 'scalar', s: 'float' }] },
  { names: ['a', 'b'], types: [{ k: 'scalar', s: 'float' }, { k: 'scalar', s: 'float' }] },
  { names: ['a', 'b', 'c'], types: [{ k: 'scalar', s: 'float' }, { k: 'scalar', s: 'float' }, { k: 'scalar', s: 'float' }] },
  { names: ['v3', 'w3'], types: [vectorOf('float', 3), vectorOf('float', 3)] },
  { names: ['v4'], types: [vectorOf('float', 4)] },
  { names: ['M'], types: [M44] },
];
function intrinsicArgs(name: string): string[] {
  const tex = /^tex(1D|2D|3D|CUBE)(lod|bias|proj|grad)?$/.exec(name);
  if (tex) {
    const s = { '1D': 'S1', '2D': 'S2', '3D': 'S3', CUBE: 'SC' }[tex[1] as '1D'];
    const coord = { '1D': 'a', '2D': 'uv', '3D': 'v3', CUBE: 'v3' }[tex[1] as '1D'];
    if (tex[2] === 'grad') return [s, coord, coord, coord];
    return [s, tex[2] ? 'v4' : coord];
  }
  const set = ARG_SETS.find(x => resolveIntrinsic(name, x.types).ok);
  if (!set) throw new Error(`引数の組がない: ${name}`);
  return set.names;
}

describe('GLSL の書き出し: 組み込み関数の表', () => {
  it('INTRINSIC_NAMES のすべてを、誤りなく書き出せる (表がずれていない)', () => {
    for (const name of INTRINSIC_NAMES) {
      const src = `sampler1D S1; sampler2D S2; sampler3D S3; samplerCUBE SC;
        float4 PS() : COLOR0 { float a = 1, b = 2, c = 3; float2 uv = 0; float3 v3 = 1, w3 = 2; float4 v4 = 1; float4x4 M = 1;
          ${name}(${intrinsicArgs(name).join(', ')}); return 0; }${PS_PASS}`;
      const { ctx } = emitFn(src, 'PS');
      expect(ctx.diags.errors.map(e => `${name}: ${e.code}`)).toEqual([]);
    }
  });
});

describe('GLSL の書き出し: 文と関数', () => {
  it('for の変数を前に出し、2 つ目の for は使い直す', () => {
    const { code } = emitFn(`float4 PS() : COLOR0 { float s = 0; for (int i = 0; i < 3; i++) s += i; for (int i = 1; i < 2; i++) { s += i; } return s; }${PS_PASS}`, 'PS');
    expect(code).toContain([
      'vec4 PS() {',
      '  float s = 0.0;',
      '  int i = 0;',
      '  for (i = 0; i < 3; i++) {',
      '    s += float(i);',
      '  }',
      '  for (i = 1; i < 2; i++) {',
      '    s += float(i);',
      '  }',
      '  return vec4(s);',
      '}',
    ].join('\n'));
  });
  it('初期値のない局所変数は 0 で初期化し、const は外す', () => {
    const { code } = emitFn(`struct S { float a; float2 b; }; float4 PS() : COLOR0 { float3 v; S s; float a[2]; const float k = 2; return v.x + s.a + a[0] + k; }${PS_PASS}`, 'PS');
    expect(code).toContain('  vec3 v = vec3(0.0);\n  S s = S(0.0, vec2(0.0));\n  float[2] a = float[2](0.0, 0.0);\n  float k = 2.0;\n');
  });
  it('if・while・do・switch・clip・discard', () => {
    const { code } = emitFn(`float4 PS(float x : TEXCOORD0) : COLOR0 {
      if (x > 1) x = 1; else if (x < 0) { x = 0; } else x = 2;
      while (x > 0) x -= 1;
      do { x += 1; } while (x < 1);
      switch ((int)x) { case 1: x = 2; break; case 1 + 1: default: x = 3; }
      clip(x); clip(float2(x, x));
      if (x > 5) discard;
      return x; }${PS_PASS}`, 'PS');
    expect(code).toContain([
      '  if (x > 1.0) {',
      '    x = 1.0;',
      '  } else if (x < 0.0) {',
      '    x = 0.0;',
      '  } else {',
      '    x = 2.0;',
      '  }',
      '  while (x > 0.0) {',
      '    x -= 1.0;',
      '  }',
      '  do {',
      '    x += 1.0;',
      '  } while (x < 1.0);',
      '  switch (int(x)) {',
      '  case 1:',
      '    x = 2.0;',
      '    break;',
      '  case 2:',
      '  default:',
      '    x = 3.0;',
      '  }',
      '  if (x < 0.0) discard;',
      '  if (any(lessThan(vec2(x, x), vec2(0.0)))) discard;',
      '  if (x > 5.0) {',
      '    discard;',
      '  }',
    ].join('\n'));
  });
  it('使う関数のプロトタイプを先に書き、既定値を埋め、out はそのまま', () => {
    const { code, ctx } = emitFn(`float g(float a, float b = 2) { return a * b; }
      void h(out float r, inout float q) { r = g(q); }
      float4 PS(uniform float k = 1) : COLOR0 { float r; float q = k; h(r, q); return r; }${PS_PASS}`, 'PS');
    expect(code.indexOf('float g(float a, float b);')).toBeLessThan(code.indexOf('float g(float a, float b) {'));
    expect(code).toContain('vec4 PS(float k);');
    expect(code).toContain('void h(out float r, inout float q);');
    expect(code).toContain('  r = g(q, 2.0);');
    expect([...ctx.usedFunctions].map(f => f.decl.name)).toEqual(['PS', 'h', 'g']);
  });
  it('構造体は使うものだけ、中で使う構造体を先に', () => {
    const { ctx } = emitFn(`struct A { float x; }; struct U { float y; }; struct B { A a; float3 input; };
      float4 PS() : COLOR0 { B b = (B)0; return b.a.x + b.input.x; }${PS_PASS}`, 'PS');
    expect(emitStructs(ctx)).toBe('struct A {\n  float x;\n};\n\nstruct B {\n  A a;\n  vec3 input_;\n};\n');
  });
  it('(S)0 は成分ごとに 0 を入れる', () => {
    const { code } = emitFn(`struct A { float x; int2 n; }; struct B { A a; float3x3 m; };
      float4 PS() : COLOR0 { B b = (B)0; return b.a.x; }${PS_PASS}`, 'PS');
    expect(code).toContain('B b = B(A(0.0, ivec2(0)), mat3(0.0));');
  });
  it('配列の配列は 1 次元にして書き、a[i][j] は a[i * M + j] にする (GLSL ES 3.00 に配列の配列はない)', () => {
    const { code, ctx } = emitFn(`float2 K[2][3]; float2 f(float2 k[2][3], int i) { return k[i][1]; }
      float4 PS(float2 uv : TEXCOORD0) : COLOR0 {
        static const float W[2][2] = { 1, 2, 3, 4 }; float L[2][3]; int i = (int)uv.x; uint u = 1;
        L[i][u] = W[1][i]; return float4(K[i][2] + f(K, i), L[1][0], W[i + 1][0]);
      }${PS_PASS}`, 'PS');
    expect(code).toContain('vec2 f(vec2[6] k, int i) {\n  return k[i * 3 + 1];');
    expect(code).toContain('float[4] W = float[4](1.0, 2.0, 3.0, 4.0);');
    expect(code).toContain('float[6] L = float[6](0.0, 0.0, 0.0, 0.0, 0.0, 0.0);');
    expect(code).toContain('L[i * 3 + int(u)] = W[1 * 2 + i];');
    expect(code).toContain('K[i * 3 + 2] + f(K, i), L[1 * 3 + 0], W[(i + 1) * 2 + 0]');
    expect(ctx.diags.errors).toEqual([]);
    // 配列の配列の一部を値として使うことには対応しない
    expect(emitFn(`float K[2][3]; float g(float k[3]) { return k[0]; } float4 PS() : COLOR0 { return g(K[1]); }${PS_PASS}`, 'PS').ctx.diags.errors.map(e => e.code))
      .toEqual(['FX-UNSUPPORTED']);
  });
  it('helpers は使ったものだけ', () => {
    const { ctx } = emitFn(`float4 PS(float x : TEXCOORD0) : COLOR0 { return fmod(x, 2); }${PS_PASS}`, 'PS');
    const h = emitHelpers(ctx);
    expect(h).toContain('float mme_fmod(float a, float b)');
    expect(h).toContain('vec4 mme_fmod(vec4 a, vec4 b)');
    expect(h).not.toContain('mme_idiv');
  });
  it('書き出した関数は GLSL ES 3.00 として読める', () => {
    const { glsl } = shaderOf(`float4 Color; float Scale; sampler2D Samp; float4x4 WVP; float3 input;
      struct VO { float4 Pos; float2 Tex; float3 smooth; };
      float3 helper(float3 v, int n) { float3 r; for (int i = 0; i < n; i++) { r += v * i; } for (int i = 0; i < 2; i++) r %= 2; return r; }
      float idiv(int a, int b) { int m = a % b; m /= 2; return a / b + m; }
      VO make(float4 p) { VO o = (VO)0; o.Pos = mul(p, WVP); o.Tex = p.xy; o.smooth = input; return o; }
      float4 PS(float2 uv : TEXCOORD0, float4 p : TEXCOORD1) : COLOR0 {
        VO o = make(p);
        float s; float c; sincos(uv.x, s, c);
        float3x3 m = (float3x3)WVP; m *= m;
        float4 t = tex2D(Samp, uv) * Color;
        bool2 b = uv > 0.5 && uv < 1;
        clip(t.a - 0.5);
        float3 h = helper(t.rgb, 3) + lit(s, c, Scale).xyz + ddy(uv.x) + (b.x ? 1 : 0);
        h.xy = any(t) ? uv.xx : float2(fmod(s, c), idiv(3, 2));
        return float4(h, t.a) + o.Pos + tex2Dlod(Samp, float4(o.Tex, 0, 0)) + D3DCOLORtoUBYTE4(t).x;
      }${PS_PASS}`, 'PS');
    expect(() => parser.parse(glsl, { quiet: true, failOnWarn: true, stage: 'fragment' })).not.toThrow();
    expect(glsl).toContain('vec3 smooth_;');
    expect(glsl).toContain('uniform vec3 input_;');
  });
});
