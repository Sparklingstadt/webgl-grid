import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { compileEffect, type Pass, type Program, type RenderState } from '../../core/fx/index.ts';
import { addDictionary, setLang } from '../../core/i18n.ts';
import en from '../../i18n/en.ts';
import { buildDds } from '../../core/testing/dds.ts';
import { semanticValue, SHADOW_COLOR, type MaterialState, type SemanticContext } from '../../core/mme/semantics.ts';
import type { UiChannel } from '../UiChannel';
import { EffectStore, type LoadedEffect } from './EffectStore.ts';
import { applyStates, cullSide, EffectInstance, type BaseState, type DrawBuiltins, type TextureSource } from './EffectInstance.ts';

const FX = String.raw`
float4x4 WVP : WORLDVIEWPROJECTION;
float4 Diffuse : DIFFUSE < string Object = "Geometry"; >;
float4x3 W43 : WORLD;
float Scale = 2.5;
float LoopIndex;
float4 Mouse : MOUSEPOSITION;
texture TexA < string ResourceName = "Tex\Stone.PNG"; >;
texture Missing < string ResourceName = "nothing.png"; >;
sampler SampLinear = sampler_state { texture = <TexA>; MinFilter = LINEAR; MagFilter = LINEAR; MipFilter = LINEAR; AddressU = CLAMP; AddressV = BORDER; };
sampler SampPoint = sampler_state { texture = <TexA>; AddressU = MIRROR; };
sampler SampMissing = sampler_state { texture = <Missing>; };
texture ObjTex : MATERIALTEXTURE;
sampler ObjSamp = sampler_state { texture = <ObjTex>; MinFilter = LINEAR; MagFilter = LINEAR; };
sampler ShadowSamp : register(s0);
texture2D Target : RENDERCOLORTARGET;
sampler TargetSamp = sampler_state { texture = <Target>; };

float4 VS(float4 p : POSITION, float2 uv : TEXCOORD0, out float2 oUv : TEXCOORD0) : POSITION {
  oUv = uv;
  return mul(p, WVP) + float4(mul(p, W43), 0) * Scale * LoopIndex + Mouse;
}
float4 PS(float2 uv : TEXCOORD0, float2 vpos : VPOS) : COLOR0 {
  return Diffuse * (tex2D(SampLinear, uv) + tex2D(SampPoint, uv) + tex2D(SampMissing, uv) + tex2D(ObjSamp, uv)
    + tex2D(ShadowSamp, uv) + tex2D(TargetSamp, uv)) + vpos.y;
}
technique T {
  pass P { AlphaBlendEnable = FALSE; CullMode = NONE; VertexShader = compile vs_3_0 VS(); PixelShader = compile ps_3_0 PS(); }
  pass Plain { VertexShader = compile vs_3_0 VS(); PixelShader = compile ps_3_0 PS(); }
  pass Blend { AlphaBlendEnable = TRUE; VertexShader = compile vs_3_0 VS(); PixelShader = compile ps_3_0 PS(); }
  pass Empty { }
  pass NoStencil { StencilEnable = FALSE; VertexShader = compile vs_3_0 VS(); PixelShader = compile ps_3_0 PS(); }
}
`;

// フォルダごと読んだエフェクト (EffectStore.load と同じ形)
function loadEffect(fx = FX, files: [string, Uint8Array][] = [['sub/tex/stone.png', new Uint8Array([9, 8, 7])]]): LoadedEffect {
  const bytes = new Map<string, Uint8Array>([['sub/effect.fx', new TextEncoder().encode(fx)], ...files]);
  const result = compileEffect('sub/effect.fx', p => bytes.get(p) ?? null, { listFiles: () => [...bytes.keys()] });
  if (!result.ok) throw new Error(result.errors.map(e => `${e.code}: ${e.message}`).join('\n'));
  return { id: 'fx1', name: 'effect.fx', entry: 'sub/effect.fx', result, bytes };
}

function passOf(e: LoadedEffect, name: string): Pass {
  if (!e.result.ok) throw new Error('not ok');
  return e.result.effect.techniques[0].passes.find(p => p.name === name)!;
}

const MAT: MaterialState = {
  diffuse: [0.9, 0.7, 0.5, 0.8], ambient: [0.4, 0.3, 0.2], specular: [0.1, 0.2, 0.3], power: 12,
  toon: [0.6, 0.6, 0.6], edgeColor: [0, 0, 0, 1], groundShadowColor: SHADOW_COLOR,
  hasTexture: true, hasSphere: false, hasToon: true, sphereAdd: false, transparent: false,
};

function makeCtx(): SemanticContext {
  return {
    camera: { position: new THREE.Vector3(0, 10, -30), target: new THREE.Vector3(), up: new THREE.Vector3(0, 0.95, 0.3).normalize(), fovY: 0.8, aspect: 1.5, near: 0.1, far: 500 },
    light: { direction: new THREE.Vector3(1, -1, 0.5).normalize(), color: [0.5, 0.6, 0.7], shadowView: new THREE.Matrix4(), shadowProjection: new THREE.Matrix4() },
    world: new THREE.Matrix4().makeTranslation(1, 2, 5), material: MAT, pass: 'object', time: 1.5, elapsed: 0.25, screen: [640, 480], selfShadow: true,
  };
}

const BUILTINS: DrawBuiltins = { flipY: -1, halfPixel: [-1 / 640, -1 / 480], viewport: [640, 480] };
const OBJECT: BaseState = { kind: 'object', doubleSided: false };

function noTextures(): TextureSource {
  return { role: () => null };
}

// 1×1 の DataTexture (偽の decode が返す)
function pixel(rgba: number[]): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array(rgba), 1, 1);
  t.needsUpdate = true;
  return t;
}

const glslOf = (prog: Program, name: string) => prog.uniforms.find(u => u.name === name)!.glslName;

describe('EffectInstance', () => {
  it('cullSide の表', () => {
    expect([cullSide('CCW', 1), cullSide('CCW', -1), cullSide('CW', 1), cullSide('CW', -1), cullSide('NONE', 1), cullSide('NONE', -1)])
      .toEqual([THREE.BackSide, THREE.FrontSide, THREE.FrontSide, THREE.BackSide, THREE.DoubleSide, THREE.DoubleSide]);
  });

  it('ステート: 何もなければ D3D の既定 (ブレンドなし・深度は LESSEQUAL・CCW を消す)', () => {
    const m = new THREE.RawShaderMaterial();
    expect(applyStates(m, [], 1)).toEqual([]);
    expect(m).toMatchObject({ blending: THREE.NoBlending, depthTest: true, depthWrite: true, depthFunc: THREE.LessEqualDepth, side: THREE.BackSide, colorWrite: true, stencilWrite: false });
  });

  it('ステート: ブレンド・深度・色の書き込み・ステンシル', () => {
    const m = new THREE.RawShaderMaterial();
    const warnings = applyStates(m, [
      { name: 'AlphaBlendEnable', value: true }, { name: 'SrcBlend', value: 'ONE' }, { name: 'DestBlend', value: 'INVSRCCOLOR' }, { name: 'BlendOp', value: 'REVSUBTRACT' },
      { name: 'SeparateAlphaBlendEnable', value: true }, { name: 'SrcBlendAlpha', value: 'ZERO' }, { name: 'DestBlendAlpha', value: 'INVSRCALPHA' }, { name: 'BlendOpAlpha', value: 'MAX' },
      { name: 'ZEnable', value: true }, { name: 'ZWriteEnable', value: false }, { name: 'ZFunc', value: 'GREATER' },
      { name: 'ColorWriteEnable', index: 0, value: 0 },
      { name: 'StencilEnable', value: true }, { name: 'StencilFunc', value: 'EQUAL' }, { name: 'StencilRef', value: 3 },
      { name: 'StencilMask', value: 0x0f }, { name: 'StencilWriteMask', value: 0xf0 },
      { name: 'StencilFail', value: 'INCR' }, { name: 'StencilZFail', value: 'DECRSAT' }, { name: 'StencilPass', value: 'REPLACE' },
      { name: 'CullMode', value: 'CCW' }, { name: 'CullMode', value: 'CW' }, // 後に書いたものが勝つ
    ], -1);
    expect(warnings).toEqual([]);
    expect(m).toMatchObject({
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcColorFactor, blendEquation: THREE.ReverseSubtractEquation,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor, blendEquationAlpha: THREE.MaxEquation,
      depthTest: true, depthWrite: false, depthFunc: THREE.GreaterDepth, colorWrite: false,
      stencilWrite: true, stencilFunc: THREE.EqualStencilFunc, stencilRef: 3, stencilFuncMask: 0x0f, stencilWriteMask: 0xf0,
      stencilFail: THREE.IncrementWrapStencilOp, stencilZFail: THREE.DecrementStencilOp, stencilZPass: THREE.ReplaceStencilOp,
      side: THREE.BackSide,
    });
  });

  it('ステート: アルファテスト・RGBA ごとの色の書き込み・式の値は警告', () => {
    const m = new THREE.RawShaderMaterial();
    const warnings = applyStates(m, [
      { name: 'AlphaTestEnable', value: true },
      { name: 'ColorWriteEnable', index: 0, value: 7 },
      { name: 'ZFunc', value: { expr: 'Func' } },
    ], 1);
    expect(m.colorWrite).toBe(true);                // 一部でも書くなら全部
    expect(m.depthFunc).toBe(THREE.LessEqualDepth); // 式は既定のまま
    expect(warnings).toHaveLength(3);
    for (const name of ['AlphaTestEnable', 'ColorWriteEnable', 'ZFunc']) expect(warnings.some(w => w.includes(name)), name).toBe(true);
  });

  it('ステートの警告は画面の言語で出す', () => {
    addDictionary('en', en);
    setLang('en');
    try {
      expect(applyStates(new THREE.RawShaderMaterial(), [{ name: 'AlphaTestEnable', value: true }, { name: 'Foo', value: 1 }], 1))
        .toEqual(['AlphaTestEnable (alpha test) is not supported, so it is ignored', 'Ignoring unknown state Foo']);
    } finally {
      setLang('ja');
    }
  });

  it('材質は #version の行を除いた GLSL と GLSL3。program がない pass は null', () => {
    const e = loadEffect();
    const inst = new EffectInstance(e, () => {}, async () => pixel([0, 0, 0, 255]));
    const pass = passOf(e, 'P');
    const m = inst.material(pass, 1, OBJECT)!;
    expect(m).toBeInstanceOf(THREE.RawShaderMaterial);
    expect(m.vertexShader.startsWith('#version')).toBe(false);
    expect(m.fragmentShader.startsWith('#version')).toBe(false);
    expect(pass.program!.vertex.split('\n').slice(1).join('\n')).toBe(m.vertexShader);
    expect(m.glslVersion).toBe(THREE.GLSL3);
    expect(m.defines).toEqual({});
    expect(Object.keys(m.uniforms).sort()).toEqual(pass.program!.uniforms.map(u => u.glslName).sort());
    expect(inst.material(passOf(e, 'Empty'), 1, OBJECT)).toBeNull();
    // 同じ組み合わせは同じ材質、flipY が違えば別の材質
    expect(inst.material(pass, 1, OBJECT)).toBe(m);
    expect(inst.material(pass, -1, OBJECT)).not.toBe(m);
  });

  it('材質: MMD が残す既定のステートの上に pass のステートを重ねる', () => {
    const e = loadEffect();
    const inst = new EffectInstance(e, () => {}, async () => pixel([0, 0, 0, 255]));
    const plain = passOf(e, 'Plain');
    // 物: 半透明で重ね、深度は LESSEQUAL、CCW を消す (上下を返すと逆の面)
    expect(inst.material(plain, 1, OBJECT)).toMatchObject({
      blending: THREE.CustomBlending, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      depthTest: true, depthWrite: true, depthFunc: THREE.LessEqualDepth, side: THREE.BackSide,
    });
    expect(inst.material(plain, -1, OBJECT)!.side).toBe(THREE.FrontSide);
    expect(inst.material(plain, 1, { kind: 'object', doubleSided: true })!.side).toBe(THREE.DoubleSide);
    expect(inst.material(plain, 1, { kind: 'zplot', doubleSided: false })).toMatchObject({ blending: THREE.NoBlending, depthTest: true, side: THREE.BackSide });
    expect(inst.material(plain, 1, { kind: 'edge', doubleSided: false })).toMatchObject({ blending: THREE.CustomBlending, side: THREE.FrontSide });
    expect(inst.material(plain, 1, { kind: 'post', doubleSided: false })).toMatchObject({ blending: THREE.NoBlending, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
    // 地面の影: MMD のデバイスのステンシル (1 画素に 1 回だけ重ねる)。ほかの場面はステンシルを使わない
    const shadow = inst.material(plain, 1, { kind: 'shadow', doubleSided: false })!;
    expect(shadow).toMatchObject({
      blending: THREE.CustomBlending, depthTest: true, side: THREE.BackSide,
      stencilWrite: true, stencilFunc: THREE.NotEqualStencilFunc, stencilRef: 1, stencilFuncMask: 0xff, stencilWriteMask: 0xff,
      stencilFail: THREE.KeepStencilOp, stencilZFail: THREE.KeepStencilOp, stencilZPass: THREE.ReplaceStencilOp,
    });
    expect(shadow).not.toBe(inst.material(plain, 1, OBJECT));
    expect(inst.material(plain, 1, OBJECT)!.stencilWrite).toBe(false);
    // .fx が書いたステンシルのステートが勝つ
    expect(inst.material(passOf(e, 'NoStencil'), 1, { kind: 'shadow', doubleSided: false })!.stencilWrite).toBe(false);
    // pass が書いたステートが勝つ
    expect(inst.material(passOf(e, 'P'), 1, OBJECT)).toMatchObject({ blending: THREE.NoBlending, side: THREE.DoubleSide });
    // ポストエフェクトでも MMD が残した SRCALPHA・INVSRCALPHA を使う (AlphaBlendEnable だけを書いた pass)
    expect(inst.material(passOf(e, 'Blend'), 1, { kind: 'post', doubleSided: false })).toMatchObject({
      blending: THREE.CustomBlending, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor, depthTest: false,
    });
  });

  it('bind: WORLDVIEWPROJECTION・MATERIALDIFFUSE・builtin・非正方の行列の詰め方・初期値・setParam', () => {
    const e = loadEffect();
    const inst = new EffectInstance(e, () => {}, async () => pixel([0, 0, 0, 255]));
    const pass = passOf(e, 'P');
    const prog = pass.program!;
    const m = inst.material(pass, -1, OBJECT)!;
    const ctx = makeCtx();
    m.uniformsNeedUpdate = false;
    inst.bind(m, pass, ctx, BUILTINS, noTextures());
    expect(m.uniformsNeedUpdate).toBe(true);
    const u = (name: string) => m.uniforms[glslOf(prog, name)].value as unknown;
    const params = e.result.ok ? e.result.effect.params : [];
    const sem = (name: string) => {
      const r = semanticValue(params.find(p => p.name === name)!, ctx);
      if (r.kind !== 'numbers') throw new Error(r.kind);
      return r.values;
    };
    expect(u('WVP')).toEqual(sem('WVP'));
    expect(sem('WVP')).toHaveLength(16);
    expect(u('Diffuse')).toEqual(MAT.diffuse);
    // float4x3: HLSL の r 行 c 列を r * 4 + c に置き、残りは 0
    const w = sem('W43');
    expect(w).toHaveLength(12);
    const packed = Array.from({ length: 16 }, (_, i) => (i % 4 === 3 ? 0 : w[Math.floor(i / 4) * 3 + (i % 4)]));
    expect(u('W43')).toEqual(packed);
    expect(u('Scale')).toBe(2.5);   // スカラーは数のまま
    expect(u('LoopIndex')).toBe(0); // 初期値もセマンティクスもなければ 0
    expect(u('Mouse')).toEqual([0, 0, 0, 0]);
    expect(u('mme_flipY')).toBe(-1);
    expect(u('mme_halfPixel')).toEqual([-1 / 640, -1 / 480]);
    expect(u('mme_viewport')).toEqual([640, 480]);
    // Script の LoopGetIndex などが入れた値が勝つ
    expect(inst.param('Scale')).toEqual([2.5]);
    expect(inst.param('LoopIndex')).toEqual([0]);
    expect(inst.param('NoSuch')).toBeNull();
    inst.setParam('LoopIndex', [3]);
    inst.setParam('Scale', [4]);
    inst.bind(m, pass, ctx, BUILTINS, noTextures());
    expect(u('LoopIndex')).toBe(3);
    expect(u('Scale')).toBe(4);
    expect(inst.param('LoopIndex')).toEqual([3]);
    // 値を入れないセマンティクスは 1 回だけ警告
    expect(inst.warnings.filter(x => x.includes('MOUSEPOSITION'))).toHaveLength(1);
  });

  it('ResourceName のテクスチャをサブフォルダから大文字小文字と \\ を無視して探す (読めなければ赤紫と警告)', async () => {
    const e = loadEffect();
    const decoded = pixel([1, 2, 3, 4]);
    decoded.colorSpace = THREE.SRGBColorSpace;
    decoded.flipY = true;
    const decode = vi.fn(async () => decoded);
    const requestDraw = vi.fn();
    const inst = new EffectInstance(e, requestDraw, decode);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(decode).toHaveBeenCalledWith(e.bytes.get('sub/tex/stone.png'), 'sub/tex/stone.png');
    const pass = passOf(e, 'P');
    const prog = pass.program!;
    const m = inst.material(pass, 1, OBJECT)!;
    await vi.waitFor(() => expect(requestDraw).toHaveBeenCalled());
    inst.bind(m, pass, makeCtx(), BUILTINS, noTextures());
    const tex = m.uniforms[glslOf(prog, 'SampLinear')].value as THREE.Texture;
    expect(tex).not.toBe(decoded);
    expect(tex.source).toBe(decoded.source);
    expect(tex).toMatchObject({ colorSpace: THREE.NoColorSpace, flipY: false });
    // 見つからないものは赤紫の 1×1 と警告
    const missing = m.uniforms[glslOf(prog, 'SampMissing')].value as THREE.DataTexture;
    expect([...(missing.image.data as Uint8Array)]).toEqual([255, 0, 255, 255]);
    expect(inst.warnings.some(x => x.includes('nothing.png'))).toBe(true);
  });

  it('読めなかった画像は赤紫と警告にして、描き直しを頼む', async () => {
    const e = loadEffect();
    const requestDraw = vi.fn();
    const inst = new EffectInstance(e, requestDraw, async () => { throw new Error('broken'); });
    await vi.waitFor(() => expect(requestDraw).toHaveBeenCalled());
    const pass = passOf(e, 'P');
    const m = inst.material(pass, 1, OBJECT)!;
    inst.bind(m, pass, makeCtx(), BUILTINS, noTextures());
    const tex = m.uniforms[glslOf(pass.program!, 'SampLinear')].value as THREE.DataTexture;
    expect([...(tex.image.data as Uint8Array)]).toEqual([255, 0, 255, 255]);
    expect(inst.warnings.some(x => x.includes('Tex\\Stone.PNG') && x.includes('broken'))).toBe(true);
  });

  it('同じテクスチャを違うサンプラーで使うと、設定の違う写しになる', async () => {
    const e = loadEffect();
    const decoded = pixel([1, 2, 3, 4]);
    const requestDraw = vi.fn();
    const inst = new EffectInstance(e, requestDraw, async () => decoded);
    await vi.waitFor(() => expect(requestDraw).toHaveBeenCalled());
    const pass = passOf(e, 'P');
    const prog = pass.program!;
    const m = inst.material(pass, 1, OBJECT)!;
    inst.bind(m, pass, makeCtx(), BUILTINS, noTextures());
    const linear = m.uniforms[glslOf(prog, 'SampLinear')].value as THREE.Texture;
    const point = m.uniforms[glslOf(prog, 'SampPoint')].value as THREE.Texture;
    expect(linear).not.toBe(point);
    expect(point.source).toBe(linear.source);
    expect(linear).toMatchObject({ minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping, generateMipmaps: true });
    // 書いていない設定は D3D の既定 (POINT・ミップなし・WRAP)
    expect(point).toMatchObject({ minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, wrapS: THREE.MirroredRepeatWrapping, wrapT: THREE.RepeatWrapping, generateMipmaps: false });
    expect(inst.warnings.some(x => x.includes('SampLinear') && x.includes('BORDER'))).toBe(true);
    // 描くたびに同じ写し
    inst.bind(m, pass, makeCtx(), BUILTINS, noTextures());
    expect(m.uniforms[glslOf(prog, 'SampLinear')].value).toBe(linear);
  });

  it('材質のテクスチャは色の空間を変えた写し (元は変えない。上下は元のまま)、セルフシャドウとレンダーターゲットはそのまま渡す', () => {
    const e = loadEffect();
    const inst = new EffectInstance(e, () => {}, async () => pixel([0, 0, 0, 255]));
    const pass = passOf(e, 'P');
    const prog = pass.program!;
    const m = inst.material(pass, 1, OBJECT)!;
    const matTex = pixel([5, 6, 7, 8]);
    matTex.colorSpace = THREE.SRGBColorSpace;
    matTex.flipY = true;
    const shadow = pixel([255, 255, 255, 255]);
    const target = pixel([0, 0, 0, 0]);
    const textures: TextureSource = { role: name => ({ material: matTex, selfShadow: shadow, Target: target } as Record<string, THREE.Texture>)[name] ?? null };
    inst.bind(m, pass, makeCtx(), BUILTINS, textures);
    const obj = m.uniforms[glslOf(prog, 'ObjSamp')].value as THREE.Texture;
    expect(obj).not.toBe(matTex);
    expect(obj.source).toBe(matTex.source);
    // (形の画像は flipY = true で three.js の UV と組むので、写しも同じ向き)
    expect(obj).toMatchObject({ colorSpace: THREE.NoColorSpace, flipY: true, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    expect(matTex).toMatchObject({ colorSpace: THREE.SRGBColorSpace, flipY: true });
    expect(m.uniforms[glslOf(prog, 'ShadowSamp')].value).toBe(shadow);
    expect(m.uniforms[glslOf(prog, 'TargetSamp')].value).toBe(target);
    // 写しは元のテクスチャごとに 1 つ。元を捨てたら写しも捨てる
    inst.bind(m, pass, makeCtx(), BUILTINS, textures);
    expect(m.uniforms[glslOf(prog, 'ObjSamp')].value).toBe(obj);
    const disposed = vi.fn();
    obj.addEventListener('dispose', disposed);
    matTex.dispose();
    expect(disposed).toHaveBeenCalled();
    // MMD モデルの画像 (flipY = false) の写しは false のまま
    const mmdTex = pixel([1, 2, 3, 4]);
    mmdTex.flipY = false;
    inst.bind(m, pass, makeCtx(), BUILTINS, { role: name => (name === 'material' ? mmdTex : null) });
    expect(m.uniforms[glslOf(prog, 'ObjSamp')].value).toMatchObject({ flipY: false });
  });

  it('dispose で材質と自分で読んだテクスチャを捨て、あとから読み終えても描き直しを頼まない', async () => {
    const e = loadEffect();
    let resolve: (t: THREE.Texture) => void = () => {};
    const decoded = pixel([1, 2, 3, 4]);
    const requestDraw = vi.fn();
    const inst = new EffectInstance(e, requestDraw, () => new Promise(r => { resolve = r; }));
    const pass = passOf(e, 'P');
    const m = inst.material(pass, 1, OBJECT)!;
    const disposedM = vi.fn();
    const disposedT = vi.fn();
    m.addEventListener('dispose', disposedM);
    decoded.addEventListener('dispose', disposedT);
    inst.dispose();
    expect(disposedM).toHaveBeenCalled();
    resolve(decoded);
    await vi.waitFor(() => expect(disposedT).toHaveBeenCalled());
    expect(requestDraw).not.toHaveBeenCalled();
  });

  it('default.fx の全部の pass の材質を作って、警告なしに値を入れられる', () => {
    const e = new EffectStore({ toast: vi.fn() } as unknown as UiChannel).defaultEffect;
    const inst = new EffectInstance(e, () => {}, async () => pixel([0, 0, 0, 255]));
    const tex = pixel([255, 255, 255, 255]);
    const textures: TextureSource = { role: () => tex };
    const desc = e.result.ok ? e.result.effect : null;
    let count = 0;
    for (const tech of desc!.techniques) {
      const pass = String(tech.annotations.find(a => a.name === 'MMDPass')?.value);
      const kind: BaseState['kind'] = pass === 'zplot' ? 'zplot' : pass === 'edge' ? 'edge' : 'object';
      for (const p of tech.passes) {
        const m = inst.material(p, 1, { kind, doubleSided: false })!;
        inst.bind(m, p, { ...makeCtx(), pass: pass as SemanticContext['pass'] }, BUILTINS, textures);
        for (const u of p.program!.uniforms) expect(m.uniforms[u.glslName].value, `${tech.name} ${u.name}`).not.toBeUndefined();
        count++;
      }
    }
    expect(count).toBeGreaterThan(5);
    expect(inst.warnings).toEqual([]);
  });

  it('ステート: ブレンドの係数・式、深度とステンシルの比べ方・操作の表', () => {
    const blend = (states: RenderState[]) => {
      const m = new THREE.RawShaderMaterial();
      expect(applyStates(m, [{ name: 'AlphaBlendEnable', value: true }, ...states], 1)).toEqual([]);
      return m;
    };
    const FACTORS: [string, number][] = [
      ['ZERO', THREE.ZeroFactor], ['ONE', THREE.OneFactor], ['SRCCOLOR', THREE.SrcColorFactor], ['INVSRCCOLOR', THREE.OneMinusSrcColorFactor],
      ['SRCALPHA', THREE.SrcAlphaFactor], ['INVSRCALPHA', THREE.OneMinusSrcAlphaFactor], ['DESTALPHA', THREE.DstAlphaFactor], ['INVDESTALPHA', THREE.OneMinusDstAlphaFactor],
      ['DESTCOLOR', THREE.DstColorFactor], ['INVDESTCOLOR', THREE.OneMinusDstColorFactor], ['SRCALPHASAT', THREE.SrcAlphaSaturateFactor],
      ['BLENDFACTOR', THREE.ConstantColorFactor], ['INVBLENDFACTOR', THREE.OneMinusConstantColorFactor],
    ];
    for (const [name, f] of FACTORS) {
      expect(blend([{ name: 'SrcBlend', value: name }]).blendSrc, name).toBe(f);
      if (name !== 'SRCALPHASAT') expect(blend([{ name: 'DestBlend', value: name }]).blendDst, name).toBe(f);
      expect(blend([{ name: 'SeparateAlphaBlendEnable', value: true }, { name: 'SrcBlendAlpha', value: name }]).blendSrcAlpha, name).toBe(f);
    }
    // BOTH… は SrcBlend に書くと DestBlend も決める
    expect(blend([{ name: 'SrcBlend', value: 'BOTHSRCALPHA' }, { name: 'DestBlend', value: 'ONE' }])).toMatchObject({ blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor });
    expect(blend([{ name: 'SrcBlend', value: 'BOTHINVSRCALPHA' }])).toMatchObject({ blendSrc: THREE.OneMinusSrcAlphaFactor, blendDst: THREE.SrcAlphaFactor });
    // BlendFactor は D3DCOLOR (0xAARRGGBB)。書かなければ D3D の既定の 0xFFFFFFFF
    const bf = blend([{ name: 'SrcBlend', value: 'BLENDFACTOR' }, { name: 'BlendFactor', value: 0x80402010 }]);
    expect([bf.blendColor.r, bf.blendColor.g, bf.blendColor.b, bf.blendAlpha]).toEqual([0x40 / 255, 0x20 / 255, 0x10 / 255, 0x80 / 255]);
    const bd = blend([{ name: 'SrcBlend', value: 'BLENDFACTOR' }]);
    expect([bd.blendColor.r, bd.blendColor.g, bd.blendColor.b, bd.blendAlpha]).toEqual([1, 1, 1, 1]);
    const OPS: [string, number][] = [['ADD', THREE.AddEquation], ['SUBTRACT', THREE.SubtractEquation], ['REVSUBTRACT', THREE.ReverseSubtractEquation], ['MIN', THREE.MinEquation], ['MAX', THREE.MaxEquation]];
    for (const [name, op] of OPS) {
      expect(blend([{ name: 'BlendOp', value: name }]).blendEquation, name).toBe(op);
      expect(blend([{ name: 'SeparateAlphaBlendEnable', value: true }, { name: 'BlendOpAlpha', value: name }]).blendEquationAlpha, name).toBe(op);
    }
    const COMPARE = ['NEVER', 'LESS', 'EQUAL', 'LESSEQUAL', 'GREATER', 'NOTEQUAL', 'GREATEREQUAL', 'ALWAYS'];
    const DEPTH = [THREE.NeverDepth, THREE.LessDepth, THREE.EqualDepth, THREE.LessEqualDepth, THREE.GreaterDepth, THREE.NotEqualDepth, THREE.GreaterEqualDepth, THREE.AlwaysDepth];
    const STENCIL = [THREE.NeverStencilFunc, THREE.LessStencilFunc, THREE.EqualStencilFunc, THREE.LessEqualStencilFunc, THREE.GreaterStencilFunc, THREE.NotEqualStencilFunc, THREE.GreaterEqualStencilFunc, THREE.AlwaysStencilFunc];
    COMPARE.forEach((name, i) => {
      const m = new THREE.RawShaderMaterial();
      applyStates(m, [{ name: 'ZFunc', value: name }, { name: 'StencilFunc', value: name }], 1);
      expect([m.depthFunc, m.stencilFunc], name).toEqual([DEPTH[i], STENCIL[i]]);
    });
    const STENCIL_OPS: [string, number][] = [
      ['KEEP', THREE.KeepStencilOp], ['ZERO', THREE.ZeroStencilOp], ['REPLACE', THREE.ReplaceStencilOp], ['INCRSAT', THREE.IncrementStencilOp],
      ['DECRSAT', THREE.DecrementStencilOp], ['INVERT', THREE.InvertStencilOp], ['INCR', THREE.IncrementWrapStencilOp], ['DECR', THREE.DecrementWrapStencilOp],
    ];
    for (const [name, op] of STENCIL_OPS) {
      const m = new THREE.RawShaderMaterial();
      applyStates(m, [{ name: 'StencilFail', value: name }, { name: 'StencilZFail', value: name }, { name: 'StencilPass', value: name }], 1);
      expect([m.stencilFail, m.stencilZFail, m.stencilZPass], name).toEqual([op, op, op]);
    }
  });

  it('bind: float3x3・ベクトルの配列・行列の配列・非正方の行列の配列・int・bool の値', () => {
    const e = loadEffect(String.raw`
float3x3 M33 = { 1, 2, 3, 4, 5, 6, 7, 8, 9 };
float4 V4s[2] = { float4(1, 2, 3, 4), float4(5, 6, 7, 8) };
float4x4 M44s[2];
float4x3 M43s[2];
int I = 3;
bool B = true;
int2 I2 = { 1, 2 };
float4 VS(float4 p : POSITION) : POSITION {
  return float4(mul(p.xyz, M33), 1) + V4s[1] + mul(p, M44s[1]) + float4(mul(p, M43s[1]), 0) * I * (B ? 1 : 0) + I2.x;
}
float4 PS() : COLOR0 { return 1; }
technique T { pass P { VertexShader = compile vs_3_0 VS(); PixelShader = compile ps_3_0 PS(); } }
`, []);
    const inst = new EffectInstance(e, () => {}, async () => pixel([0, 0, 0, 255]));
    const pass = passOf(e, 'P');
    const prog = pass.program!;
    const m = inst.material(pass, 1, OBJECT)!;
    const seq = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
    inst.setParam('M43s', seq(24));
    inst.bind(m, pass, makeCtx(), BUILTINS, noTextures());
    const u = (name: string) => m.uniforms[glslOf(prog, name)].value as unknown;
    expect(prog.uniforms.find(x => x.name === 'M43s')!.upload).toBe('mat4');
    expect(u('M33')).toEqual(seq(9));                  // HLSL の行ごとの並びのまま (mat3 に transpose なしで入れる)
    expect(u('V4s')).toEqual(seq(8));
    expect(u('M44s')).toEqual(Array.from({ length: 32 }, () => 0));
    const packed = Array.from({ length: 32 }, () => 0);
    for (let k = 0; k < 2; k++) for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) packed[k * 16 + r * 4 + c] = k * 12 + r * 3 + c + 1;
    expect(u('M43s')).toEqual(packed);
    expect(u('I')).toBe(3);
    expect(u('B')).toBe(1);
    expect(u('I2')).toEqual([1, 2]);
  });

  it('ResourceName の dds のキューブマップを samplerCUBE に入れる。読めない dds は赤紫と警告', async () => {
    const CUBE_FX = String.raw`
texture Sky < string ResourceName = "sky.dds"; >;
samplerCUBE SkySamp = sampler_state { texture = <Sky>; MinFilter = LINEAR; MagFilter = LINEAR; MipFilter = LINEAR; };
texture Bad < string ResourceName = "bad.dds"; >;
sampler BadSamp = sampler_state { texture = <Bad>; };
float4 VS(float4 p : POSITION, out float3 d : TEXCOORD0) : POSITION { d = p.xyz; return p; }
float4 PS(float3 d : TEXCOORD0) : COLOR0 { return texCUBE(SkySamp, d) + tex2D(BadSamp, d.xy); }
technique T { pass P { VertexShader = compile vs_3_0 VS(); PixelShader = compile ps_3_0 PS(); } }
`;
    const files: [string, Uint8Array][] = [['sub/sky.dds', new Uint8Array(128)], ['sub/bad.dds', new Uint8Array(128)]];
    // 偽の decode: sky.dds は圧縮したキューブマップ
    const mip = { data: new Uint8Array(8), width: 4, height: 4 };
    const faces = Array.from({ length: 6 }, () => ({ mipmaps: [mip], width: 4, height: 4 }));
    const cube = new THREE.CompressedCubeTexture(faces as unknown as THREE.CompressedTextureImageData[], THREE.RGBA_S3TC_DXT1_Format);
    const e1 = loadEffect(CUBE_FX, files);
    const inst1 = new EffectInstance(e1, () => {}, async (_b, path) => (path.endsWith('sky.dds') ? cube : pixel([0, 0, 0, 255])));
    await inst1.ready();
    const pass1 = passOf(e1, 'P');
    const m1 = inst1.material(pass1, 1, OBJECT)!;
    inst1.bind(m1, pass1, makeCtx(), BUILTINS, noTextures());
    const sky = m1.uniforms[glslOf(pass1.program!, 'SkySamp')].value as THREE.CompressedCubeTexture;
    expect(sky).toBeInstanceOf(THREE.CompressedCubeTexture);
    expect(sky).not.toBe(cube);
    expect(sky.source).toBe(cube.source);
    // ミップが 1 段しかないので、ミップを使わない
    expect(sky).toMatchObject({ minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, colorSpace: THREE.NoColorSpace, flipY: false });
    inst1.bind(m1, pass1, makeCtx(), BUILTINS, noTextures());
    expect(m1.uniforms[glslOf(pass1.program!, 'SkySamp')].value).toBe(sky);

    // 既定の decode: 先頭が DDS でないファイルは読めないものとして扱う (赤紫と警告)
    const e2 = loadEffect(CUBE_FX, files);
    const requestDraw = vi.fn();
    const inst2 = new EffectInstance(e2, requestDraw);
    await inst2.ready();
    expect(requestDraw).toHaveBeenCalled();
    const pass2 = passOf(e2, 'P');
    const m2 = inst2.material(pass2, 1, OBJECT)!;
    inst2.bind(m2, pass2, makeCtx(), BUILTINS, noTextures());
    const bad = m2.uniforms[glslOf(pass2.program!, 'BadSamp')].value as THREE.DataTexture;
    expect([...(bad.image.data as Uint8Array)]).toEqual([255, 0, 255, 255]);
    expect(m2.uniforms[glslOf(pass2.program!, 'SkySamp')].value).toBeNull(); // キューブは three.js の空のテクスチャ
    expect(inst2.warnings.some(x => x.includes('bad.dds'))).toBe(true);
  });

  it('dds から読んだミップは、MipFilter があれば使い、GL で作り直さない (2D もキューブも)', async () => {
    const FX2 = String.raw`
texture Tex < string ResourceName = "t.dds"; >;
sampler TexSamp = sampler_state { texture = <Tex>; MinFilter = LINEAR; MagFilter = LINEAR; MipFilter = LINEAR; };
texture Sky < string ResourceName = "sky.dds"; >;
samplerCUBE SkySamp = sampler_state { texture = <Sky>; MinFilter = LINEAR; MagFilter = LINEAR; MipFilter = LINEAR; };
float4 VS(float4 p : POSITION, out float3 d : TEXCOORD0) : POSITION { d = p.xyz; return p; }
float4 PS(float3 d : TEXCOORD0) : COLOR0 { return tex2D(TexSamp, d.xy) + texCUBE(SkySamp, d); }
technique T { pass P { VertexShader = compile vs_3_0 VS(); PixelShader = compile ps_3_0 PS(); } }
`;
    const files: [string, Uint8Array][] = [
      ['sub/t.dds', buildDds({ format: 'A16B16G16R16F', width: 4, height: 4, mips: 3 })],
      ['sub/sky.dds', buildDds({ format: 'A16B16G16R16F', width: 4, height: 4, mips: 3, cube: true })],
    ];
    const e = loadEffect(FX2, files);
    const inst = new EffectInstance(e, () => {});
    await inst.ready();
    expect(inst.warnings).toEqual([]);
    const pass = passOf(e, 'P');
    const m = inst.material(pass, 1, OBJECT)!;
    inst.bind(m, pass, makeCtx(), BUILTINS, noTextures());
    const flat = m.uniforms[glslOf(pass.program!, 'TexSamp')].value as THREE.DataTexture;
    const cube = m.uniforms[glslOf(pass.program!, 'SkySamp')].value as THREE.CubeTexture;
    expect(flat.isDataTexture).toBe(true);
    expect(cube.isCubeTexture).toBe(true);
    for (const tex of [flat, cube]) {
      expect(tex).toMatchObject({ minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false, flipY: false, colorSpace: THREE.NoColorSpace });
      expect(tex.mipmaps.length).toBeGreaterThan(0);
    }
  });

  it('ready は最初に読み始めた画像が全部読み終える (か失敗する) と終わる', async () => {
    const e = loadEffect();
    let resolve: (t: THREE.Texture) => void = () => {};
    const inst = new EffectInstance(e, () => {}, () => new Promise(r => { resolve = r; }));
    let done = false;
    const ready = inst.ready().then(() => { done = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toBe(false);
    resolve(pixel([1, 2, 3, 4]));
    await ready;
    expect(done).toBe(true);
    // 失敗しても終わる
    const failing = new EffectInstance(loadEffect(), () => {}, async () => { throw new Error('x'); });
    await expect(failing.ready()).resolves.toBeUndefined();
  });
});
