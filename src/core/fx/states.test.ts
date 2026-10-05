import { describe, expect, it } from 'vitest';
import type { Expr, GlobalDecl, StateAssign, TechniqueNode } from './ast.ts';
import { check } from './check.ts';
import { Diagnostics } from './diagnostics.ts';
import { parse } from './parser.ts';
import { preprocess } from './preprocess.ts';
import { normalizeStates, type RenderState } from './states.ts';

// pass のステート (または sampler_state の中) を、前処理 → 構文解析 → 型チェックのあと正規化する
function run(src: string, kind: 'pass' | 'sampler' = 'pass', globals = ''): { states: RenderState[]; diags: Diagnostics } {
  const text = kind === 'pass'
    ? `${globals} technique T { pass P { ${src} } }`
    : `${globals} texture Tex; sampler S = sampler_state { ${src} };`;
  const d = new Diagnostics();
  const tokens = preprocess('f.fx', { readFile: p => (p === 'f.fx' ? new TextEncoder().encode(text) : null) }, {}, d);
  const checked = check(parse(tokens, d), d);
  const diags = new Diagnostics();
  let assigns: StateAssign[];
  if (kind === 'pass') assigns = (checked.file.items.find(i => i.kind === 'technique') as TechniqueNode).passes[0].states;
  else {
    const g = checked.file.items.find((i): i is GlobalDecl => i.kind === 'global' && i.decl.name === 'S') as GlobalDecl;
    assigns = (g.decl.init as Extract<Expr, { kind: 'samplerState' }>).states;
  }
  return { states: normalizeStates(assigns, kind, checked, diags), diags };
}
const statesOf = (src: string, kind: 'pass' | 'sampler' = 'pass', globals = ''): RenderState[] => run(src, kind, globals).states;
const codes = (d: Diagnostics) => d.warnings.map(w => w.code);

describe('描画ステートの正規化', () => {
  it('描画ステートを表の書き方と値に直す', () => {
    expect(statesOf('alphablendenable = TRUE; SrcBlend = srcalpha; CullMode = NONE; ColorWriteEnable = RED|GREEN|BLUE; ZFunc = LESSEQUAL;')).toEqual([
      { name: 'AlphaBlendEnable', value: true }, { name: 'SrcBlend', value: 'SRCALPHA' }, { name: 'CullMode', value: 'NONE' },
      { name: 'ColorWriteEnable', index: 0, value: 7 }, { name: 'ZFunc', value: 'LESSEQUAL' }]);
  });

  it('真偽は TRUE/FALSE (大文字小文字不問)・true/false・数', () => {
    const { states, diags } = run('ZEnable = false; ZWriteEnable = True; AlphaTestEnable = 1; StencilEnable = 0; ScissorTestEnable = FALSE;');
    expect(states.map(s => s.value)).toEqual([false, true, true, false, false]);
    expect(diags.warnings).toEqual([]);
  });

  it('列挙の値は大文字の文字列', () => {
    expect(statesOf('DestBlend = InvSrcAlpha; BlendOp = RevSubtract; FillMode = Wireframe; ShadeMode = Gouraud; StencilPass = IncrSat; CCW_StencilFunc = Always;'))
      .toEqual([
        { name: 'DestBlend', value: 'INVSRCALPHA' }, { name: 'BlendOp', value: 'REVSUBTRACT' }, { name: 'FillMode', value: 'WIREFRAME' },
        { name: 'ShadeMode', value: 'GOURAUD' }, { name: 'StencilPass', value: 'INCRSAT' }, { name: 'CCW_StencilFunc', value: 'ALWAYS' }]);
  });

  it('数のステートは定数に計算する (添字つきの ColorWriteEnable も)', () => {
    expect(statesOf('AlphaRef = 0x80; DepthBias = -0.5; SlopeScaleDepthBias = 1.0 + 2; ColorWriteEnable1 = ALPHA; ColorWriteEnable[3] = RED | ALPHA; BlendFactor = 255;')).toEqual([
      { name: 'AlphaRef', value: 128 }, { name: 'DepthBias', value: -0.5 }, { name: 'SlopeScaleDepthBias', value: 3 },
      { name: 'ColorWriteEnable', index: 1, value: 8 }, { name: 'ColorWriteEnable', index: 3, value: 9 }, { name: 'BlendFactor', value: 255 }]);
  });

  it('const のグローバルは定数として計算する', () => {
    expect(statesOf('AlphaRef = K * 2;', 'pass', 'static const int K = 20;')).toEqual([{ name: 'AlphaRef', value: 40 }]);
  });

  it('サンプラーステートの Texture は名前、BorderColor は数の並び', () => {
    expect(statesOf('Texture = <Tex>; MinFilter = linear; MagFilter = POINT; MipFilter = NONE; AddressU = Clamp; AddressV = MIRROR; AddressW = border; BorderColor = float4(0, 0.5, 1, 1); MaxAnisotropy = 16; MipMapLodBias = -1; SRGBTexture = TRUE;', 'sampler'))
      .toEqual([
        { name: 'Texture', value: 'Tex' }, { name: 'MinFilter', value: 'LINEAR' }, { name: 'MagFilter', value: 'POINT' },
        { name: 'MipFilter', value: 'NONE' }, { name: 'AddressU', value: 'CLAMP' }, { name: 'AddressV', value: 'MIRROR' },
        { name: 'AddressW', value: 'BORDER' }, { name: 'BorderColor', value: [0, 0.5, 1, 1] }, { name: 'MaxAnisotropy', value: 16 },
        { name: 'MipMapLodBias', value: -1 }, { name: 'SRGBTexture', value: true }]);
    expect(statesOf('Texture = (Tex); BorderColor = 0;', 'sampler')).toEqual([{ name: 'Texture', value: 'Tex' }, { name: 'BorderColor', value: 0 }]);
    expect(statesOf('Texture = Tex;', 'sampler')).toEqual([{ name: 'Texture', value: 'Tex' }]);
  });

  it('pass の VertexShader・PixelShader は読み飛ばす', () => {
    const { states, diags } = run('vertexshader = compile vs_3_0 VS(); PixelShader = compile ps_3_0 PS(); ZEnable = FALSE;',
      'pass', 'float4 VS() : POSITION { return 0; } float4 PS() : COLOR0 { return 0; }');
    expect(states).toEqual([{ name: 'ZEnable', value: false }]);
    expect(diags.warnings).toEqual([]);
  });

  it('知らない名前は FX-WARN-STATE で捨てる', () => {
    const { states, diags } = run('Foo = 1; ZEnable = TRUE; Bar2 = 0;');
    expect(states).toEqual([{ name: 'ZEnable', value: true }]);
    expect(codes(diags)).toEqual(['FX-WARN-STATE', 'FX-WARN-STATE']);
    expect(diags.warnings[0]).toMatchObject({ file: 'f.fx', severity: 'warning' });
  });

  it('その場所では使えない名前・値が正しくない名前も FX-WARN-STATE で捨てる', () => {
    const a = run('MinFilter = LINEAR;');
    expect(a.states).toEqual([]);
    expect(codes(a.diags)).toEqual(['FX-WARN-STATE']);
    const b = run('CullMode = SIDEWAYS; SrcBlend = ZERO; ZFunc = 2 + 2; ColorWriteEnable9 = RED; AlphaRef1 = 3;');
    expect(b.states).toEqual([{ name: 'SrcBlend', value: 'ZERO' }]);
    expect(codes(b.diags)).toEqual(['FX-WARN-STATE', 'FX-WARN-STATE', 'FX-WARN-STATE', 'FX-WARN-STATE']);
  });

  it('uniform を使う値は { expr } で FX-WARN-STATE-EXPR', () => {
    const { states, diags } = run('AlphaRef = k * 2; SrcBlend = bm; ZEnable = !flag;', 'pass', 'float k; int bm; bool flag;');
    expect(states).toEqual([
      { name: 'AlphaRef', value: { expr: '(k * 2)' } }, { name: 'SrcBlend', value: { expr: 'bm' } }, { name: 'ZEnable', value: { expr: '!flag' } }]);
    expect(codes(diags)).toEqual(['FX-WARN-STATE-EXPR', 'FX-WARN-STATE-EXPR', 'FX-WARN-STATE-EXPR']);
  });

  it('{ expr } は呼び出し・三項・添字・メンバーも読める形に書き出す', () => {
    const { states } = run('AlphaRef = k > 0 ? max(k, 1) : v.x; DepthBias = m[1] + float2(k, 1).y;', 'pass', 'float k; float4 v; float4 m[2];');
    expect(states).toEqual([
      { name: 'AlphaRef', value: { expr: '(k > 0) ? max(k, 1) : v.x' } }, { name: 'DepthBias', value: { expr: '(m[1] + float2(k, 1).y)' } }]);
  });
});
