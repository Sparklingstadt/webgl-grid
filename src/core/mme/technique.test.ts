import { describe, expect, it } from 'vitest';
import { compileEffect } from '../fx/index.ts';
import type { EffectDesc } from '../fx/index.ts';
import { pickPostTechnique, pickTechnique, scriptOrder, subsetMatcher, type TechniqueQuery } from './technique.ts';

const FUNCS = 'float4 VS(float4 p : POSITION) : POSITION { return p; } float4 PS() : COLOR0 { return 1; }';
const PASS = 'pass P { VertexShader = compile vs_3_0 VS(); PixelShader = compile ps_3_0 PS(); }';

// technique の宣言 (注釈つき) を小さな HLSL にしてコンパイルする
function compile(techniques: string): EffectDesc {
  const src = `${FUNCS} ${techniques}`;
  const r = compileEffect('a.fx', p => (p === 'a.fx' ? new TextEncoder().encode(src) : null));
  if (!r.ok) throw new Error(r.errors.map(e => `${e.code}: ${e.message}`).join('\n'));
  return r.effect;
}

const BASE: TechniqueQuery = { pass: 'object', subset: 0, useTexture: false, useSphereMap: false, useToon: false, selfShadow: false };

describe('pickTechnique', () => {
  const fx = compile(`
    technique T0 < string MMDPass = "object"; bool UseTexture = false; > { ${PASS} }
    technique T1 < string MMDPass = "object"; bool UseTexture = true; string Subset = "0-1"; > { ${PASS} }
    technique T2 < string MMDPass = "edge"; > { }`);
  const pick = (q: Partial<TechniqueQuery>) => pickTechnique(fx, { ...BASE, ...q });

  it('MMDPass・Subset・UseTexture で選ぶ', () => {
    expect(pick({ pass: 'object', subset: 0, useTexture: true })?.name).toBe('T1');
    expect(pick({ pass: 'object', subset: 2, useTexture: true })).toBeNull();
    expect(pick({ pass: 'edge' })?.passes).toEqual([]);
    expect(pick({ pass: 'object_ss', subset: 0, useTexture: false })?.name).toBe('T0'); // object_ss がなければ object
  });

  it('宣言の順で最初に合うものを返し、注釈名は大文字小文字を問わない', () => {
    const e = compile(`
      technique A < string mmdpass = "object"; bool usetoon = true; > { ${PASS} }
      technique B < string MMDPass = "object"; > { ${PASS} }`);
    expect(pickTechnique(e, { ...BASE, useToon: true })?.name).toBe('A');
    expect(pickTechnique(e, { ...BASE, useToon: false })?.name).toBe('B');
  });

  it('MMDPass がなければ object、UseSphereMap・UseSelfShadow も見る', () => {
    const e = compile(`
      technique A < bool UseSphereMap = true; bool UseSelfShadow = true; > { ${PASS} }
      technique B { ${PASS} }`);
    expect(pickTechnique(e, { ...BASE, useSphereMap: true, selfShadow: true })?.name).toBe('A');
    expect(pickTechnique(e, { ...BASE, useSphereMap: true, selfShadow: false })?.name).toBe('B');
    expect(pickTechnique(e, { ...BASE, pass: 'zplot' })).toBeNull();
  });

  it('object_ss の technique があればそちらを優先する', () => {
    const e = compile(`
      technique A < string MMDPass = "object"; > { ${PASS} }
      technique B < string MMDPass = "object_ss"; > { ${PASS} }`);
    expect(pickTechnique(e, { ...BASE, pass: 'object_ss' })?.name).toBe('B');
    expect(pickTechnique(e, { ...BASE, pass: 'object' })?.name).toBe('A');
  });

  it('object_ss から object に戻っても、ほかの条件は守る', () => {
    const e = compile(`
      technique A < string MMDPass = "object"; bool UseToon = true; > { ${PASS} }
      technique B < string MMDPass = "object"; string Subset = "1"; > { ${PASS} }`);
    expect(pickTechnique(e, { ...BASE, pass: 'object_ss', useToon: false, subset: 0 })).toBeNull();
    expect(pickTechnique(e, { ...BASE, pass: 'object_ss', useToon: true, subset: 0 })?.name).toBe('A');
    expect(pickTechnique(e, { ...BASE, pass: 'object_ss', useToon: false, subset: 1 })?.name).toBe('B');
  });

  it('MMDPass の値は大文字小文字・前後の空白を問わない', () => {
    const e = compile(`technique A < string MMDPass = " Object_SS "; > { ${PASS} }`);
    expect(pickTechnique(e, { ...BASE, pass: 'object_ss' })?.name).toBe('A');
  });

  it('object_ss 以外は object に戻らない', () => {
    const e = compile(`technique A < string MMDPass = "object"; > { ${PASS} }`);
    expect(pickTechnique(e, { ...BASE, pass: 'shadow' })).toBeNull();
  });
});

describe('subsetMatcher', () => {
  it('範囲・単独・開いた範囲', () => {
    const m = subsetMatcher('0-3,5,8-');
    expect([0, 3, 4, 5, 7, 8, 99].map(m)).toEqual([true, true, false, true, false, true, true]);
  });
  it('開いた範囲・逆向きの範囲・先頭のない範囲', () => {
    expect([5, 6, 100].map(subsetMatcher('6-'))).toEqual([false, true, true]);
    expect([1, 2, 3].map(subsetMatcher('3-1'))).toEqual([false, false, false]);
    expect([0, 3].map(subsetMatcher('-3'))).toEqual([false, false]);
  });
  it('空白を許し、壊れた項は無視する', () => {
    const m = subsetMatcher(' 1 - 2 , x, 7 ');
    expect([0, 1, 2, 3, 7].map(m)).toEqual([false, true, true, false, true]);
    expect(subsetMatcher('')(0)).toBe(false);
  });
});

describe('scriptOrder', () => {
  const order = (annos: string) => compile(`float Script : STANDARDSGLOBAL < ${annos} > = 0.8; technique T { ${PASS} }`);

  it('STANDARDSGLOBAL の param の注釈 ScriptOrder を読む (大文字小文字・空白を問わない)', () => {
    expect(scriptOrder(order('string ScriptOrder = "postprocess";'))).toBe('postprocess');
    expect(scriptOrder(order('string ScriptOrder = " PreProcess ";'))).toBe('preprocess');
    expect(scriptOrder(order('string scriptorder = "standard";'))).toBe('standard');
  });

  it('注釈がない・知らない値なら、既定の値 (指定がなければ standard)', () => {
    expect(scriptOrder(order('string ScriptClass = "scene";'))).toBe('standard');
    expect(scriptOrder(order('string ScriptOrder = "later";'))).toBe('standard');
    expect(scriptOrder(compile(`technique T { ${PASS} }`))).toBe('standard');
    expect(scriptOrder(compile(`technique T { ${PASS} }`), 'postprocess')).toBe('postprocess');
    expect(scriptOrder(order('string ScriptClass = "scene";'), 'postprocess')).toBe('postprocess');
  });

  it('STANDARDSGLOBAL でない param の ScriptOrder は読まない', () => {
    const e = compile(`float Other < string ScriptOrder = "preprocess"; > = 0.8; technique T { ${PASS} }`);
    expect(scriptOrder(e)).toBe('standard');
  });
});

describe('pickPostTechnique', () => {
  it('MMDPass のない technique のうち最初のものを選ぶ (MMDPass="object" が先にあっても選ばない)', () => {
    const e = compile(`
      technique Obj < string MMDPass = "object"; > { ${PASS} }
      technique Edge < string MMDPass = "edge"; > { ${PASS} }
      technique Post { ${PASS} }
      technique Post2 { ${PASS} }`);
    expect(pickPostTechnique(e)?.name).toBe('Post');
  });

  it('MMDPass のない technique がなければ null', () => {
    const e = compile(`technique Obj < string MMDPass = "object"; > { ${PASS} }`);
    expect(pickPostTechnique(e)).toBeNull();
  });

  it('technique が 1 つで MMDPass がなければそれ (ふつうのポストエフェクト)', () => {
    expect(pickPostTechnique(compile(`technique Only { ${PASS} }`))?.name).toBe('Only');
  });
});
