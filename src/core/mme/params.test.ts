import { describe, expect, it } from 'vitest';
import { compileEffect } from '../fx/index.ts';
import type { EffectDesc } from '../fx/index.ts';
import { effectParams, fitParam, paramChannels, paramRange, paramValues } from './params.ts';
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

describe('paramRange・fitParam', () => {
  const p = (type: ParamUi['type'], init: number[], min = 0, max = 1): ParamUi => ({ name: 'P', label: 'P', type, init, min, max, color: false });

  it('範囲がそのままなら [min, max]。入れ替わっていたら (UIMax だけ負の値を書いたときなど) 入れ替える', () => {
    expect(paramRange(p('float', [0], -1, 4))).toEqual([-1, 4]);
    expect(paramRange(p('float', [0], 0, -1))).toEqual([-1, 0]);
    const [neg] = effectParams(compile('float A < float UIMax = -1; > = 0;'));
    expect(paramRange(neg)).toEqual([-1, 0]);
  });

  it('成分ごとに範囲に収める。数でない成分・足りない成分は初期値、多い成分は捨てる', () => {
    expect(fitParam(p('float', [0.5], 0, 2), [3])).toEqual([2]);
    expect(fitParam(p('float', [0.5], 0, 2), [-1])).toEqual([0]);
    expect(fitParam(p('float3', [1, 0.5, 0], 0, 1), [Number.NaN, 2, Number.POSITIVE_INFINITY])).toEqual([1, 1, 0]);
    expect(fitParam(p('float2', [0.25, 0.75]), [0.5])).toEqual([0.5, 0.75]);
    expect(fitParam(p('float', [0.5]), [0.1, 0.2])).toEqual([0.1]);
    expect(fitParam(p('float', [0], 0, -1), [-0.5])).toEqual([-0.5]); // (入れ替えた範囲)
  });

  it('int は丸め、bool は 0 か 1 (0.5 から 1)', () => {
    expect(fitParam(p('int', [3], 0, 6), [2.6])).toEqual([3]);
    expect(fitParam(p('int', [3], 0, 6), [9])).toEqual([6]);
    expect(fitParam(p('bool', [1]), [0.4])).toEqual([0]);
    expect(fitParam(p('bool', [0]), [0.5])).toEqual([1]);
    expect(fitParam(p('bool', [0]), [7])).toEqual([1]);
  });
});

describe('paramValues', () => {
  const ps = effectParams(compile('float Strength < float UIMin = 0; float UIMax = 4; > = 1; float3 Col = {1, 0, 0}; int N = 2;'));
  const list = ps.map(param => ({ param, channels: paramChannels('f1', 'a.fx', param) }));

  it('チャンネルの名前で物の値を引き、値のあるパラメータだけを入れる (範囲に収める)', () => {
    expect(paramValues(list, {})).toEqual(new Map());
    expect(paramValues(list, { 'f1/a.fx:Strength': 9, 'f1/a.fx:N': 1.2, 'f1/b.fx:Strength': 2, Si: 1 })).toEqual(new Map([['Strength', [4]], ['N', [1]]]));
  });

  it('ベクトルは一部の成分だけ値があれば、ほかの成分は初期値', () => {
    expect(paramValues(list, { 'f1/a.fx:Col:y': 0.5 })).toEqual(new Map([['Col', [1, 0.5, 0]]]));
  });
});
