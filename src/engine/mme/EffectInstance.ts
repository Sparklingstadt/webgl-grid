import * as THREE from 'three';
import type { EffectDesc, Param, Pass, RenderState, SamplerDecl, StateValue, TextureDecl, UniformRef } from '../../core/fx/index.ts';
import { dirname, joinPath } from '../../core/fx/source.ts';
import { msg, t } from '../../core/i18n.ts';
import { annotation } from '../../core/mme/annotations.ts';
import { semanticValue, textureRole, type SemanticContext } from '../../core/mme/semantics.ts';
import { typeShape } from '../../core/mme/typeShape.ts';
import { readBinary, type LoadedEffect } from './EffectStore.ts';
import { cloneTexture, decodeTexture } from './textures.ts';

// --- 1 つのエフェクトの GPU の資源: pass ごとの RawShaderMaterial、ResourceName のテクスチャ、パラメータの値 ---

export interface DrawBuiltins { flipY: 1 | -1; halfPixel: [number, number]; viewport: [number, number] }
export interface TextureSource {
  role(name: string): THREE.Texture | null; // 'material' | 'sphere' | 'toon' | 'selfShadow' と、レンダーターゲットの名前
}
// pass を描く場面。MMD がデバイスに残しているステート (pass のステートの前に置く) を決める
export interface BaseState { kind: 'object' | 'shadow' | 'zplot' | 'edge' | 'post'; doubleSided: boolean }
export type Decode = (bytes: Uint8Array, path: string) => Promise<THREE.Texture>;

// three.js は frontFace を CCW にしているので、FrontSide は「CW を消す」。上下を返すと回る向きが逆になる
export function cullSide(cull: string, flipY: 1 | -1): THREE.Side {
  if (cull === 'NONE') return THREE.DoubleSide;
  return (cull === 'CW') === (flipY === 1) ? THREE.FrontSide : THREE.BackSide;
}

// --- 描画ステート ---
const D3D_DEFAULTS: Record<string, StateValue> = {
  AlphaBlendEnable: false, SrcBlend: 'ONE', DestBlend: 'ZERO', BlendOp: 'ADD',
  SeparateAlphaBlendEnable: false, SrcBlendAlpha: 'ONE', DestBlendAlpha: 'ZERO', BlendOpAlpha: 'ADD',
  ZEnable: true, ZWriteEnable: true, ZFunc: 'LESSEQUAL', CullMode: 'CCW',
  StencilEnable: false, StencilFunc: 'ALWAYS', StencilRef: 0, StencilMask: 0xffffffff, StencilWriteMask: 0xffffffff,
  StencilFail: 'KEEP', StencilZFail: 'KEEP', StencilPass: 'KEEP',
  BlendFactor: 0xffffffff, DepthBias: 0, SlopeScaleDepthBias: 0, FillMode: 'SOLID',
};
const BLEND_FACTOR: Record<string, THREE.BlendingSrcFactor> = {
  ZERO: THREE.ZeroFactor, ONE: THREE.OneFactor, SRCCOLOR: THREE.SrcColorFactor, INVSRCCOLOR: THREE.OneMinusSrcColorFactor,
  SRCALPHA: THREE.SrcAlphaFactor, INVSRCALPHA: THREE.OneMinusSrcAlphaFactor, DESTALPHA: THREE.DstAlphaFactor, INVDESTALPHA: THREE.OneMinusDstAlphaFactor,
  DESTCOLOR: THREE.DstColorFactor, INVDESTCOLOR: THREE.OneMinusDstColorFactor, SRCALPHASAT: THREE.SrcAlphaSaturateFactor,
  BLENDFACTOR: THREE.ConstantColorFactor, INVBLENDFACTOR: THREE.OneMinusConstantColorFactor,
};
const BLEND_OP: Record<string, THREE.BlendingEquation> = {
  ADD: THREE.AddEquation, SUBTRACT: THREE.SubtractEquation, REVSUBTRACT: THREE.ReverseSubtractEquation, MIN: THREE.MinEquation, MAX: THREE.MaxEquation,
};
const DEPTH_FUNC: Record<string, THREE.DepthModes> = {
  NEVER: THREE.NeverDepth, LESS: THREE.LessDepth, EQUAL: THREE.EqualDepth, LESSEQUAL: THREE.LessEqualDepth,
  GREATER: THREE.GreaterDepth, NOTEQUAL: THREE.NotEqualDepth, GREATEREQUAL: THREE.GreaterEqualDepth, ALWAYS: THREE.AlwaysDepth,
};
const STENCIL_FUNC: Record<string, THREE.StencilFunc> = {
  NEVER: THREE.NeverStencilFunc, LESS: THREE.LessStencilFunc, EQUAL: THREE.EqualStencilFunc, LESSEQUAL: THREE.LessEqualStencilFunc,
  GREATER: THREE.GreaterStencilFunc, NOTEQUAL: THREE.NotEqualStencilFunc, GREATEREQUAL: THREE.GreaterEqualStencilFunc, ALWAYS: THREE.AlwaysStencilFunc,
};
const STENCIL_OP: Record<string, THREE.StencilOp> = {
  KEEP: THREE.KeepStencilOp, ZERO: THREE.ZeroStencilOp, REPLACE: THREE.ReplaceStencilOp, INCRSAT: THREE.IncrementStencilOp,
  DECRSAT: THREE.DecrementStencilOp, INVERT: THREE.InvertStencilOp, INCR: THREE.IncrementWrapStencilOp, DECR: THREE.DecrementWrapStencilOp,
};
// 値が true (FillMode は書いた値) なら対応していないので警告するステート
const UNSUPPORTED_ON: Record<string, string> = {
  AlphaTestEnable: msg('AlphaTestEnable (アルファテスト) には対応していないので無視します'),
  TwoSidedStencilMode: msg('TwoSidedStencilMode (裏の面のステンシル) には対応していないので無視します'),
  SRGBWriteEnable: msg('SRGBWriteEnable には対応していないので無視します'),
  ScissorTestEnable: msg('ScissorTestEnable には対応していないので無視します'),
  PointSpriteEnable: msg('PointSpriteEnable には対応していないので無視します'),
};
// 黙って無視するステート (固定機能の値で、使う側のステートがオフなら意味がないもの)
const IGNORED = new Set(['AlphaFunc', 'AlphaRef', 'CCW_StencilFunc', 'CCW_StencilPass', 'CCW_StencilFail', 'CCW_StencilZFail', 'MultiSampleAntialias', 'ShadeMode']);

// D3D の既定の上に states を順に重ねて (後に書いたものが勝つ)、材質に移す。戻り値は警告
export function applyStates(m: THREE.Material, states: RenderState[], flipY: 1 | -1): string[] {
  const warnings: string[] = [];
  const v: Record<string, StateValue> = { ...D3D_DEFAULTS };
  const colorMask = [15, 15, 15, 15];
  for (const s of states) {
    if (typeof s.value === 'object' && !Array.isArray(s.value)) {
      warnings.push(t('ステート {name} の値 ({expr}) を計算できないので、既定の値にします', { name: s.name, expr: s.value.expr }));
      continue;
    }
    if (s.name === 'ColorWriteEnable') colorMask[s.index ?? 0] = Number(s.value);
    else v[s.name] = s.value;
  }
  const str = (name: string) => String(v[name]);
  const num = (name: string) => Number(v[name]);
  // ブレンド
  if (v.AlphaBlendEnable === true) {
    m.blending = THREE.CustomBlending;
    let src = BLEND_FACTOR[str('SrcBlend')] ?? THREE.OneFactor;
    let dst = BLEND_FACTOR[str('DestBlend')] ?? THREE.ZeroFactor;
    // BOTHSRCALPHA・BOTHINVSRCALPHA は SrcBlend に書くと DestBlend も決める
    if (str('SrcBlend') === 'BOTHSRCALPHA') { src = THREE.SrcAlphaFactor; dst = THREE.OneMinusSrcAlphaFactor; }
    if (str('SrcBlend') === 'BOTHINVSRCALPHA') { src = THREE.OneMinusSrcAlphaFactor; dst = THREE.SrcAlphaFactor; }
    m.blendSrc = src;
    m.blendDst = dst as THREE.BlendingDstFactor;
    m.blendEquation = BLEND_OP[str('BlendOp')] ?? THREE.AddEquation;
    const separate = v.SeparateAlphaBlendEnable === true;
    m.blendSrcAlpha = separate ? (BLEND_FACTOR[str('SrcBlendAlpha')] ?? THREE.OneFactor) : null;
    m.blendDstAlpha = separate ? ((BLEND_FACTOR[str('DestBlendAlpha')] ?? THREE.ZeroFactor) as THREE.BlendingDstFactor) : null;
    m.blendEquationAlpha = separate ? (BLEND_OP[str('BlendOpAlpha')] ?? THREE.AddEquation) : null;
    // BlendFactor は D3DCOLOR (0xAARRGGBB)
    const c = num('BlendFactor') >>> 0;
    m.blendColor.setRGB(((c >>> 16) & 255) / 255, ((c >>> 8) & 255) / 255, (c & 255) / 255, THREE.LinearSRGBColorSpace);
    m.blendAlpha = ((c >>> 24) & 255) / 255;
  } else {
    m.blending = THREE.NoBlending;
  }
  // 深度・面
  m.depthTest = v.ZEnable === true;
  m.depthWrite = v.ZWriteEnable === true;
  m.depthFunc = DEPTH_FUNC[str('ZFunc')] ?? THREE.LessEqualDepth;
  m.side = cullSide(str('CullMode'), flipY);
  // 深度のずらし (D3D の DepthBias は深度 0〜1 の量。24 ビットの深度の単位に直す)
  m.polygonOffset = num('DepthBias') !== 0 || num('SlopeScaleDepthBias') !== 0;
  m.polygonOffsetFactor = num('SlopeScaleDepthBias');
  m.polygonOffsetUnits = num('DepthBias') * 2 ** 24;
  // ステンシル (three.js は stencilWrite でステンシルを使う)
  m.stencilWrite = v.StencilEnable === true;
  m.stencilFunc = STENCIL_FUNC[str('StencilFunc')] ?? THREE.AlwaysStencilFunc;
  m.stencilRef = num('StencilRef');
  m.stencilFuncMask = num('StencilMask') & 0xff;
  m.stencilWriteMask = num('StencilWriteMask') & 0xff;
  m.stencilFail = STENCIL_OP[str('StencilFail')] ?? THREE.KeepStencilOp;
  m.stencilZFail = STENCIL_OP[str('StencilZFail')] ?? THREE.KeepStencilOp;
  m.stencilZPass = STENCIL_OP[str('StencilPass')] ?? THREE.KeepStencilOp;
  // 色の書き込み: RGBA ごとには分けられないので、少しでも書くなら全部
  m.colorWrite = colorMask[0] !== 0;
  if (colorMask[0] !== 0 && colorMask[0] !== 15) warnings.push(t('ColorWriteEnable は RGBA ごとに分けられないので、全部を書きます'));
  for (let i = 1; i < 4; i++) {
    if (colorMask[i] !== 15) warnings.push(t('ColorWriteEnable{i} には対応していないので無視します', { i }));
  }
  // 塗り方
  const fill = str('FillMode');
  if (m instanceof THREE.ShaderMaterial) m.wireframe = fill === 'WIREFRAME';
  if (fill === 'POINT') warnings.push(t('FillMode = POINT には対応していないので無視します'));
  // 対応していない・知らないステート
  for (const s of states) {
    const known = UNSUPPORTED_ON[s.name];
    if (known !== undefined) {
      const text = t(known);
      if (v[s.name] === true && !warnings.includes(text)) warnings.push(text);
    } else if (!(s.name in D3D_DEFAULTS) && s.name !== 'ColorWriteEnable' && !IGNORED.has(s.name)) {
      const text = t('知らないステート {name} を無視します', { name: s.name });
      if (!warnings.includes(text)) warnings.push(text);
    }
  }
  return warnings;
}

// MMD がデバイスに残しているステート (pass のステートの前に置く)
function baseStates(base: BaseState): RenderState[] {
  if (base.kind === 'post') {
    return [
      { name: 'AlphaBlendEnable', value: false }, { name: 'SrcBlend', value: 'SRCALPHA' }, { name: 'DestBlend', value: 'INVSRCALPHA' }, { name: 'ZEnable', value: false },
      { name: 'ZWriteEnable', value: false }, { name: 'CullMode', value: 'NONE' },
    ];
  }
  const states: RenderState[] = [
    { name: 'AlphaBlendEnable', value: base.kind !== 'zplot' },
    { name: 'SrcBlend', value: 'SRCALPHA' }, { name: 'DestBlend', value: 'INVSRCALPHA' },
    { name: 'ZEnable', value: true }, { name: 'ZWriteEnable', value: true }, { name: 'ZFunc', value: 'LESSEQUAL' },
    { name: 'CullMode', value: base.kind === 'edge' ? 'CW' : base.doubleSided ? 'NONE' : 'CCW' },
  ];
  // 地面の影: 書いた画素のステンシルを 1 にし、1 の画素には描かない (影が重なっても 1 回だけ暗くする。ステンシルはフレームの初めに 0 で消す)
  if (base.kind === 'shadow') {
    states.push(
      { name: 'StencilEnable', value: true }, { name: 'StencilFunc', value: 'NOTEQUAL' }, { name: 'StencilRef', value: 1 },
      { name: 'StencilFail', value: 'KEEP' }, { name: 'StencilZFail', value: 'KEEP' }, { name: 'StencilPass', value: 'REPLACE' },
    );
  }
  return states;
}

// --- uniform の値 ---
function countOf(type: string): number {
  const s = typeShape(type);
  return s ? s.elems * s.rows * s.cols : 1;
}

// 型の数の個数にそろえる (足りなければ 0)
function fitLength(values: number[], n: number): number[] {
  const out = values.slice(0, n);
  while (out.length < n) out.push(0);
  return out;
}

// three.js に渡す値。スカラーは数、非正方の行列は 1 つを 16 個に詰める (HLSL の r 行 c 列 → r * 4 + c、残りは 0)
function uniformValue(u: UniformRef, values: number[]): number | number[] {
  const s = typeShape(u.type);
  if (!s) return values.length === 1 ? values[0] : values;
  const n = s.rows * s.cols;
  const v = fitLength(values, s.elems * n);
  if (u.upload === 'mat4') {
    const out = Array.from({ length: s.elems * 16 }, () => 0);
    for (let k = 0; k < s.elems; k++) {
      for (let r = 0; r < s.rows; r++) for (let c = 0; c < s.cols; c++) out[k * 16 + r * 4 + c] = v[k * n + r * s.cols + c];
    }
    return out;
  }
  return n === 1 && !s.array ? v[0] : v;
}

// --- テクスチャ ---
function pixelTexture(rgba: number[]): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array(rgba), 1, 1);
  t.needsUpdate = true;
  return t;
}

type Fallback = 'magenta' | 'blank' | 'white';
interface FileTexture { label: string; tex: THREE.Texture | null; failed: boolean }
interface Copy { tex: THREE.Texture; version: number }

export const MAG_FILTER: Record<string, THREE.MagnificationTextureFilter> = { NONE: THREE.NearestFilter, POINT: THREE.NearestFilter, LINEAR: THREE.LinearFilter, ANISOTROPIC: THREE.LinearFilter };
export const WRAP: Record<string, THREE.Wrapping> = { WRAP: THREE.RepeatWrapping, MIRROR: THREE.MirroredRepeatWrapping, CLAMP: THREE.ClampToEdgeWrapping };

export function minFilter(min: string, mip: string): THREE.MinificationTextureFilter {
  const linear = min === 'LINEAR' || min === 'ANISOTROPIC';
  if (mip === 'POINT') return linear ? THREE.LinearMipmapNearestFilter : THREE.NearestMipmapNearestFilter;
  if (mip === 'LINEAR' || mip === 'ANISOTROPIC') return linear ? THREE.LinearMipmapLinearFilter : THREE.NearestMipmapLinearFilter;
  return linear ? THREE.LinearFilter : THREE.NearestFilter;
}

// ファイルから読んだミップを持つか (圧縮したもの、dds の無圧縮のもの)。持つなら GL で作り直さない
function hasOwnMips(t: THREE.Texture): boolean {
  return t instanceof THREE.CompressedTexture || t.mipmaps.length > 0;
}

// ミップマップを持てるか (圧縮したものと、dds から読んだものは、読んだミップだけ。ほかは GL が作る)
function canMip(t: THREE.Texture): boolean {
  if (t instanceof THREE.CompressedCubeTexture) return ((t.image[0] as { mipmaps?: unknown[] } | undefined)?.mipmaps?.length ?? 0) > 1;
  if (t instanceof THREE.CompressedTexture) return t.mipmaps.length > 1;
  return t.generateMipmaps || t.mipmaps.length > 0;
}

function fitsDim(dim: SamplerDecl['dim'], t: THREE.Texture): boolean {
  const cube = (t as Partial<THREE.CubeTexture>).isCubeTexture === true;
  const vol = (t as Partial<THREE.Data3DTexture>).isData3DTexture === true;
  if (dim === 'CUBE') return cube;
  if (dim === '3D') return vol;
  return !cube && !vol;
}

const EMPTY: EffectDesc = { params: [], textures: [], samplers: [], techniques: [] };

export class EffectInstance {
  readonly warnings: string[] = [];
  stopped = false; // GPU で使えない (シェーダーをリンクできない)。物は default.fx で描き、ポストエフェクトは飛ばす
  private desc: EffectDesc;
  private params = new Map<string, Param>();
  private textureDecls = new Map<string, TextureDecl>();
  private samplers = new Map<string, SamplerDecl>();
  private overrides = new Map<string, number[]>();
  private materials = new Map<Pass, Map<string, THREE.RawShaderMaterial>>();
  private files = new Map<string, FileTexture>();
  private copies = new Map<THREE.Texture, { bySampler: Map<string, Copy>; onDispose: () => void }>();
  private fallbacks: Record<Fallback, THREE.DataTexture>;
  private loads: Promise<void>[] = [];
  private disposed = false;

  constructor(private effect: LoadedEffect, private requestDraw: () => void, private decode: Decode = decodeTexture) {
    this.desc = effect.result.ok ? effect.result.effect : EMPTY;
    for (const p of this.desc.params) this.params.set(p.name, p);
    for (const t of this.desc.textures) this.textureDecls.set(t.name, t);
    for (const s of this.desc.samplers) this.samplers.set(s.name, s);
    this.fallbacks = { magenta: pixelTexture([255, 0, 255, 255]), blank: pixelTexture([0, 0, 0, 255]), white: pixelTexture([255, 255, 255, 255]) };
    // ResourceName の画像は最初に全部読み始める (書き出しまでに読み終えるように)
    for (const t of this.desc.textures) if (textureRole(t) === 'file') this.loadFile(t);
  }

  // program がない pass は null。flipY と場面ごとに面の向きとステートを変えた材質
  material(pass: Pass, flipY: 1 | -1, base: BaseState): THREE.RawShaderMaterial | null {
    const prog = pass.program;
    if (!prog) return null;
    let byKey = this.materials.get(pass);
    if (!byKey) this.materials.set(pass, (byKey = new Map()));
    const key = `${flipY} ${base.kind} ${base.doubleSided}`;
    let m = byKey.get(key);
    if (m) return m;
    const uniforms: Record<string, THREE.IUniform> = {};
    for (const u of prog.uniforms) uniforms[u.glslName] = { value: u.kind === 'sampler' ? null : this.valueOf(u, null) };
    // three.js は先頭に #define を足して #version を自分で書くので、1 行目の #version を除く
    const strip = (src: string) => (src.startsWith('#version') ? src.slice(src.indexOf('\n') + 1) : src);
    m = new THREE.RawShaderMaterial({ vertexShader: strip(prog.vertex), fragmentShader: strip(prog.fragment), glslVersion: THREE.GLSL3, uniforms });
    m.name = pass.name;
    for (const w of applyStates(m, [...baseStates(base), ...pass.states], flipY)) this.warn(w);
    byKey.set(key, m);
    return m;
  }

  bind(m: THREE.RawShaderMaterial, pass: Pass, ctx: SemanticContext, builtins: DrawBuiltins, textures: TextureSource): void {
    const prog = pass.program;
    if (!prog) return;
    for (const u of prog.uniforms) {
      const slot = m.uniforms[u.glslName];
      if (!slot) continue;
      if (u.kind === 'builtin') {
        if (u.name === 'mme_flipY') slot.value = builtins.flipY;
        else if (u.name === 'mme_halfPixel') slot.value = builtins.halfPixel.slice();
        else if (u.name === 'mme_viewport') slot.value = builtins.viewport.slice();
      } else if (u.kind === 'sampler') {
        const s = this.samplers.get(u.name);
        slot.value = s ? this.samplerTexture(s, textures) : null;
      } else {
        slot.value = this.valueOf(u, ctx);
      }
    }
    m.uniformsNeedUpdate = true;
  }

  // パラメータのいまの値 (setParam で入れた値か初期値)。知らない名前は null
  param(name: string): number[] | null {
    const o = this.overrides.get(name);
    if (o) return o.slice();
    const p = this.params.get(name);
    if (!p) return null;
    return Array.isArray(p.init) ? p.init.slice() : fitLength([], countOf(p.type));
  }

  // 最初に読み始めた画像が全部、読み終えるか失敗したら終わる
  async ready(): Promise<void> {
    await Promise.all(this.loads);
  }

  setParam(name: string, values: number[]): void {
    this.overrides.set(name, values.slice());
  }

  dispose(): void {
    this.disposed = true;
    for (const byKey of this.materials.values()) for (const m of byKey.values()) m.dispose();
    this.materials.clear();
    for (const [orig, entry] of this.copies) {
      orig.removeEventListener('dispose', entry.onDispose);
      for (const c of entry.bySampler.values()) c.tex.dispose();
    }
    this.copies.clear();
    for (const f of this.files.values()) f.tex?.dispose();
    this.files.clear();
    for (const t of Object.values(this.fallbacks)) t.dispose();
  }

  // 警告を足す (同じものは 1 回)
  warn(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }

  // 初期値 → セマンティクス → (名前で決まる変数はセマンティクスの中) の順。setParam の値がいちばん強い
  private valueOf(u: UniformRef, ctx: SemanticContext | null): number | number[] {
    const p = this.params.get(u.name);
    if (!p) return uniformValue(u, []);
    let values = this.overrides.get(u.name) ?? null;
    if (!values) {
      values = Array.isArray(p.init) ? p.init : null;
      if (ctx) {
        const r = semanticValue(p, ctx);
        if (r.kind === 'numbers') values = r.values;
        else if (r.kind === 'unsupported') this.warn(t('セマンティクス {semantic} には値を入れません ({name})', { semantic: r.what, name: p.name }));
      }
    }
    return uniformValue(u, values ?? []);
  }

  // ResourceName をエフェクトのファイルのフォルダから探して読む (大文字小文字と '\' は問わない)
  private loadFile(decl: TextureDecl): void {
    const a = annotation(decl.annotations, 'ResourceName');
    const name = typeof a?.value === 'string' ? a.value : '';
    const entry: FileTexture = { label: name, tex: null, failed: false };
    this.files.set(decl.name, entry);
    const path = joinPath(dirname(this.effect.entry), name);
    const mip = annotation(decl.annotations, 'MipLevels');
    const mipmaps = !(Array.isArray(mip?.value) && mip.value[0] === 1);
    const load = readBinary(this.effect.folder, path).then(bytes => (bytes && !this.disposed ? this.decode(bytes, path) : null)).then(tex => {
      if (this.disposed) { tex?.dispose(); return; }
      if (!tex) {
        entry.failed = true;
        this.warn(t('テクスチャ {name} が見つかりません', { name }));
        this.requestDraw();
        return;
      }
      tex.colorSpace = THREE.NoColorSpace;
      tex.flipY = false;
      tex.generateMipmaps = mipmaps && !hasOwnMips(tex);
      entry.tex = tex;
      this.requestDraw();
    }, (e: unknown) => {
      if (this.disposed) return;
      entry.failed = true;
      this.warn(t('テクスチャ {name} を読めませんでした: {error}', { name, error: e instanceof Error ? e.message : String(e) }));
      this.requestDraw();
    });
    this.loads.push(load);
  }

  // サンプラーに入れるテクスチャ。three.js の空のテクスチャを使わせるときは null
  private samplerTexture(s: SamplerDecl, textures: TextureSource): THREE.Texture | null {
    const r = this.sourceOf(s, textures);
    const flat = s.dim === '2D' || s.dim === '1D';
    if (typeof r === 'string') return flat ? this.fallbacks[r] : null;
    if (!fitsDim(s.dim, r.tex)) {
      this.warn(t('サンプラー {name} の形 ({dim}) とテクスチャの形が合いません', { name: s.name, dim: s.dim }));
      return flat ? this.fallbacks.magenta : null;
    }
    return r.copy ? this.copyFor(s, r.tex, r.keepFlip === true) : r.tex;
  }

  // copy: サンプラーの設定を移した写しを作るか (レンダーターゲットはそのまま渡す)。keepFlip: 写しの上下を元のままにする (標準の材質の画像)
  private sourceOf(s: SamplerDecl, textures: TextureSource): { tex: THREE.Texture; copy: boolean; keepFlip?: boolean } | Fallback {
    if (s.texture === null) {
      // MMD 標準のシェーダーはセルフシャドウの深度を register(s0) で受け取る
      if (s.register === 's0') {
        const t = textures.role('selfShadow');
        return t ? { tex: t, copy: false } : 'white';
      }
      this.warn(t('サンプラー {name} にテクスチャがありません', { name: s.name }));
      return 'blank';
    }
    const decl = this.textureDecls.get(s.texture);
    if (!decl) {
      this.warn(t('サンプラー {name} のテクスチャ {texture} がありません', { name: s.name, texture: s.texture }));
      return 'magenta';
    }
    const role = textureRole(decl);
    switch (role) {
      case 'material': case 'sphere': case 'toon': {
        const tex = textures.role(role);
        return tex ? { tex, copy: true, keepFlip: role === 'material' } : 'white';
      }
      case 'colorTarget': {
        const tex = textures.role(decl.name);
        if (tex) return { tex, copy: false };
        this.warn(t('レンダーターゲット {name} がありません', { name: decl.name }));
        return 'magenta';
      }
      case 'file': {
        const f = this.files.get(decl.name);
        if (!f || f.failed) return 'magenta';
        return f.tex ? { tex: f.tex, copy: true } : 'blank';
      }
      case 'depthTarget':
        this.warn(t('深度のターゲット {name} はテクスチャとして読めません', { name: decl.name }));
        return 'magenta';
      case 'unsupported':
        this.warn(t('テクスチャ {name} のセマンティクス {semantic} には対応していません', { name: decl.name, semantic: decl.semantic ?? '' }));
        return 'blank';
      case 'none':
        if (decl.semantic !== null) this.warn(t('テクスチャ {name} のセマンティクス {semantic} を知りません', { name: decl.name, semantic: decl.semantic }));
        return 'blank';
    }
  }

  // サンプラーごと・元のテクスチャごとの写し (source は共有)。ガンマ空間のまま。上下は、.fx のフォルダの画像は返さず、
  // 標準の材質から写す画像 (MATERIALTEXTURE など) は元のまま (形の画像は flipY = true で three.js の UV と組む。MMD モデルのものは元から false)
  private copyFor(s: SamplerDecl, orig: THREE.Texture, keepFlip: boolean): THREE.Texture {
    let entry = this.copies.get(orig);
    if (!entry) {
      const bySampler = new Map<string, Copy>();
      // 元を捨てたら写しも捨てる
      const onDispose = () => {
        for (const c of bySampler.values()) c.tex.dispose();
        this.copies.delete(orig);
        orig.removeEventListener('dispose', onDispose);
      };
      orig.addEventListener('dispose', onDispose);
      this.copies.set(orig, (entry = { bySampler, onDispose }));
    }
    const c = entry.bySampler.get(s.name);
    if (c) {
      // 元の画像が差し替えられたら、写しも読み直す
      if (c.version !== orig.version) { c.tex.needsUpdate = true; c.version = orig.version; }
      return c.tex;
    }
    const tex = cloneTexture(orig);
    tex.colorSpace = THREE.NoColorSpace;
    tex.flipY = keepFlip ? orig.flipY : false;
    this.applySampler(tex, s, canMip(orig));
    entry.bySampler.set(s.name, { tex, version: orig.version });
    return tex;
  }

  // MinFilter・MagFilter・MipFilter・AddressU/V/W・MaxAnisotropy を移す (書いていなければ D3D の既定)
  private applySampler(tex: THREE.Texture, s: SamplerDecl, mipmaps: boolean): void {
    const v: Record<string, StateValue> = { MinFilter: 'POINT', MagFilter: 'POINT', MipFilter: 'NONE', AddressU: 'WRAP', AddressV: 'WRAP', AddressW: 'WRAP', MaxAnisotropy: 1 };
    for (const st of s.states) {
      if (typeof st.value === 'object' && !Array.isArray(st.value)) {
        this.warn(t('サンプラー {name} の {state} の値 ({expr}) を計算できないので、既定の値にします', { name: s.name, state: st.name, expr: st.value.expr }));
        continue;
      }
      v[st.name] = st.value;
      if (st.name === 'SRGBTexture' && st.value === true) this.warn(t('サンプラー {name} の SRGBTexture には対応していないので無視します', { name: s.name }));
    }
    const mip = mipmaps ? String(v.MipFilter) : 'NONE';
    tex.minFilter = minFilter(String(v.MinFilter), mip);
    tex.magFilter = MAG_FILTER[String(v.MagFilter)] ?? THREE.NearestFilter;
    if (!hasOwnMips(tex)) tex.generateMipmaps = mip !== 'NONE';
    const aniso = v.MinFilter === 'ANISOTROPIC' || v.MagFilter === 'ANISOTROPIC';
    tex.anisotropy = aniso ? Math.max(1, Number(v.MaxAnisotropy)) : 1;
    const wrap = (name: string): THREE.Wrapping => {
      const a = String(v[name]);
      if (a in WRAP) return WRAP[a];
      this.warn(t('サンプラー {name}: {key} = {value} は GL にないので CLAMP にします', { name: s.name, key: name, value: a }));
      return THREE.ClampToEdgeWrapping;
    };
    tex.wrapS = wrap('AddressU');
    tex.wrapT = wrap('AddressV');
    if (tex instanceof THREE.Data3DTexture) tex.wrapR = wrap('AddressW');
  }
}
