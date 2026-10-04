import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { compileEffect, type Pass, type Program } from '../../core/fx/index.ts';
import { semanticValue, SHADOW_COLOR, type MaterialState, type SemanticContext } from '../../core/mme/semantics.ts';
import type { UiChannel } from '../UiChannel';
import { EffectStore, type LoadedEffect } from './EffectStore.ts';
import { applyStates, cullSide, decodeTexture, EffectInstance, type BaseState, type DrawBuiltins, type TextureSource } from './EffectInstance.ts';

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
  pass Empty { }
}
`;

// フォルダごと読んだエフェクト (EffectStore.load と同じ形)
function loadEffect(): LoadedEffect {
  const bytes = new Map<string, Uint8Array>([
    ['sub/effect.fx', new TextEncoder().encode(FX)],
    ['sub/tex/stone.png', new Uint8Array([9, 8, 7])],
  ]);
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
    // pass が書いたステートが勝つ
    expect(inst.material(passOf(e, 'P'), 1, OBJECT)).toMatchObject({ blending: THREE.NoBlending, side: THREE.DoubleSide });
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

  it('材質のテクスチャは色の空間を変えた写し (元は変えない)、セルフシャドウとレンダーターゲットはそのまま渡す', () => {
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
    expect(obj).toMatchObject({ colorSpace: THREE.NoColorSpace, flipY: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
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

  it('既定の decode は .tga を three.js の TGALoader で読む (上下を返さない)', async () => {
    // 1×2・32 ビット・左下が原点の TGA (画素は BGRA。ファイルでは下の行 (青) が先)
    const tga = new Uint8Array([0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 2, 0, 32, 0x08, 255, 0, 0, 255, 0, 0, 255, 255]);
    const t = await decodeTexture(tga, 'tex/a.TGA') as THREE.DataTexture;
    expect(t.image).toMatchObject({ width: 1, height: 2 });
    // 1 行目が画像の上の行 (赤)。D3D と同じく v = 0 が上になる
    expect([...(t.image.data as Uint8Array)]).toEqual([255, 0, 0, 255, 0, 0, 255, 255]);
    expect(t).toMatchObject({ flipY: false, colorSpace: THREE.NoColorSpace });
  });
});
