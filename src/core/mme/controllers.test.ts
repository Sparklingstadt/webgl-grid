import { describe, expect, it } from 'vitest';
import { compileEffect } from '../fx/index.ts';
import type { EffectDesc } from '../fx/index.ts';
import { controlRefs, isSpecialName, virtualControls } from './controllers.ts';

const FUNCS = 'float4 VS(float4 p : POSITION) : POSITION { return p; } float4 PS() : COLOR0 { return 1; }';
const TECH = ` ${FUNCS} technique T { pass P { VertexShader = compile vs_3_0 VS(); PixelShader = compile ps_3_0 PS(); } }`;

function compile(decl: string): EffectDesc {
  const r = compileEffect('a.fx', p => (p === 'a.fx' ? new TextEncoder().encode(decl + TECH) : null));
  if (!r.ok) throw new Error(r.errors.map(e => `${e.code}: ${e.message}`).join('\n'));
  return r.effect;
}

// Ray-MMD の点光源の宣言
const POINT_LIGHT = `
float mR : CONTROLOBJECT<string name = "(self)"; string item = "R+";>;
float3 mPosition : CONTROLOBJECT<string name = "(self)"; string item = "Position";>;
float mMultiLightP : CONTROLOBJECT<string name = "ray_controller.pmx"; string item = "MultiLight+";>;
`;

describe('controlRefs', () => {
  it('Ray-MMD の点光源の宣言から 3 つの項目を集める', () => {
    expect(controlRefs(compile(POINT_LIGHT))).toEqual([
      { param: 'mR', name: '(self)', item: 'R+', type: 'float' },
      { param: 'mPosition', name: '(self)', item: 'Position', type: 'float3' },
      { param: 'mMultiLightP', name: 'ray_controller.pmx', item: 'MultiLight+', type: 'float' },
    ]);
  });

  it('item がなければ null、float4・float4x4・bool も取る', () => {
    const refs = controlRefs(compile(`
      float4x4 mM : CONTROLOBJECT<string name = "a.pmx";>;
      float4 mC : CONTROLOBJECT<string name = "a.pmx"; string item = "Color";>;
      bool mB : CONTROLOBJECT<string name = "a.pmx"; string item = "Flag";>;`));
    expect(refs.map(r => [r.param, r.item, r.type])).toEqual([
      ['mM', null, 'float4x4'], ['mC', 'Color', 'float4'], ['mB', 'Flag', 'bool'],
    ]);
  });

  it('型が合わないもの・name のないもの・ほかのセマンティクスは捨てる', () => {
    const refs = controlRefs(compile(`
      float2 a : CONTROLOBJECT<string name = "a.pmx";>;
      int b : CONTROLOBJECT<string name = "a.pmx";>;
      float c : CONTROLOBJECT<string item = "X";>;
      float4x4 d : WORLD;
      float e = 1;`));
    expect(refs).toEqual([]);
  });
});

describe('isSpecialName', () => {
  it('(self) と (OffscreenOwner) を、大文字小文字を無視して見分ける', () => {
    expect(isSpecialName('(self)')).toBe(true);
    expect(isSpecialName('(OFFSCREENOWNER)')).toBe(true);
    expect(isSpecialName('(OffscreenOwner)')).toBe(true);
    expect(isSpecialName('ray_controller.pmx')).toBe(false);
  });
});

describe('virtualControls', () => {
  const refs = controlRefs(compile(POINT_LIGHT));
  it('場面にない名前の float の項目だけを返す ((self) は出ない)', () => {
    expect([...virtualControls(refs, () => false)]).toEqual([['ray_controller.pmx', ['MultiLight+']]]);
  });
  it('場面にある名前は出ない', () => {
    expect(virtualControls(refs, n => n === 'ray_controller.pmx').size).toBe(0);
  });
  it('重複なく名前順で、float 以外・item なしは数えない', () => {
    const more = controlRefs(compile(`
      float b : CONTROLOBJECT<string name = "c.pmx"; string item = "B";>;
      float a : CONTROLOBJECT<string name = "c.pmx"; string item = "A";>;
      float a2 : CONTROLOBJECT<string name = "c.pmx"; string item = "A";>;
      float3 p : CONTROLOBJECT<string name = "c.pmx"; string item = "P";>;
      float n : CONTROLOBJECT<string name = "c.pmx";>;
      float3 q : CONTROLOBJECT<string name = "d.pmx"; string item = "Q";>;`));
    expect([...virtualControls(more, () => false)]).toEqual([['c.pmx', ['A', 'B']]]);
  });
});
