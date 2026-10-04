import { parser } from '@shaderfrog/glsl-parser';
import { describe, expect, it } from 'vitest';
import type { TechniqueNode } from './ast.ts';
import { check } from './check.ts';
import type { Program } from './desc.ts';
import { Diagnostics } from './diagnostics.ts';
import { emitProgram, normalizeSemantic } from './entry.ts';
import { parse } from './parser.ts';
import { preprocess } from './preprocess.ts';

const HEADER = ['#version 300 es', 'precision highp float;', 'precision highp int;', 'precision highp sampler2D;', 'precision highp sampler3D;', 'precision highp samplerCube;'];
const VS_SIMPLE = 'float4 VS(float4 p : POSITION) : POSITION { return p; }';
const PASS_BOTH = ' technique T0 { pass P0 { VertexShader = compile vs_3_0 VS(); PixelShader = compile ps_3_0 PS(); } }';

// 前処理 → 構文解析 → 型チェック (誤りがあれば投げる) → 最初の pass の Program
function programWithDiags(src: string): { program: Program | null; diags: Diagnostics } {
  const diags = new Diagnostics();
  const tokens = preprocess('f.fx', { readFile: p => (p === 'f.fx' ? new TextEncoder().encode(src) : null) }, {}, diags);
  const checked = check(parse(tokens, diags), diags);
  if (diags.errors.length > 0) throw new Error(diags.errors.map(e => `${e.code}: ${e.message}`).join('\n'));
  const pass = (checked.file.items.find(i => i.kind === 'technique') as TechniqueNode).passes[0];
  const program = emitProgram(checked, pass, diags);
  // 誤りのない Program は、どれも GLSL として読め、2 つの段階がつながる
  if (program && diags.errors.length === 0) {
    expectParses(program);
    expectLinked(program);
  }
  return { program, diags };
}
// 誤りも警告もない Program
function programOf(src: string): Program {
  const { program, diags } = programWithDiags(src);
  expect([...diags.errors, ...diags.warnings].map(d => `${d.code}: ${d.message}`)).toEqual([]);
  if (!program) throw new Error('program が null');
  return program;
}
const errorCodes = (src: string) => programWithDiags(src).diags.errors.map(e => e.code);
const warningCodes = (src: string) => programWithDiags(src).diags.warnings.map(e => e.code);

// 頂点とフラグメントが GLSL ES 3.00 として読める (宣言のない名前も見つける)
function expectParses(p: Program): void {
  expect(() => parser.parse(p.vertex, { quiet: true, failOnWarn: true, stage: 'vertex' })).not.toThrow();
  expect(() => parser.parse(p.fragment, { quiet: true, failOnWarn: true, stage: 'fragment' })).not.toThrow();
}

// 2 つの段階がつながる: フラグメントの in vec4 v_X には頂点の out vec4 v_X があり、両方にある uniform は同じ宣言
function expectLinked(p: Program): void {
  for (const m of p.fragment.matchAll(/^in vec4 (v_\w+);$/gm)) expect(p.vertex).toContain(`\nout vec4 ${m[1]};\n`);
  const uniforms = (code: string) => new Map([...code.matchAll(/^uniform \S+ (\w+);$/gm)].map(m => [m[1], m[0]]));
  const vs = uniforms(p.vertex);
  for (const [name, line] of uniforms(p.fragment)) if (vs.has(name)) expect(vs.get(name)).toBe(line);
}

const MMD_LIKE = `float4x4 WVP : WORLDVIEWPROJECTION; texture T; sampler S = sampler_state { texture = <T>; };
    struct VO { float4 Pos : POSITION; float2 Tex : TEXCOORD0; };
    VO VS(float4 Pos : POSITION, float2 Tex : TEXCOORD0) { VO o; o.Pos = mul(Pos, WVP); o.Tex = Tex; return o; }
    float4 PS(VO IN) : COLOR0 { return tex2D(S, IN.Tex); }
    technique T0 { pass P0 { VertexShader = compile vs_3_0 VS(); PixelShader = compile ps_3_0 PS(); } }`;

const UNIFORM_ARGS = `float Scale; float4x3 M; texture T; sampler S = sampler_state { texture = <T>; };
    float4 VS(float4 p : POSITION, float2 t : TEXCOORD0, uniform float4x3 m, out float2 uv : TEXCOORD0) : POSITION { uv = t; return float4(mul(p, m), 1); }
    float4 PS(float2 uv : TEXCOORD0, uniform sampler2D s, uniform float k, uniform bool flag = true) : COLOR0 { return flag ? tex2D(s, uv) * k : 0; }
    technique T0 { pass P0 { VertexShader = compile vs_3_0 VS(M); PixelShader = compile ps_3_0 PS(S, Scale * 2); } }`;
const STATICS = `float Time; float Unused; static float Phase = sin(Time) * 0.5; static float Half = 0.5; const float K = 2;
    static float A = 1; static float B = A * 2; static float Z;
    float f(float x) { return x * Time; } static float C = f(3);
    float4 VS(float4 p : POSITION) : POSITION { Z += 1; return p * Phase * Half * K * B * C * Z; }
    float4 PS() : COLOR0 { return Half; }${PASS_BOTH}`;
const MRT = `${VS_SIMPLE} struct PO { float4 c0 : COLOR0; float4 c1 : COLOR1; float c2 : COLOR2; float d : DEPTH; };
    PO PS() { PO o; o.c0 = 1; o.c1 = 2; o.c2 = 3; o.d = 0.5; return o; }${PASS_BOTH}`;
const VS_UV = 'float4 VS(float4 p : POSITION, float2 t : TEXCOORD0, out float2 uv : TEXCOORD0) : POSITION { uv = t; return p; }';
const VPOS = `${VS_UV} float4 PS(float2 vpos : VPOS, float2 uv : TEXCOORD0) : COLOR0 { return float4(vpos, uv); }${PASS_BOTH}`;
const DDY_VFACE = `${VS_UV} float4 PS(float2 uv : TEXCOORD0, float face : VFACE) : COLOR0 { return float4(ddy(uv), face, 1); }${PASS_BOTH}`;

describe('normalizeSemantic', () => {
  it('大文字にし、番号のないものに 0 を付け、POSITION0 などの 0 は取る', () => {
    expect(['texcoord', 'Color', 'BLENDWEIGHT', 'blendindices', 'TEXCOORD1', 'COLOR0', 'TEXCOORD10'].map(normalizeSemantic))
      .toEqual(['TEXCOORD0', 'COLOR0', 'BLENDWEIGHT0', 'BLENDINDICES0', 'TEXCOORD1', 'COLOR0', 'TEXCOORD10']);
    expect(['position0', 'NORMAL0', 'POSITION', 'POSITION1', 'depth0', 'VPOS', 'vface', 'PSize0'].map(normalizeSemantic))
      .toEqual(['POSITION', 'NORMAL', 'POSITION', 'POSITION1', 'DEPTH', 'VPOS', 'VFACE', 'PSIZE']);
  });

  it('D3D10 の SV_Position・SV_Target・SV_Depth は D3D9 の名前にする', () => {
    expect(['SV_Position', 'sv_target', 'SV_Target1', 'SV_Depth', 'SV_Position0', 'SV_Depth0'].map(normalizeSemantic)).toEqual(['POSITION', 'COLOR0', 'COLOR1', 'DEPTH', 'POSITION', 'DEPTH']);
  });
});

describe('pass ごとのシェーダー', () => {
  it('MMD の標準のような pass', () => {
    const p = programOf(MMD_LIKE);
    expect(p.attributes).toEqual([{ semantic: 'POSITION', glslName: 'a_POSITION', type: 'float4' }, { semantic: 'TEXCOORD0', glslName: 'a_TEXCOORD0', type: 'float4' }]);
    expect(p.uniforms.map(u => [u.name, u.kind, u.stages])).toEqual([['WVP', 'value', ['vertex']], ['S', 'sampler', ['fragment']], ['mme_flipY', 'builtin', ['vertex']]]);
    expect(p).toMatchObject({ outputs: 1, uniformVectors: 5 });
    expect(p.vertex).toContain('gl_Position = vec4(');
    expect(p.vertex.split('\n').slice(0, 6)).toEqual(HEADER);
    expect(p.fragment.split('\n').slice(0, 6)).toEqual(HEADER);
    expect(p.uniforms.map(u => [u.glslName, u.type])).toEqual([['WVP', 'float4x4'], ['S', 'sampler2D'], ['mme_flipY', 'float']]);
    // 宣言・main の中身
    expect(p.vertex).toContain('uniform mat4 WVP;\nuniform float mme_flipY;\nin vec4 a_POSITION;\nin vec4 a_TEXCOORD0;\nout vec4 v_TEXCOORD0;\n');
    expect(p.vertex).toContain('VO mme_r = VS(a_POSITION, a_TEXCOORD0.xy);');
    expect(p.vertex).toContain('vec4 mme_pos = mme_r.Pos;\n  gl_Position = vec4(mme_pos.x, mme_pos.y * mme_flipY, 2.0 * mme_pos.z - mme_pos.w, mme_pos.w);');
    expect(p.vertex).toContain('v_TEXCOORD0 = vec4(mme_r.Tex, 0.0, 1.0);');
    expect(p.fragment).toContain('uniform sampler2D S;\nin vec4 v_TEXCOORD0;\nlayout(location = 0) out vec4 o_COLOR0;\n');
    expect(p.fragment).toContain('vec4 mme_r = PS(VO(vec4(0.0), v_TEXCOORD0.xy));\n  o_COLOR0 = mme_r;');
    expect(p.fragment).not.toContain('mme_flipY');
    expect(p.fragment).not.toContain('WVP');
  });

  it('同じ構造体を頂点とフラグメントで使う (POSITION を読まなければ警告なし、読めば FX-WARN-SEMANTIC)', () => {
    const decls = `float4x4 WVP; struct VO { float4 Pos : POSITION; float2 Tex : TEXCOORD0; };
      VO VS(float4 Pos : POSITION, float2 Tex : TEXCOORD0) { VO o; o.Pos = mul(Pos, WVP); o.Tex = Tex; return o; }`;
    const p = programOf(`${decls} float4 PS(VO IN) : COLOR0 { return float4(IN.Tex, 0, 1); }${PASS_BOTH}`);
    expect(p.fragment).not.toContain('v_POSITION');
    expect(p.vertex).not.toContain('v_POSITION');
    expect(warningCodes(`${decls} float4 PS(VO IN) : COLOR0 { return IN.Pos; }${PASS_BOTH}`)).toEqual(['FX-WARN-SEMANTIC']);
    // 構造体を丸ごと渡しても読んだことにする
    expect(warningCodes(`${decls} float4 F(VO v) { return v.Pos; } float4 PS(VO IN) : COLOR0 { return F(IN); }${PASS_BOTH}`)).toEqual(['FX-WARN-SEMANTIC']);
    // 構造体でない POSITION の引数
    expect(warningCodes(`${decls} float4 PS(float4 pos : POSITION) : COLOR0 { return 1; }${PASS_BOTH}`)).toEqual([]);
    expect(warningCodes(`${decls} float4 PS(float4 pos : POSITION) : COLOR0 { return pos; }${PASS_BOTH}`)).toEqual(['FX-WARN-SEMANTIC']);
  });

  it('予約語の名前の uniform と局所変数', () => {
    const p = programOf(`float4 input; ${VS_SIMPLE} float4 PS() : COLOR0 { float4 sample = input; return sample; }${PASS_BOTH}`);
    expect(p.uniforms.find(u => u.name === 'input')).toEqual({ name: 'input', glslName: 'input_', type: 'float4', kind: 'value', stages: ['fragment'] });
    expect(p.fragment).toContain('uniform vec4 input_;');
    expect(p.fragment).toContain('vec4 sample_ = input_;');
  });

  it('MRT と DEPTH', () => {
    const p = programOf(MRT);
    expect(p.outputs).toBe(3);
    for (const n of [0, 1, 2]) expect(p.fragment).toContain(`layout(location = ${n}) out vec4 o_COLOR${n};`);
    expect(p.fragment).toContain('o_COLOR2 = vec4(mme_r.c2, 0.0, 0.0, 1.0);');
    expect(p.fragment).toContain('gl_FragDepth = mme_r.d;');
    // out の引数と、番号のない COLOR
    const q = programOf(`${VS_SIMPLE} void PS(out float4 c : COLOR, out float4 n : COLOR3) { c = 1; n = 0; }${PASS_BOTH}`);
    expect(q.outputs).toBe(4);
    expect(q.fragment).toContain('vec4 mme_p0 = vec4(0.0);\n  vec4 mme_p1 = vec4(0.0);\n  PS(mme_p0, mme_p1);\n  o_COLOR0 = mme_p0;\n  o_COLOR3 = mme_p1;');
    expect(programOf(`${VS_SIMPLE} void PS(out float d : DEPTH) { d = 0; }${PASS_BOTH}`).outputs).toBe(0);
  });

  it('VPOS を使うと mme_viewport が入り、ddy を使うとフラグメントにも mme_flipY', () => {
    const p = programOf(VPOS);
    expect(p.uniforms.map(u => [u.name, u.kind, u.type, u.stages])).toEqual([
      ['mme_flipY', 'builtin', 'float', ['vertex', 'fragment']], ['mme_viewport', 'builtin', 'float2', ['fragment']],
    ]);
    expect(p.uniformVectors).toBe(2);
    expect(p.fragment).toContain('uniform float mme_flipY;\nuniform vec2 mme_viewport;\n');
    expect(p.fragment).toContain('vec2(gl_FragCoord.x - 0.5, (mme_flipY < 0.0 ? gl_FragCoord.y : mme_viewport.y - gl_FragCoord.y) - 0.5)');
    expect(p.vertex).not.toContain('mme_viewport');
    const q = programOf(DDY_VFACE);
    expect(q.uniforms.map(u => [u.name, u.stages])).toEqual([['mme_flipY', ['vertex', 'fragment']]]);
    expect(q.fragment).toContain('PS(v_TEXCOORD0.xy, (gl_FrontFacing ? 1.0 : -1.0))');
    expect(q.uniformVectors).toBe(1);
  });

  it('pass の uniform の引数を main に埋め込む', () => {
    const p = programOf(UNIFORM_ARGS);
    expect(p.vertex).toContain('vec4 mme_r = VS(a_POSITION, a_TEXCOORD0.xy, M, mme_p0);');
    expect(p.fragment).toContain('vec4 mme_r = PS(v_TEXCOORD0.xy, S, Scale * 2.0, true);');
    expect(p.uniforms.map(u => [u.name, u.kind, u.stages])).toEqual([
      ['Scale', 'value', ['fragment']], ['M', 'value', ['vertex']], ['S', 'sampler', ['fragment']], ['mme_flipY', 'builtin', ['vertex']],
    ]);
    expect(p.uniformVectors).toBe(6); // Scale 1 + float4x3 は 4 行 + mme_flipY 1
  });

  it('static の初期値を mme_init で計算する', () => {
    const p = programOf(STATICS);
    expect(p.uniforms.map(u => [u.name, u.stages])).toEqual([['Time', ['vertex']], ['mme_flipY', ['vertex']]]);
    expect(p.vertex).toContain('float Phase = 0.0;\nfloat Half = 0.5;\nconst float K = 2.0;\nfloat B = 2.0;\nfloat Z = 0.0;\nfloat C = 0.0;\n');
    expect(p.vertex).not.toMatch(/float A\b/);
    expect(p.vertex).toContain('void mme_init() {\n  Phase = sin(Time) * 0.5;\n  C = f(3.0);\n}');
    expect(p.vertex).toContain('float f(float x) {');
    expect(p.vertex).toMatch(/void main\(\) \{\n {2}mme_init\(\);\n/);
    // フラグメントは Half だけ (計算の要るものがないので mme_init もない)
    expect(p.fragment).toContain('float Half = 0.5;\n');
    expect(p.fragment).not.toContain('mme_init');
    expect(p.fragment).not.toContain('Time');
  });

  it('定数の初期値はベクトル・行列・配列も値で書く', () => {
    const p = programOf(`const float2 K2 = {1, 2}; static float2x3 R = {1, 2, 3, 4, 5, 6}; static int arr[2] = {3, -4}; static bool on = true;
      float4 VS(float4 p : POSITION) : POSITION { return p * K2.x * R[1].z * arr[1] * on; } float4 PS() : COLOR0 { return 1; }${PASS_BOTH}`);
    expect(p.vertex).toContain('const vec2 K2 = vec2(1.0, 2.0);\nmat2x3 R = mat2x3(1.0, 2.0, 3.0, 4.0, 5.0, 6.0);\nint[2] arr = int[2](3, -4);\nbool on = true;\n');
  });

  it('関数を呼ぶ static の初期値で書き直しても、誤りは 1 回だけ', () => {
    const src = `float Time; float f(float x) { return x * Time; } static float C = f(3);
      float4 VS(float4 p : POSITION, float4 n) : POSITION { return p * C; } float4 PS() : COLOR0 { return 1; }${PASS_BOTH}`;
    expect(errorCodes(src)).toEqual(['FX-PASS-SEMANTIC']);
  });

  it('SV_Position: 頂点の出力は POSITION、ピクセルの入力は VPOS (fxc の ps_3_0 と同じ)', () => {
    const p = programOf(`void VS(float4 p : POSITION, out float4 o : SV_Position) { o = p; }
      float4 PS(float4 sp : SV_Position) : SV_Target { return sp; }${PASS_BOTH}`);
    expect(p.vertex).toContain('gl_Position = vec4(');
    expect(p.fragment).toContain('PS(vec4(vec2(gl_FragCoord.x - 0.5,');
    expect(p.uniforms.map(u => u.name)).toContain('mme_viewport');
    // 番号の付いた SV_Position0・小文字も同じ
    const q = programOf(`void VS(float4 p : POSITION, out float4 o : sv_position0) { o = p; }
      float4 PS(float4 sp : SV_Position0) : SV_Target0 { return sp; }${PASS_BOTH}`);
    expect(q.fragment).toContain('PS(vec4(vec2(gl_FragCoord.x - 0.5,');
  });

  it('PSIZE も実際に読むときだけ FX-WARN-SEMANTIC、VPOS は読むときだけ mme_viewport', () => {
    const decls = `struct VO { float4 Pos : POSITION; float Size : PSIZE; float2 Tex : TEXCOORD0; };
      VO VS(float4 Pos : POSITION, float2 Tex : TEXCOORD0) { VO o; o.Pos = Pos; o.Size = 2; o.Tex = Tex; return o; }`;
    const p = programOf(`${decls} float4 PS(VO IN) : COLOR0 { return float4(IN.Tex, 0, 1); }${PASS_BOTH}`);
    expect(p.vertex).toContain('gl_PointSize = mme_r.Size;');
    expect(p.fragment).toContain('PS(VO(vec4(0.0), 0.0, v_TEXCOORD0.xy))');
    expect(warningCodes(`${decls} float4 PS(VO IN) : COLOR0 { return IN.Size; }${PASS_BOTH}`)).toEqual(['FX-WARN-SEMANTIC']);
    const q = programOf(`${VS_UV} float4 PS(float2 vpos : VPOS, float2 uv : TEXCOORD0) : COLOR0 { return float4(uv, 0, 1); }${PASS_BOTH}`);
    expect(q.uniforms.map(u => [u.name, u.stages])).toEqual([['mme_flipY', ['vertex']]]);
    expect(q.fragment).not.toContain('mme_viewport');
    expect(q.fragment).toContain('PS(vec2(0.0), v_TEXCOORD0.xy)');
  });

  it('頂点とフラグメントで使う関数の誤りは 1 回だけ', () => {
    const src = `float h() { float2x2 m = 0; m._m00_m01 = float2(1, 2); return m[0].x; }
      float4 VS(float4 p : POSITION) : POSITION { return p * h(); } float4 PS() : COLOR0 { return h(); }${PASS_BOTH}`;
    expect(errorCodes(src)).toEqual(['FX-UNSUPPORTED']);
  });

  it('頂点が出していない TEXCOORD3 を読むと vec4(0.0) と FX-WARN-SEMANTIC', () => {
    const src = `${VS_SIMPLE} float4 PS(float4 t : TEXCOORD3) : COLOR0 { return t; }${PASS_BOTH}`;
    const { program, diags } = programWithDiags(src);
    expect(diags.warnings.map(w => w.code)).toEqual(['FX-WARN-SEMANTIC']);
    expect(diags.errors).toEqual([]);
    expect(program?.fragment).toContain('vec4 mme_r = PS(vec4(0.0));');
    expect(program?.fragment).not.toContain('v_TEXCOORD3');
  });

  it('頂点が POSITION を出さない・セマンティクスのない in は FX-PASS-SEMANTIC', () => {
    expect(errorCodes(`float4 VS(float4 p : POSITION) : TEXCOORD0 { return p; } float4 PS() : COLOR0 { return 1; }${PASS_BOTH}`)).toEqual(['FX-PASS-SEMANTIC']);
    expect(errorCodes(`${VS_SIMPLE} float4 PS(float4 t) : COLOR0 { return t; }${PASS_BOTH}`)).toEqual(['FX-PASS-SEMANTIC']);
    expect(errorCodes(`${VS_SIMPLE} float4 PS() { return 1; }${PASS_BOTH}`)).toEqual(['FX-PASS-SEMANTIC']);
    expect(errorCodes(`struct VI { float4 p : POSITION; float4 n; }; float4 VS(VI i) : POSITION { return i.p; } float4 PS() : COLOR0 { return 1; }${PASS_BOTH}`))
      .toEqual(['FX-PASS-SEMANTIC']);
    // 行列の入力は書けない
    expect(errorCodes(`float4 VS(float4x4 m : TEXCOORD1) : POSITION { return m[0]; } float4 PS() : COLOR0 { return 1; }${PASS_BOTH}`)).toEqual(['FX-UNSUPPORTED']);
    // ピクセルシェーダーの出力は COLORn か DEPTH だけ
    expect(errorCodes(`${VS_SIMPLE} float4 PS() : TEXCOORD0 { return 1; }${PASS_BOTH}`)).toEqual(['FX-PASS-SEMANTIC']);
  });

  it('片方だけの pass は FX-UNSUPPORTED、シェーダーのない pass は null', () => {
    const one = programWithDiags(`float4 PS() : COLOR0 { return 1; } technique T0 { pass P0 { PixelShader = compile ps_3_0 PS(); } }`);
    expect(one.program).toBeNull();
    expect(one.diags.errors.map(e => e.code)).toEqual(['FX-UNSUPPORTED']);
    const none = programWithDiags('technique T0 { pass P0 { ZEnable = FALSE; } }');
    expect(none.program).toBeNull();
    expect(none.diags.errors).toEqual([]);
  });

  it('書き出した頂点とフラグメントは GLSL ES 3.00 として読める', () => {
    for (const src of [MMD_LIKE, UNIFORM_ARGS, STATICS, MRT, VPOS, DDY_VFACE]) expectParses(programOf(src));
  });
});

describe('向きのないサンプラーの引数', () => {
  it('使い方から決めた向きで引数を書き、渡すグローバルのサンプラーも同じ向きにする', () => {
    const p = programOf(`sampler S; float4 env(sampler s, float3 d) { return texCUBE(s, d); }
      ${VS_SIMPLE} float4 PS() : COLOR0 { return env(S, float3(0, 0, 1)); }${PASS_BOTH}`);
    expect(p.fragment).toContain('vec4 env(samplerCube s, vec3 d)');
    expect(p.fragment).toContain('uniform samplerCube S;');
  });
});
