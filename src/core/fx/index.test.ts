import { describe, expect, it } from 'vitest';
import { encodeShiftJis } from '../sjis.ts';
import { compileEffect, type EffectResult } from './index.ts';

// 見本の .fx (fixtures/ の下) をそのまま読む
const raw = import.meta.glob('./fixtures/**/*', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const FILES = new Map(Object.entries(raw).map(([k, v]) => [k.replace('./fixtures/', ''), new TextEncoder().encode(v)]));

function compileFixture(entry: string): EffectResult {
  return compileEffect(entry, p => FILES.get(p) ?? null, { listFiles: () => [...FILES.keys()] });
}

function readerOf(files: Record<string, string | Uint8Array>): (path: string) => Uint8Array | null {
  return p => {
    const f = files[p];
    return f === undefined ? null : typeof f === 'string' ? new TextEncoder().encode(f) : f;
  };
}

const FUNCS = 'float4 VS(float4 p : POSITION) : POSITION { return p; } float4 PS() : COLOR0 { return 1; }';
const MINIMAL_TECHNIQUE = ` ${FUNCS} technique T { pass P { VertexShader = compile vs_3_0 VS(); PixelShader = compile ps_3_0 PS(); } }`;

function ok(r: EffectResult) {
  if (!r.ok) throw new Error(r.errors.map(e => `${e.code}@${e.file}:${e.line}: ${e.message}`).join('\n'));
  return r;
}

describe('compileEffect', () => {
  it('MMD の標準のようなエフェクト (basic.fx)', () => {
    const r = ok(compileFixture('basic.fx'));
    expect(r.effect.params).toContainEqual(expect.objectContaining({ name: 'WorldViewProjMatrix', semantic: 'WORLDVIEWPROJECTION', type: 'float4x4', storage: 'uniform', init: null }));
    expect(r.effect.params.map(p => p.name)).toEqual(expect.arrayContaining(['DiffuseColor', 'LightDirection']));
    expect(r.effect.textures).toEqual([{ name: 'ObjectTexture', type: 'texture', semantic: 'MATERIALTEXTURE', annotations: [] }]);
    expect(r.effect.samplers).toEqual([expect.objectContaining({ name: 'ObjTexSampler', dim: '2D', texture: 'ObjectTexture' })]);
    expect(r.effect.samplers[0].states.map(s => s.name)).not.toContain('Texture');
    expect(r.effect.samplers[0].states).toContainEqual({ name: 'MinFilter', value: 'LINEAR' });
    expect(r.effect.techniques.map(t => t.annotations[0])).toEqual([
      { name: 'MMDPass', type: 'string', value: 'object' },
      { name: 'MMDPass', type: 'string', value: 'object_ss' },
    ]);
    for (const t of r.effect.techniques) {
      expect(t.passes[0].program).not.toBeNull();
      expect(t.passes[0].program?.vertex.startsWith('#version 300 es\n')).toBe(true);
    }
    expect(r.warnings).toEqual([]);
  });

  it('ポストエフェクト (post.fx): STANDARDSGLOBAL・RENDERCOLORTARGET の注釈・Script・pass の引数', () => {
    const r = ok(compileFixture('post.fx'));
    const e = r.effect;
    expect(e.params).toContainEqual(expect.objectContaining({ name: 'Script', semantic: 'STANDARDSGLOBAL', type: 'float', init: [0.8] }));
    expect(e.params.find(p => p.name === 'Script')?.annotations).toContainEqual({ name: 'ScriptOrder', type: 'string', value: 'postprocess' });
    const t = e.textures.find(x => x.name === 'T');
    expect(t).toMatchObject({ type: 'texture2D', semantic: 'RENDERCOLORTARGET' });
    expect(t?.annotations).toContainEqual({ name: 'Format', type: 'string', value: 'A8R8G8B8' });
    expect(t?.annotations).toContainEqual({ name: 'ViewportRatio', type: 'float2', value: [1, 1] });
    expect(e.textures.map(x => x.semantic)).toContain('RENDERDEPTHSTENCILTARGET');
    const tech = e.techniques[0];
    expect(tech.annotations.map(a => a.name)).toContain('Script');
    expect(tech.script.slice(0, 2)).toEqual([{ cmd: 'RenderColorTarget', index: 0, value: 'ScnMap' }, { cmd: 'RenderDepthStencilTarget', value: 'DepthBuffer' }]);
    expect(tech.script).toContainEqual({ cmd: 'ScriptExternal', value: 'Color' });
    expect(tech.script).toContainEqual({ cmd: 'LoopByCount', value: 'LoopCount' });
    expect(tech.script).toContainEqual({ cmd: 'Pass', value: 'Blur' });
    expect(tech.passes.map(p => p.name)).toEqual(['Blur', 'Final']);
    expect(tech.passes[0].states).toContainEqual({ name: 'ZEnable', value: false });
    expect(tech.passes[0].program).not.toBeNull();
    expect(tech.passes[0].program?.uniforms.map(u => u.name)).toContain('BlurScale');
    expect(r.warnings).toEqual([]);
  });

  it('MRT (mrt.fx): COLOR0〜2 の出力', () => {
    const r = ok(compileFixture('mrt.fx'));
    expect(r.effect.techniques[0].passes[0].program?.outputs).toBe(3);
  });

  it('Shift-JIS の注釈', () => {
    const r = compileEffect('a.fx', readerOf({ 'a.fx': encodeShiftJis('float b < string UIName = "明るさ"; > = 1;' + MINIMAL_TECHNIQUE) }));
    expect(r.ok && r.effect.params[0].annotations[0]).toEqual({ name: 'UIName', type: 'string', value: '明るさ' });
    expect(r.ok && r.effect.params[0].init).toEqual([1]);
  });

  it('include.fx の #include "inc\\common.FXSUB" を listFiles で見つける', () => {
    const r = ok(compileFixture('include.fx'));
    expect(r.effect.params.map(p => p.name)).toContain('CommonScale');
    expect(r.effect.techniques[0].passes[0].program).not.toBeNull();
    // listFiles がなければ見つからない (大文字小文字が違うので)
    const bad = compileEffect('include.fx', p => FILES.get(p) ?? null);
    expect(!bad.ok && bad.errors[0]).toMatchObject({ code: 'FX-PP-INCLUDE-NOT-FOUND', file: 'include.fx' });
  });

  it('パラメーター: 宣言の順・storage・文字列の init・数の注釈', () => {
    const r = ok(compileEffect('a.fx', readerOf({
      'a.fx': `float A : world; static float4 B = float4(1, 2, 3, 4); const float C = 2; string D = "x" ; bool E < int Count = 3; float2 Range = float2(0, 1); > = true; texture T; sampler S = sampler_state { Texture = <T>; };${MINIMAL_TECHNIQUE}`,
    })));
    expect(r.effect.params.map(p => [p.name, p.storage, p.semantic, p.init])).toEqual([
      ['A', 'uniform', 'WORLD', null], ['B', 'static', null, [1, 2, 3, 4]], ['C', 'const', null, [2]], ['D', 'uniform', null, 'x'], ['E', 'uniform', null, [1]],
    ]);
    expect(r.effect.params[4].annotations).toEqual([{ name: 'Count', type: 'int', value: [3] }, { name: 'Range', type: 'float2', value: [0, 1] }]);
  });

  it('サンプラー: 使われていない dim は 2D・Texture がなければ null', () => {
    const r = ok(compileEffect('a.fx', readerOf({ 'a.fx': `sampler S; textureCUBE TC; sampler SC = sampler_state { Texture = <TC>; AddressU = CLAMP; };${MINIMAL_TECHNIQUE}` })));
    expect(r.effect.samplers).toEqual([
      { name: 'S', glslName: 'S', dim: '2D', texture: null, states: [] },
      { name: 'SC', glslName: 'SC', dim: 'CUBE', texture: 'TC', states: [{ name: 'AddressU', value: 'CLAMP' }] },
    ]);
    expect(r.effect.textures).toEqual([{ name: 'TC', type: 'textureCUBE', semantic: null, annotations: [] }]);
  });

  it('警告だけなら ok: true で warnings に入る', () => {
    const r = ok(compileEffect('a.fx', readerOf({ 'a.fx': `${FUNCS} technique T { pass P { Nope = 1; VertexShader = compile vs_3_0 VS(); PixelShader = compile ps_3_0 PS(); } }` })));
    expect(r.warnings.map(w => w.code)).toEqual(['FX-WARN-STATE']);
  });

  it('vs・ps のない pass の program は null', () => {
    const r = ok(compileEffect('a.fx', readerOf({ 'a.fx': 'technique T { pass P { ZEnable = false; } }' })));
    expect(r.effect.techniques[0].passes[0]).toEqual({ name: 'P', annotations: [], script: [], states: [{ name: 'ZEnable', value: false }], program: null });
  });

  it('誤りがあれば ok: false で、errors の code と場所', () => {
    const r = compileEffect('a.fx', readerOf({ 'a.fx': 'float4 PS() : COLOR0 { return nope; } technique T { pass P { PixelShader = compile ps_3_0 PS(); } }' }));
    expect(r).toMatchObject({ ok: false, errors: [{ code: 'FX-TYPE-UNDEFINED', file: 'a.fx', line: 1 }] });
  });

  it('構文の誤り (FxError) も ok: false で、そのときの警告も返す', () => {
    const r = compileEffect('a.fx', readerOf({ 'a.fx': 'float a = ;' }));
    expect(r).toMatchObject({ ok: false, errors: [{ code: 'FX-PARSE', file: 'a.fx', line: 1 }], warnings: [] });
  });

  it('エントリーのファイルがなければ FX-IO-NOT-FOUND', () => {
    expect(compileEffect('none.fx', () => null)).toMatchObject({ ok: false, errors: [{ code: 'FX-IO-NOT-FOUND', file: 'none.fx' }] });
  });

  it('例外を外に出さない (FX-INTERNAL)', () => {
    const r = compileEffect('a.fx', () => { throw new Error('boom'); });
    expect(r).toMatchObject({ ok: false, errors: [{ code: 'FX-INTERNAL', file: 'a.fx', line: 1, column: 1, severity: 'error' }] });
    expect(!r.ok && r.errors[0].message).toContain('boom');
    // Error でない値が投げられても同じ
    const s = compileEffect('a.fx', () => { throw 'oops'; });
    expect(s).toMatchObject({ ok: false, errors: [{ code: 'FX-INTERNAL' }] });
  });

  it('結果は JSON にしても同じ', () => {
    for (const f of ['basic.fx', 'post.fx', 'mrt.fx', 'include.fx']) {
      const r = compileFixture(f);
      expect(JSON.parse(JSON.stringify(r))).toEqual(r);
    }
  });

  it('何度呼んでも同じ結果 (状態を持たない)', () => {
    expect(compileFixture('post.fx')).toEqual(compileFixture('post.fx'));
  });
});
