import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { compileEffect, type EffectDesc } from '../../core/fx/index.ts';
import type { LoadedEffect } from './EffectStore.ts';
import { CANVAS, Framebuffers, resolveSurface, targetSampling, type ColorTarget, type DepthTarget, type Surface } from './Framebuffers.ts';

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

  it('canvas やセルフシャドウの深度マップと自分のターゲットは混ぜられないので既定の描画先だけ (警告にその名前)', () => {
    const r = resolveSurface(CANVAS, [null, b, null, null], db, { colors: [false, true, false, false], depth: true });
    expect(r.surface).toBe(CANVAS);
    expect(r.warnings).toEqual(['既定の描画先 (canvas) とレンダーターゲットは同時に使えないので、既定の描画先だけに描きます']);
    const shadow: Surface = { kind: 'three', target: new THREE.WebGLRenderTarget(4, 4) };
    expect(resolveSurface(shadow, [null, b, null, null], null, { colors: [false, true, false, false], depth: false }).warnings)
      .toEqual(['既定の描画先 (セルフシャドウの深度マップ) とレンダーターゲットは同時に使えないので、既定の描画先だけに描きます']);
  });

  it('大きさの違う色のターゲットは使わない (警告)', () => {
    const r = resolveSurface(CANVAS, [half, scn, null, null], null, { colors: [true, true, false, false], depth: false });
    expect(r.surface).toEqual({ kind: 'targets', colors: [half], depth: null });
    expect(r.warnings).toEqual(['レンダーターゲット ScnMap の大きさが RenderColorTarget0 と違うので使いません']);
  });

  it('色のターゲットより大きい深度 (D3D では使える) は、黙って同じ大きさの共有の深度にする。小さい深度は警告', () => {
    const big = resolveSurface(CANVAS, [half, null, null, null], db, { colors: [true, false, false, false], depth: true });
    expect(big).toEqual({ surface: { kind: 'targets', colors: [half], depth: null }, warnings: [] });
    // (外側のエフェクトが選んだ大きい深度を、内側の小さいターゲットで既定として使うときも)
    const outer: Surface = { kind: 'targets', colors: [scn], depth: db };
    expect(resolveSurface(outer, [half, null, null, null], null, { colors: [true, false, false, false], depth: false }).warnings).toEqual([]);
    const small = resolveSurface(CANVAS, [scn, null, null, null], depth('Small', 160, 240), { colors: [true, false, false, false], depth: true });
    expect(small.surface).toEqual({ kind: 'targets', colors: [scn], depth: null });
    expect(small.warnings).toEqual(['深度のターゲット Small が色のターゲットより小さいので、同じ大きさの深度を使います']);
  });
});

describe('Framebuffers.prepare', () => {
  // GL を使わない偽の描画先 (拡張は has の答え)。色のテクスチャを作るところまで
  function fake(exts: string[]) {
    const renderer = {
      getContext: () => ({}), extensions: { has: (n: string) => exts.includes(n) },
      initTexture: () => {}, properties: { get: () => ({ __webglTexture: {} }) },
    };
    return new Framebuffers(renderer as unknown as THREE.WebGLRenderer);
  }
  const src = `texture2D RT : RENDERCOLORTARGET < string Format = "A32B32G32R32F"; int MipLevels = 0; >;
sampler S = sampler_state { texture = <RT>; MinFilter = LINEAR; MagFilter = LINEAR; MipFilter = LINEAR; };`;
  const effect = { id: 'fx', name: 'a.fx', entry: 'a.fx', result: { ok: true, effect: desc(src), warnings: [] }, bytes: new Map() } as unknown as LoadedEffect;

  it('LINEAR で読めない 32 ビットの浮動小数は、POINT にしてミップマップも作らない (警告)', () => {
    const fb = fake(['EXT_color_buffer_float']);
    expect(fb.prepare(effect, [320, 240])).toEqual(['浮動小数のレンダーターゲット RT を LINEAR で読めない環境なので、POINT にしてミップマップを作りません']);
    const tex = fb.colorTexture(effect, 'RT')!;
    expect([tex.minFilter, tex.magFilter, tex.generateMipmaps, tex.type]).toEqual([THREE.NearestFilter, THREE.NearestFilter, false, THREE.FloatType]);
  });

  it('読めるならミップマップと LinearMipmapLinear のまま', () => {
    const fb = fake(['EXT_color_buffer_float', 'OES_texture_float_linear']);
    expect(fb.prepare(effect, [320, 240])).toEqual([]);
    const tex = fb.colorTexture(effect, 'RT')!;
    expect([tex.minFilter, tex.generateMipmaps]).toEqual([THREE.LinearMipmapLinearFilter, true]);
  });
});

// GL を使わない偽の描画先 (深度の renderbuffer・フレームバッファの作り・消しを数える)
function fakeGl(exts: string[], events?: ConstructorParameters<typeof Framebuffers>[1]) {
  const calls = { renderbuffers: 0, deletedRenderbuffers: 0 };
  const gl = {
    DEPTH24_STENCIL8: 1, RENDERBUFFER: 2,
    createRenderbuffer: () => ({ id: ++calls.renderbuffers }), bindRenderbuffer: () => {}, renderbufferStorage: () => {},
    deleteRenderbuffer: () => { calls.deletedRenderbuffers++; }, deleteFramebuffer: () => {},
  };
  const renderer = {
    getContext: () => gl, extensions: { has: (n: string) => exts.includes(n) },
    initTexture: () => {}, properties: { get: () => ({ __webglTexture: {} }) },
  };
  return { fb: new Framebuffers(renderer as unknown as THREE.WebGLRenderer, events), calls };
}
let effectNumber = 0;
const loaded = (src: string) => {
  const id = `fx${++effectNumber}`;
  return { id, name: `${id}.fx`, entry: `${id}.fx`, result: { ok: true, effect: desc(src), warnings: [] } } as unknown as LoadedEffect;
};
const disposed = (tex: THREE.Texture) => {
  const state = { count: 0 };
  tex.addEventListener('dispose', () => { state.count++; });
  return state;
};
const SCREEN: [number, number] = [320, 240];
const widthOf = (tex: THREE.Texture) => (tex.image as { width: number }).width;
const heightOf = (tex: THREE.Texture) => (tex.image as { height: number }).height;
const G_FULL = 'shared texture2D G : RENDERCOLORTARGET < float2 ViewportRatio = {1, 1}; string Format = "A16B16G16R16F"; >;';
const G_BARE = 'shared texture2D G : RENDERCOLORTARGET;';

describe('Framebuffers.prepare (shared)', () => {
  const FLOAT_EXTS = ['EXT_color_buffer_float'];

  it('shared の RENDERCOLORTARGET は、名前が同じなら 1 つのテクスチャ。形を書いた宣言の形で作り、書いていない宣言はそれを使う', () => {
    const { fb } = fakeGl(FLOAT_EXTS);
    const a = loaded(G_FULL), b = loaded(G_BARE);
    expect(fb.prepare(a, SCREEN)).toEqual([]);
    expect(fb.prepare(b, SCREEN)).toEqual([]);
    const tex = fb.colorTexture(a, 'G')!;
    expect(fb.colorTexture(b, 'G')).toBe(tex);
    expect([tex.type, widthOf(tex), heightOf(tex)]).toEqual([THREE.HalfFloatType, 320, 240]);
  });

  it('書いていない宣言が先に来ても、後から来た書いてある宣言の形になり、両方が同じテクスチャを指す', () => {
    const { fb } = fakeGl(FLOAT_EXTS);
    const a = loaded(G_FULL), b = loaded(G_BARE);
    fb.prepare(b, SCREEN);
    const first = fb.colorTexture(b, 'G')!;
    expect(first.type).toBe(THREE.UnsignedByteType);
    const gone = disposed(first);
    fb.prepare(a, SCREEN);
    const tex = fb.colorTexture(a, 'G')!;
    expect(tex.type).toBe(THREE.HalfFloatType);
    expect(fb.colorTexture(b, 'G')).toBe(tex);
    expect(gone.count).toBe(1); // (仮の形で作ったものは捨てる)
    // 次のフレーム (どちらも用意し直す) でも作り直さない
    fb.prepare(b, SCREEN);
    fb.prepare(a, SCREEN);
    expect(fb.colorTexture(a, 'G')).toBe(tex);
  });

  it('片方を release しても、ほかに使うエフェクトが残っていれば捨てない。最後の 1 つを release すると捨てる', () => {
    const { fb } = fakeGl(FLOAT_EXTS);
    const a = loaded(G_FULL), b = loaded(G_BARE);
    fb.prepare(a, SCREEN);
    fb.prepare(b, SCREEN);
    const tex = fb.colorTexture(a, 'G')!;
    const gone = disposed(tex);
    fb.release(a);
    expect(gone.count).toBe(0);
    expect(fb.colorTexture(b, 'G')).toBe(tex);
    expect(fb.colorTexture(a, 'G')).toBeNull();
    fb.release(b);
    expect(gone.count).toBe(1);
  });

  it('形を書いた宣言を release したあと、残りは自分の (書いていない) 形で作り直す', () => {
    const { fb } = fakeGl(FLOAT_EXTS);
    const a = loaded(G_FULL), b = loaded(G_BARE);
    fb.prepare(a, SCREEN);
    fb.prepare(b, SCREEN);
    fb.release(a);
    fb.prepare(b, SCREEN);
    expect(fb.colorTexture(b, 'G')!.type).toBe(THREE.UnsignedByteType);
  });

  it('形・大きさが食い違う宣言は、警告を出して、そのエフェクトだけ別に作る', () => {
    const { fb } = fakeGl(FLOAT_EXTS);
    const a = loaded(G_FULL);
    const b = loaded('shared texture2D G : RENDERCOLORTARGET < float2 ViewportRatio = {0.5, 0.5}; string Format = "A16B16G16R16F"; >;');
    const c = loaded(G_BARE);
    expect(fb.prepare(a, SCREEN)).toEqual([]);
    expect(fb.prepare(b, SCREEN)).toEqual(['共有のレンダーターゲット G の形か大きさが、ほかのエフェクトの宣言と違うので、このエフェクトだけ別に作ります']);
    fb.prepare(c, SCREEN);
    const shared = fb.colorTexture(a, 'G')!;
    expect(fb.colorTexture(c, 'G')).toBe(shared);
    const own = fb.colorTexture(b, 'G')!;
    expect(own).not.toBe(shared);
    expect(widthOf(own)).toBe(160);
    // 食い違うエフェクトを release しても共有のものは残る。共有のものを使う側を release しても、別に作ったものは残る
    const sharedGone = disposed(shared), ownGone = disposed(own);
    fb.release(b);
    expect([sharedGone.count, ownGone.count]).toEqual([0, 1]);
  });

  it('shared でない同じ名前は、エフェクトごとに別のテクスチャ', () => {
    const { fb } = fakeGl(FLOAT_EXTS);
    const a = loaded('texture2D G : RENDERCOLORTARGET;'), b = loaded('texture2D G : RENDERCOLORTARGET;');
    fb.prepare(a, SCREEN);
    fb.prepare(b, SCREEN);
    expect(fb.colorTexture(a, 'G')).not.toBe(fb.colorTexture(b, 'G'));
  });

  it('画面の大きさが変わると、共有のものも 1 つだけ作り直して、両方が新しいものを指す', () => {
    const { fb } = fakeGl(FLOAT_EXTS);
    const a = loaded(G_FULL), b = loaded(G_BARE);
    fb.prepare(a, SCREEN);
    fb.prepare(b, SCREEN);
    const old = fb.colorTexture(a, 'G')!;
    fb.prepare(a, [200, 100]);
    const tex = fb.colorTexture(a, 'G')!;
    expect(tex).not.toBe(old);
    expect(widthOf(tex)).toBe(200);
    expect(fb.colorTexture(b, 'G')).toBe(tex);
  });

  it('shared の RENDERDEPTHSTENCILTARGET も 1 つ (最後の 1 つを release するまで捨てない)', () => {
    const { fb, calls } = fakeGl(FLOAT_EXTS);
    const a = loaded('shared texture2D D : RENDERDEPTHSTENCILTARGET < float2 ViewportRatio = {1, 1}; string Format = "D24S8"; >;');
    const b = loaded('shared texture2D D : RENDERDEPTHSTENCILTARGET;');
    fb.prepare(a, SCREEN);
    fb.prepare(b, SCREEN);
    expect(calls.renderbuffers).toBe(1);
    fb.release(a);
    expect(calls.deletedRenderbuffers).toBe(0);
    expect(fb.has(b, 'D', 'depth')).toBe(true);
    fb.release(b);
    expect(calls.deletedRenderbuffers).toBe(1);
  });
});

describe('Framebuffers.prepare (形式)', () => {
  const FLOAT = 'texture2D RT : RENDERCOLORTARGET < string Format = "A16B16G16R16F"; >;';

  it('浮動小数点に描けない環境では、それを宣言したエフェクトを止め、警告は 1 つ。8 ビットに落とさない', () => {
    const broken: LoadedEffect[][] = [];
    const { fb } = fakeGl([], { warn: () => {}, broken: e => broken.push(e) });
    const effect = loaded(`${FLOAT}\ntexture2D Plain : RENDERCOLORTARGET;`);
    const warnings = fb.prepare(effect, SCREEN);
    expect(warnings).toEqual(['浮動小数のレンダーターゲット RT に描けない環境なので、このエフェクトを止めます']);
    expect(broken).toEqual([[effect]]);
    expect(fb.colorTexture(effect, 'RT')).toBeNull();
    // (毎フレーム用意し直しても、止める通知は 1 回)
    fb.prepare(effect, SCREEN);
    expect(broken).toHaveLength(1);
  });

  it('止めたエフェクトは shared のテクスチャを使わない (形は決めない)', () => {
    const { fb } = fakeGl([], { warn: () => {}, broken: () => {} });
    const a = loaded(G_FULL), b = loaded(G_BARE);
    fb.prepare(a, SCREEN);
    expect(fb.colorTexture(a, 'G')).toBeNull();
    fb.prepare(b, SCREEN);
    expect(fb.colorTexture(b, 'G')!.type).toBe(THREE.UnsignedByteType);
  });

  it('half float だけ描ける環境 (EXT_color_buffer_half_float) では A16B16G16R16F は使えて、A32B32G32R32F は止まる', () => {
    const broken: LoadedEffect[][] = [];
    const { fb } = fakeGl(['EXT_color_buffer_half_float'], { warn: () => {}, broken: e => broken.push(e) });
    const half = loaded(FLOAT), full = loaded('texture2D RT : RENDERCOLORTARGET < string Format = "A32B32G32R32F"; >;');
    expect(fb.prepare(half, SCREEN)).toEqual([]);
    expect(fb.prepare(full, SCREEN)).toHaveLength(1);
    expect(broken).toEqual([[full]]);
  });

  it('A8・L8・A2B10G10R10 は浮動小数でないので、どの環境でも作れる', () => {
    const { fb } = fakeGl([]);
    const e = loaded(`texture2D A : RENDERCOLORTARGET < string Format = "A8"; >;
texture2D L : RENDERCOLORTARGET < string Format = "L8"; >;
texture2D X : RENDERCOLORTARGET < string Format = "A2B10G10R10"; int MipLevels = 0; >;`);
    expect(fb.prepare(e, SCREEN)).toEqual([]);
    expect(fb.colorTexture(e, 'L')!.format).toBe(THREE.RedFormat);
    expect(fb.colorTexture(e, 'A')!.format).toBe(THREE.RGBAFormat);
    expect(fb.colorTexture(e, 'X')!.generateMipmaps).toBe(true);
  });
});
