import { describe, expect, it } from 'vitest';
import { compileEffect } from '../fx/index.ts';
import type { EffectDesc } from '../fx/index.ts';
import { pickTechnique, subsetMatcher, type TechniqueQuery } from './technique.ts';

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
  it('空白を許し、壊れた項は無視する', () => {
    const m = subsetMatcher(' 1 - 2 , x, 7 ');
    expect([0, 1, 2, 3, 7].map(m)).toEqual([false, true, true, false, true]);
    expect(subsetMatcher('')(0)).toBe(false);
  });
});
