import { describe, expect, it } from 'vitest';
import { check } from './check.ts';
import { applyCompat } from './compat.ts';
import { Diagnostics } from './diagnostics.ts';
import { emitFunctions, newEmitContext } from './emit.ts';
import { parse } from './parser.ts';
import { preprocess } from './preprocess.ts';

// Ray-MMD 1.5.2 の Shader/PhaseFunctions.fxsub のとおりの関数 (U - 2.0 の書き方)。PI は自分で宣言する
const MIE = (exponent: string) => `static const float PI = 3.14159265;
static const float PI_2 = 6.2831853;
float3 ComputeWaveLengthMie(float3 lambda, float3 K, float T, float U = 4)
{
\tfloat c_pi = (0.6544 * T - 0.6510) * 1e-16 * PI;
\tfloat mieConst = 0.434 * c_pi * pow(PI_2, U - 2.0);
\treturn mieConst * K / pow(lambda, ${exponent});
}
float4 PS(float3 l : TEXCOORD0) : COLOR0 { return float4(ComputeWaveLengthMie(l, 1.0, 100.0), 1) + pow(l.x, l.y); }
technique T { pass P { PixelShader = compile ps_3_0 PS(); } }`;

// 前処理 (applyCompat はここで当たる) → 構文解析 → 型チェック → PS を GLSL にしたもの
function glslOf(src: string): { code: string } {
  const diags = new Diagnostics();
  const tokens = preprocess('f.fx', { readFile: p => (p === 'f.fx' ? new TextEncoder().encode(src) : null) }, {}, diags);
  const c = check(parse(tokens, diags), diags);
  if (diags.errors.length > 0) throw new Error(diags.errors.map(e => `${e.code}: ${e.message}`).join('\n'));
  const info = c.functions.find(f => f.decl.name === 'PS')!;
  return { code: emitFunctions([info], newEmitContext(c, 'fragment', new Diagnostics())) };
}

describe('D3D9 に合わせたソースの書き換え (compat)', () => {
  it('Ray-MMD の ComputeWaveLengthMie: pow(lambda, U - 2.0) を lambda にする (U - 2 の書き方も)', () => {
    for (const exponent of ['U - 2.0', 'U - 2', 'U-2.0f', 'V - 2.0']) {
      const { code } = glslOf(MIE(exponent));
      expect(code, exponent).toContain('mieConst * K / lambda');
      expect(code, exponent).not.toContain('pow(abs(lambda');
    }
  });

  it('ほかの pow は、いままでどおり pow(abs(x), y)。Ray-MMD の別の pow (PI_2 の累乗) も変えない', () => {
    const { code } = glslOf(MIE('U - 2.0'));
    expect(code).toContain('pow(abs(l.x), l.y)');
    expect(code).toContain('pow(abs(PI_2), U - 2.0)');
  });

  it('同じ行の中だけを書き換えるので、行は増えも減りもしない', () => {
    const src = MIE('U - 2.0');
    const out = applyCompat(src);
    expect(out).not.toBe(src);
    expect(out.split('\n').length).toBe(src.split('\n').length);
    expect(out.split('\n').map((l, i) => (l === src.split('\n')[i] ? 0 : 1)).reduce((a: number, b: number) => a + b, 0)).toBe(1);
    // 診断の行番号: 書き換えた行の次の行の誤りが、同じ行で報告される
    const bad = MIE('U - 2.0').replace('technique', 'float x = nothing;\ntechnique');
    const d = new Diagnostics();
    const tokens = preprocess('f.fx', { readFile: () => new TextEncoder().encode(bad) }, {}, d);
    check(parse(tokens, d), d);
    expect(d.errors.length).toBeGreaterThan(0);
    expect(d.errors[0].line).toBe(bad.split('\n').findIndex(l => l.startsWith('float x')) + 1);
  });

  it('パターンのない文字列は、そのまま (同じ文字列) 返す', () => {
    const plain = 'float3 f(float3 a) { return 2.0 * a / pow(a, 2.0); }\nfloat4 g;';
    expect(applyCompat(plain)).toBe(plain);
    // lambda でも mieConst * K でもないものは当たらない
    const near = 'float3 f(float3 lambda, float3 K) { return mieConst * K / pow(lambda, 3.0); }';
    expect(applyCompat(near)).toBe(near);
  });
});
