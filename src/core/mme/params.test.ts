import { describe, expect, it } from 'vitest';
import { compileEffect } from '../fx/index.ts';
import type { EffectDesc } from '../fx/index.ts';
import { effectParams, paramChannels } from './params.ts';
import type { ParamUi } from './params.ts';

const TECH = ' float4 VS(float4 p : POSITION) : POSITION { return p; } float4 PS() : COLOR0 { return 1; } technique T { pass P { VertexShader = compile vs_3_0 VS(); PixelShader = compile ps_3_0 PS(); } }';

function compile(decl: string): EffectDesc {
  const r = compileEffect('a.fx', p => (p === 'a.fx' ? new TextEncoder().encode(decl + TECH) : null));
  if (!r.ok) throw new Error(r.errors.map(e => `${e.code}: ${e.message}`).join('\n'));
  return r.effect;
}

describe('effectParams', () => {
  it('UIName が label、UIMin・UIMax が範囲になる', () => {
    const ps = effectParams(compile('float Strength < string UIName = "強さ"; float UIMin = 0; float UIMax = 4; > = 1.5;'));
    expect(ps).toEqual([{ name: 'Strength', label: '強さ', type: 'float', init: [1.5], min: 0, max: 4, color: false }]);
  });

  it('UIName がなければ名前、UIMin・UIMax がなければ初期値の 2 倍までの範囲', () => {
    const ps = effectParams(compile('float A = 3; float B = -2; float C = 0.25;'));
    expect(ps.map(p => [p.label, p.min, p.max])).toEqual([['A', 0, 6], ['B', -4, 1], ['C', 0, 1]]);
  });

  it('片方だけ書いてあれば、もう片方は初期値から決める', () => {
    const ps = effectParams(compile('float A < float UIMin = -1; > = 3; float B < float UIMax = 10; > = 3;'));
    expect(ps.map(p => [p.min, p.max])).toEqual([[-1, 6], [0, 10]]);
  });

  it('UIWidget = "Color" の float3・float4 は color、範囲は成分の最小・最大から', () => {
    const ps = effectParams(compile(`
      float3 Col < string UIWidget = "Color"; > = {1, 0.5, 0};
      float4 Tint < string UIWidget = "color"; > = {1, 1, 1, 1};
      float3 NotColor = {1, 0.5, 0};
      float Single < string UIWidget = "Color"; > = 1;`));
    expect(ps.map(p => [p.name, p.color])).toEqual([['Col', true], ['Tint', true], ['NotColor', false], ['Single', false]]);
    expect(ps[0]).toMatchObject({ type: 'float3', init: [1, 0.5, 0], min: 0, max: 2 });
  });

  it('セマンティクスのあるもの・static・初期値のないもの・UIHidden は出ない', () => {
    const ps = effectParams(compile(`
      float4x4 W : WORLD;
      static float s = 1;
      float NoInit;
      float Hidden < bool UIHidden = true; > = 1;
      float Shown < bool UIHidden = false; > = 1;
      float Ok = 2;`));
    expect(ps.map(p => p.name)).toEqual(['Shown', 'Ok']);
  });

  it('int は整数に丸め、bool は 0〜1、float2・float4 もそのまま', () => {
    const ps = effectParams(compile('int N = 3; bool On = true; float2 Uv = {0.5, 2}; float4 V = {1, 2, 3, 4};'));
    expect(ps).toEqual([
      { name: 'N', label: 'N', type: 'int', init: [3], min: 0, max: 6, color: false },
      { name: 'On', label: 'On', type: 'bool', init: [1], min: 0, max: 1, color: false },
      { name: 'Uv', label: 'Uv', type: 'float2', init: [0.5, 2], min: 0, max: 4, color: false },
      { name: 'V', label: 'V', type: 'float4', init: [1, 2, 3, 4], min: 0, max: 8, color: false },
    ]);
  });

  it('int の範囲も整数にする', () => {
    const [p] = effectParams(compile('int N < float UIMin = 0.4; float UIMax = 9.6; > = 3.7;'));
    expect(p).toMatchObject({ init: [3], min: 0, max: 10 });
  });

  it('配列・文字列の初期値・行列は出ない', () => {
    expect(effectParams(compile('float arr[2] = {1, 2}; float4x4 M = {1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1};'))).toEqual([]);
  });
});

describe('paramChannels', () => {
  const p = (type: ParamUi['type'], init: number[]): ParamUi => ({ name: 'Col', label: 'Col', type, init, min: 0, max: 1, color: false });

  it('float・int・bool は 1 つ', () => {
    expect(paramChannels('f1', 'a/b.fx', p('float', [1]))).toEqual(['f1/a/b.fx:Col']);
    expect(paramChannels('f1', 'a/b.fx', p('int', [1]))).toEqual(['f1/a/b.fx:Col']);
    expect(paramChannels('f1', 'a/b.fx', p('bool', [1]))).toEqual(['f1/a/b.fx:Col']);
  });

  it('ベクトルは末尾に :x :y :z :w', () => {
    expect(paramChannels('f1', 'a.fx', p('float2', [0, 0]))).toEqual(['f1/a.fx:Col:x', 'f1/a.fx:Col:y']);
    expect(paramChannels('f1', 'a.fx', p('float3', [0, 0, 0]))).toEqual(['f1/a.fx:Col:x', 'f1/a.fx:Col:y', 'f1/a.fx:Col:z']);
    expect(paramChannels('f1', 'a.fx', p('float4', [0, 0, 0, 0]))).toEqual(['f1/a.fx:Col:x', 'f1/a.fx:Col:y', 'f1/a.fx:Col:z', 'f1/a.fx:Col:w']);
  });
});
