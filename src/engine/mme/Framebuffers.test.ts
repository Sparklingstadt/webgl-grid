import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { compileEffect, type EffectDesc } from '../../core/fx/index.ts';
import { CANVAS, resolveSurface, targetSampling, type ColorTarget, type DepthTarget, type Surface } from './Framebuffers.ts';

const SHADERS = 'float4 VS(float4 p : POSITION) : POSITION { return p; } float4 PS() : COLOR0 { return 1; } technique T { pass P { VertexShader = compile vs_3_0 VS(); PixelShader = compile ps_3_0 PS(); } }';

function desc(decls: string): EffectDesc {
  const src = `${decls}\n${SHADERS}`;
  const r = compileEffect('a.fx', p => (p === 'a.fx' ? new TextEncoder().encode(src) : null));
  if (!r.ok) throw new Error(r.errors.map(e => `${e.code}: ${e.message}`).join('\n'));
  return r.effect;
}

const color = (name: string, width = 320, height = 240): ColorTarget => ({ kind: 'color', name, width, height } as ColorTarget);
const depth = (name: string, width = 320, height = 240): DepthTarget => ({ kind: 'depth', name, width, height } as DepthTarget);
const NONE = { colors: [false, false, false, false], depth: false };

describe('targetSampling', () => {
  it('最初のサンプラーの設定。書いていない設定は LINEAR・CLAMP', () => {
    const d = desc(`texture2D RT : RENDERCOLORTARGET;
sampler S1 = sampler_state { texture = <RT>; MinFilter = POINT; AddressV = WRAP; };
sampler S2 = sampler_state { texture = <RT>; MinFilter = POINT; AddressV = WRAP; };`);
    expect(targetSampling(d, 'RT', false)).toEqual({
      minFilter: THREE.NearestFilter, magFilter: THREE.LinearFilter, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.RepeatWrapping, warnings: [],
    });
  });

  it('読むサンプラーがなければ LINEAR・CLAMP', () => {
    expect(targetSampling(desc('texture2D RT : RENDERCOLORTARGET;'), 'RT', true)).toEqual({
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping, warnings: [],
    });
  });

  it('ミップマップがあり MipFilter = LINEAR なら LinearMipmapLinear。ミップマップがなければ MipFilter を見ない', () => {
    const d = desc(`texture2D RT : RENDERCOLORTARGET < int MipLevels = 0; >;
sampler S = sampler_state { texture = <RT>; MinFilter = LINEAR; MipFilter = LINEAR; };`);
    expect(targetSampling(d, 'RT', true).minFilter).toBe(THREE.LinearMipmapLinearFilter);
    expect(targetSampling(d, 'RT', false).minFilter).toBe(THREE.LinearFilter);
  });

  it('違う設定のサンプラーで読むと最初のものにして警告。BORDER は CLAMP にして警告', () => {
    const d = desc(`texture2D RT : RENDERCOLORTARGET;
sampler S1 = sampler_state { texture = <RT>; MinFilter = POINT; MagFilter = POINT; AddressU = BORDER; };
sampler S2 = sampler_state { texture = <RT>; MinFilter = LINEAR; };`);
    const s = targetSampling(d, 'RT', false);
    expect([s.minFilter, s.magFilter, s.wrapS]).toEqual([THREE.NearestFilter, THREE.NearestFilter, THREE.ClampToEdgeWrapping]);
    expect(s.warnings).toEqual([
      'サンプラー S1: AddressU = BORDER は GL にないので CLAMP にします',
      'レンダーターゲット RT を違う設定のサンプラーで読んでいます。最初のサンプラー S1 の設定にします',
    ]);
  });
});

describe('resolveSurface', () => {
  const scn = color('ScnMap'), half = color('Half', 160, 120), b = color('B'), db = depth('DepthBuffer');

  it('名前がなければ既定の描画先そのまま (外側のエフェクトの MRT も)', () => {
    const outer: Surface = { kind: 'targets', colors: [scn, b], depth: db };
    expect(resolveSurface(outer, [null, null, null, null], null, NONE)).toEqual({ surface: outer, warnings: [] });
    expect(resolveSurface(CANVAS, [null, null, null, null], null, NONE)).toEqual({ surface: CANVAS, warnings: [] });
  });

  it('自分のターゲットと深度。深度が既定なら、canvas の内側では共有の深度 (null)、外側のエフェクトの中ではその深度', () => {
    expect(resolveSurface(CANVAS, [scn, null, null, null], db, { colors: [true, false, false, false], depth: true }).surface)
      .toEqual({ kind: 'targets', colors: [scn], depth: db });
    expect(resolveSurface(CANVAS, [scn, null, null, null], null, { colors: [true, false, false, false], depth: false }).surface)
      .toEqual({ kind: 'targets', colors: [scn], depth: null });
    const outer: Surface = { kind: 'targets', colors: [scn], depth: db };
    expect(resolveSurface(outer, [b, null, null, null], null, { colors: [true, false, false, false], depth: false }).surface)
      .toEqual({ kind: 'targets', colors: [b], depth: db });
  });

  it('既定の COLOR0 (外側のエフェクトのターゲット) と自分の COLOR1', () => {
    const outer: Surface = { kind: 'targets', colors: [scn], depth: null };
    expect(resolveSurface(outer, [null, b, null, null], null, { colors: [false, true, false, false], depth: false }).surface)
      .toEqual({ kind: 'targets', colors: [scn, b], depth: null });
  });

  it('canvas と自分のターゲットは混ぜられないので既定の描画先だけ (警告)', () => {
    const r = resolveSurface(CANVAS, [null, b, null, null], db, { colors: [false, true, false, false], depth: true });
    expect(r.surface).toBe(CANVAS);
    expect(r.warnings).toHaveLength(1);
  });

  it('大きさの違う色のターゲットは使わず、大きさの違う深度は共有の深度にする (警告)', () => {
    const r = resolveSurface(CANVAS, [half, scn, null, null], db, { colors: [true, true, false, false], depth: true });
    expect(r.surface).toEqual({ kind: 'targets', colors: [half], depth: null });
    expect(r.warnings).toEqual([
      'レンダーターゲット ScnMap の大きさが RenderColorTarget0 と違うので使いません',
      '深度のターゲット DepthBuffer の大きさが色のターゲットと違うので、同じ大きさの深度を使います',
    ]);
  });
});
