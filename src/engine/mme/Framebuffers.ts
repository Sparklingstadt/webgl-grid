import * as THREE from 'three';
import type { EffectDesc, StateValue } from '../../core/fx/index.ts';
import { t } from '../../core/i18n.ts';
import { textureRole } from '../../core/mme/semantics.ts';
import { targetSpec, type TargetFormat } from '../../core/mme/targets.ts';
import { MAG_FILTER, minFilter, WRAP } from './EffectInstance';
import type { LoadedEffect } from './EffectStore';

// --- MME のレンダーターゲット (RENDERCOLORTARGET・RENDERDEPTHSTENCILTARGET) と、その組み合わせのフレームバッファ ---
// 色のテクスチャは three.js の Texture (initTexture で GPU に作る)、深度・ステンシルは自分で作る renderbuffer (DEPTH24_STENCIL8)。
// 色 (最大 4 つ) と深度の組み合わせごとに gl のフレームバッファを作り、setRenderTargetFramebuffer で WebGLRenderTarget に付けて使う

// 描画先: 上下の向き (canvas は 1、レンダーターゲットは −1) と画素の数
export interface DrawTarget { flipY: 1 | -1; size: [number, number] }

export interface ColorTarget {
  kind: 'color'; id: number; effect: LoadedEffect | null; name: string; width: number; height: number;
  format: TargetFormat; mipmaps: boolean; key: string; tex: THREE.DataTexture; gl: WebGLTexture;
}
export interface DepthTarget { kind: 'depth'; id: number; effect: LoadedEffect | null; name: string; width: number; height: number; rb: WebGLRenderbuffer; stale: boolean }
type Target = ColorTarget | DepthTarget;

// 描画先の全体。targets の depth が null なら、色と同じ大きさの共有の深度 (MME の既定の深度の代わり)
export type Surface =
  | { kind: 'canvas' }
  | { kind: 'three'; target: THREE.WebGLRenderTarget } // three.js のレンダーターゲット (セルフシャドウの深度マップ)
  | { kind: 'targets'; colors: (ColorTarget | null)[]; depth: DepthTarget | null };
export const CANVAS: Surface = { kind: 'canvas' };

export interface FramebufferEvents {
  warn(message: string, effect: LoadedEffect | null): void; // effect: そのエフェクトの警告 (null は全体の警告)
  broken(effects: LoadedEffect[]): void; // フレームバッファが不完全 (そのエフェクトを止める)
}

interface Fbo { fbo: WebGLFramebuffer; rt: THREE.WebGLRenderTarget; ids: number[]; ok: boolean }

const FORMATS: Record<TargetFormat, [THREE.PixelFormat, THREE.TextureDataType]> = {
  rgba8: [THREE.RGBAFormat, THREE.UnsignedByteType], rgba16f: [THREE.RGBAFormat, THREE.HalfFloatType], rgba32f: [THREE.RGBAFormat, THREE.FloatType],
  r16f: [THREE.RedFormat, THREE.HalfFloatType], r32f: [THREE.RedFormat, THREE.FloatType], rg16f: [THREE.RGFormat, THREE.HalfFloatType],
  rg32f: [THREE.RGFormat, THREE.FloatType], depth24stencil8: [THREE.RGBAFormat, THREE.UnsignedByteType],
};
const FLOAT32 = new Set<TargetFormat>(['rgba32f', 'r32f', 'rg32f']);
const HALF = new Set<TargetFormat>(['rgba16f', 'r16f', 'rg16f']);

export interface Sampling {
  minFilter: THREE.MinificationTextureFilter; magFilter: THREE.MagnificationTextureFilter; wrapS: THREE.Wrapping; wrapT: THREE.Wrapping; warnings: string[];
}

// レンダーターゲットのテクスチャの設定 (サンプラーごとの写しを作らないので、テクスチャ自身に入れる)。
// そのターゲットを読む最初のサンプラー (宣言の順) の MinFilter・MagFilter・MipFilter・AddressU/V。書いていなければ LINEAR・CLAMP
export function targetSampling(desc: EffectDesc, name: string, mipmaps: boolean): Sampling {
  const warnings: string[] = [];
  let first: Sampling | null = null;
  let firstName = '';
  for (const s of desc.samplers) {
    if (s.texture !== name) continue;
    const v: Record<string, StateValue> = { MinFilter: 'LINEAR', MagFilter: 'LINEAR', MipFilter: 'NONE', AddressU: 'CLAMP', AddressV: 'CLAMP' };
    for (const st of s.states) if (typeof st.value !== 'object' || Array.isArray(st.value)) v[st.name] = st.value;
    const wrap = (key: string): THREE.Wrapping => {
      const a = String(v[key]);
      if (a in WRAP) return WRAP[a];
      if (!first) warnings.push(t('サンプラー {name}: {key} = {value} は GL にないので CLAMP にします', { name: s.name, key, value: a }));
      return THREE.ClampToEdgeWrapping;
    };
    const mine: Sampling = {
      minFilter: minFilter(String(v.MinFilter), mipmaps ? String(v.MipFilter) : 'NONE'),
      magFilter: MAG_FILTER[String(v.MagFilter)] ?? THREE.LinearFilter,
      wrapS: wrap('AddressU'), wrapT: wrap('AddressV'), warnings,
    };
    if (!first) {
      first = mine;
      firstName = s.name;
    } else if (mine.minFilter !== first.minFilter || mine.magFilter !== first.magFilter || mine.wrapS !== first.wrapS || mine.wrapT !== first.wrapT) {
      warnings.push(t('レンダーターゲット {name} を違う設定のサンプラーで読んでいます。最初のサンプラー {first} の設定にします', { name, first: firstName }));
    }
  }
  return first ?? { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping, warnings };
}

// 一時的な描画先の選び方: 名前 (null は既定) を、既定の描画先 def と合わせて Surface にする (GL は使わない)
export function resolveSurface(
  def: Surface, colors: (ColorTarget | null)[], depth: DepthTarget | null, named: { colors: boolean[]; depth: boolean },
): { surface: Surface; warnings: string[] } {
  const warnings: string[] = [];
  const anyNamed = named.colors.some(Boolean) || named.depth;
  if (!anyNamed) return { surface: def, warnings };
  let lead: ColorTarget | null;
  if (named.colors[0]) lead = colors[0];
  else if (def.kind === 'targets') lead = def.colors[0];
  else {
    // canvas (やセルフシャドウの深度マップ) と自分のターゲットは、1 つのフレームバッファにできない
    const what = def.kind === 'canvas' ? 'canvas' : t('セルフシャドウの深度マップ');
    warnings.push(t('既定の描画先 ({what}) とレンダーターゲットは同時に使えないので、既定の描画先だけに描きます', { what }));
    return { surface: def, warnings };
  }
  if (!lead) return { surface: def, warnings };
  const out: (ColorTarget | null)[] = [lead];
  for (let i = 1; i < 4; i++) {
    const c = named.colors[i] ? colors[i] : null;
    if (c && (c.width !== lead.width || c.height !== lead.height)) {
      warnings.push(t('レンダーターゲット {name} の大きさが RenderColorTarget0 と違うので使いません', { name: c.name }));
      out.push(null);
    } else out.push(c);
  }
  while (out.length > 1 && out[out.length - 1] === null) out.pop();
  let d: DepthTarget | null = named.depth ? depth : def.kind === 'targets' ? def.depth : null;
  // GL では深度と色の大きさをそろえるので、違えば同じ大きさの共有の深度にする。D3D は色より大きい深度を使える
  // (縮めたターゲットに全面の深度を付けたまま描くのはよくある書き方) ので、警告は小さいときだけ
  if (d && (d.width !== lead.width || d.height !== lead.height)) {
    if (named.depth && (d.width < lead.width || d.height < lead.height)) {
      warnings.push(t('深度のターゲット {name} が色のターゲットより小さいので、同じ大きさの深度を使います', { name: d.name }));
    }
    d = null;
  }
  return { surface: { kind: 'targets', colors: out, depth: d }, warnings };
}

let nextId = 1;

export class Framebuffers {
  current: Surface = CANVAS;        // いま描画先にしているもの
  defaultSurface: Surface = CANVAS; // Script が「既定の描画先」と言ったときの描画先
  private gl: WebGL2RenderingContext;
  private effects = new Map<LoadedEffect, Map<string, Target>>();
  private fbos = new Map<string, Fbo>();
  private autoDepth = new Map<string, DepthTarget>(); // 大きさごとの共有の深度
  private screenTarget: ColorTarget | null = null;     // ポストエフェクトがあるときの canvas の代わり
  private screen: [number, number] = [0, 0];
  private reported = new Set<string>();

  constructor(private renderer: THREE.WebGLRenderer, private events: FramebufferEvents = { warn: () => {}, broken: () => {} }) {
    this.gl = renderer.getContext() as WebGL2RenderingContext;
  }

  // フレームの初め: 画面の大きさが変われば共有の深度を作り直し、共有の深度を消し直す印を付ける
  begin(screen: [number, number]): void {
    if (screen[0] !== this.screen[0] || screen[1] !== this.screen[1]) {
      this.screen = [screen[0], screen[1]];
      for (const d of this.autoDepth.values()) this.drop(d);
      this.autoDepth.clear();
      if (this.screenTarget) this.drop(this.screenTarget);
      this.screenTarget = null;
    }
    for (const d of this.autoDepth.values()) d.stale = true;
    this.current = CANVAS;
    this.defaultSurface = CANVAS;
  }

  // エフェクトの RENDERCOLORTARGET・RENDERDEPTHSTENCILTARGET を、いまの画面の大きさで用意する (大きさが変われば作り直す)。戻り値は警告
  prepare(effect: LoadedEffect, screen: [number, number]): string[] {
    const warnings: string[] = [];
    if (!effect.result.ok) return warnings;
    const desc = effect.result.effect;
    let targets = this.effects.get(effect);
    if (!targets) this.effects.set(effect, (targets = new Map()));
    for (const tex of desc.textures) {
      const role = textureRole(tex);
      if (role !== 'colorTarget' && role !== 'depthTarget') continue;
      const spec = targetSpec(tex, screen, role === 'depthTarget');
      warnings.push(...spec.warnings);
      const old = targets.get(tex.name);
      if (role === 'depthTarget') {
        if (old?.kind === 'depth' && old.width === spec.width && old.height === spec.height) continue;
        if (old) this.drop(old);
        targets.set(tex.name, this.makeDepth(effect, tex.name, spec.width, spec.height));
        continue;
      }
      const format = this.usable(spec.format, tex.name, warnings);
      const sampling = targetSampling(desc, tex.name, spec.mipmaps);
      warnings.push(...sampling.warnings);
      let mipmaps = spec.mipmaps;
      // 32 ビットの浮動小数は、OES_texture_float_linear がないと LINEAR で読めず、ミップも作れない (generateMipmap が INVALID_OPERATION)
      if (FLOAT32.has(format) && !this.renderer.extensions.has('OES_texture_float_linear')
        && (mipmaps || sampling.minFilter !== THREE.NearestFilter || sampling.magFilter !== THREE.NearestFilter)) {
        warnings.push(t('浮動小数のレンダーターゲット {name} を LINEAR で読めない環境なので、POINT にしてミップマップを作りません', { name: tex.name }));
        sampling.minFilter = THREE.NearestFilter;
        sampling.magFilter = THREE.NearestFilter;
        mipmaps = false;
      }
      const key = [spec.width, spec.height, format, mipmaps, sampling.minFilter, sampling.magFilter, sampling.wrapS, sampling.wrapT].join(' ');
      if (old?.kind === 'color' && old.key === key) continue;
      if (old) this.drop(old);
      targets.set(tex.name, this.makeColor(effect, tex.name, spec.width, spec.height, format, mipmaps, sampling, key));
    }
    return warnings;
  }

  // サンプラーに渡すテクスチャ (なければ null)
  colorTexture(effect: LoadedEffect, name: string): THREE.Texture | null {
    const t = this.effects.get(effect)?.get(name);
    return t?.kind === 'color' ? t.tex : null;
  }

  has(effect: LoadedEffect, name: string, kind: 'color' | 'depth'): boolean {
    return this.effects.get(effect)?.get(name)?.kind === kind;
  }

  // ポストエフェクトがあるときの canvas の代わり (画面の大きさ)。DX9 の画素の位置に合わせた全面の四角は、上と左の縁が画素の
  // 中心を通る。canvas に直接描くと、アンチエイリアスで縁が背景と混ざり、上下の向きも GL の塗りの決まり (メモリの先頭の行の縁を含む) と
  // 逆になって上の行が抜ける。ほかのレンダーターゲットと同じ向き (mme_flipY = −1。D3D の上の行がメモリの先頭) で描いて、
  // 上下を返して canvas に写す (PostChain.present)
  screenSurface(): Surface {
    if (!this.screenTarget) {
      const [w, h] = this.screen;
      const nearest: Sampling = { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping, warnings: [] };
      this.screenTarget = this.makeColor(null, '(screen)', w, h, 'rgba8', false, nearest, '');
    }
    return { kind: 'targets', colors: [this.screenTarget], depth: null };
  }
  get screenTexture(): THREE.Texture | null {
    return this.screenTarget?.tex ?? null;
  }

  // 色のターゲット (最大 4 つ。null は既定) と深度のターゲット (null は既定) を描画先にする。既定の色が canvas なら canvas
  bind(effect: LoadedEffect | null, colors: (string | null)[], depth: string | null): DrawTarget {
    const own = effect ? this.effects.get(effect) : undefined;
    const lookup = <K extends Target['kind']>(name: string | null, kind: K) => {
      const t = name === null ? undefined : own?.get(name);
      return t?.kind === kind ? (t as Extract<Target, { kind: K }>) : null;
    };
    const c = [0, 1, 2, 3].map(i => lookup(colors[i] ?? null, 'color'));
    const d = lookup(depth, 'depth');
    const { surface, warnings } = resolveSurface(this.defaultSurface, c, d, { colors: c.map(x => x !== null), depth: d !== null });
    for (const w of warnings) this.events.warn(w, effect);
    return this.bindSurface(surface);
  }

  bindSurface(s: Surface): DrawTarget {
    const r = this.renderer;
    if (s.kind === 'canvas') {
      r.setRenderTarget(null);
      this.current = s;
      const size = r.getDrawingBufferSize(new THREE.Vector2());
      return { flipY: 1, size: [size.x, size.y] };
    }
    if (s.kind === 'three') {
      r.setRenderTarget(s.target);
      this.current = s;
      return { flipY: -1, size: [s.target.width, s.target.height] };
    }
    const lead = s.colors.find(c => c !== null);
    if (!lead) return this.bindSurface(CANVAS);
    const depth = s.depth ?? this.sharedDepth(lead.width, lead.height);
    const fbo = this.fbo(s.colors, depth, lead);
    if (!fbo.ok) {
      const owners = [...new Set([...s.colors, depth].map(t => t?.effect).filter((e): e is LoadedEffect => !!e))];
      this.events.broken(owners);
      return this.bindSurface(this.defaultSurface === s ? CANVAS : this.defaultSurface);
    }
    r.setRenderTarget(fbo.rt);
    this.current = s;
    if (depth.stale) {
      depth.stale = false;
      this.clear(null, 1, 0);
    }
    return { flipY: -1, size: [lead.width, lead.height] };
  }

  // いまの描画先を消す (null は消さない)。MRT なら全部の色のターゲット
  clear(color: [number, number, number, number] | null, depth: number | null, stencil: number | null): void {
    const { gl } = this;
    const buffers = this.renderer.state.buffers;
    let bits = 0;
    if (color) {
      buffers.color.setMask(true);
      buffers.color.setClear(color[0], color[1], color[2], color[3], false);
      bits |= gl.COLOR_BUFFER_BIT;
    }
    if (depth !== null) {
      buffers.depth.setMask(true);
      buffers.depth.setClear(depth);
      bits |= gl.DEPTH_BUFFER_BIT;
    }
    if (stencil !== null) {
      buffers.stencil.setMask(0xff);
      buffers.stencil.setClear(stencil);
      bits |= gl.STENCIL_BUFFER_BIT;
    }
    if (bits) gl.clear(bits);
  }

  // mipmaps のあるターゲットのミップを作る (いまの描画先のもの)
  afterDraw(): void {
    if (this.current.kind !== 'targets') return;
    const { gl } = this;
    for (const c of this.current.colors) {
      if (!c?.mipmaps) continue;
      this.renderer.state.bindTexture(gl.TEXTURE_2D, c.gl);
      gl.generateMipmap(gl.TEXTURE_2D);
      this.renderer.state.unbindTexture();
    }
  }

  // エフェクトのターゲットを捨てる (使わなくなったとき)
  release(effect: LoadedEffect): void {
    const targets = this.effects.get(effect);
    if (!targets) return;
    for (const t of targets.values()) this.drop(t);
    this.effects.delete(effect);
  }

  dispose(): void {
    for (const e of [...this.effects.keys()]) this.release(e);
    for (const d of this.autoDepth.values()) this.drop(d);
    this.autoDepth.clear();
    if (this.screenTarget) this.drop(this.screenTarget);
    this.screenTarget = null;
    this.renderer.setRenderTarget(null);
    this.current = CANVAS;
    this.defaultSurface = CANVAS;
  }

  // 浮動小数に描けない環境では rgba8 にする
  private usable(format: TargetFormat, name: string, warnings: string[]): TargetFormat {
    const ext = this.renderer.extensions;
    const ok = format === 'rgba8' || ext.has('EXT_color_buffer_float') || (HALF.has(format) && ext.has('EXT_color_buffer_half_float'));
    if (ok) return format;
    warnings.push(t('浮動小数のレンダーターゲット {name} に描けない環境なので A8R8G8B8 にします', { name }));
    return 'rgba8';
  }

  private makeColor(effect: LoadedEffect | null, name: string, w: number, h: number, format: TargetFormat, mipmaps: boolean, s: Sampling, key: string): ColorTarget {
    const [fmt, type] = FORMATS[format];
    const tex = new THREE.DataTexture(null, w, h, fmt, type, THREE.UVMapping, s.wrapS, s.wrapT, s.magFilter, s.minFilter);
    tex.colorSpace = THREE.NoColorSpace;
    tex.flipY = false;
    tex.generateMipmaps = mipmaps;
    tex.source.dataReady = false; // (中身は送らない。texStorage2D で場所だけ作る)
    tex.needsUpdate = true;
    this.renderer.initTexture(tex);
    const gl = (this.renderer.properties.get(tex) as { __webglTexture: WebGLTexture }).__webglTexture;
    return { kind: 'color', id: nextId++, effect, name, width: w, height: h, format, mipmaps, key, tex, gl };
  }

  private makeDepth(effect: LoadedEffect | null, name: string, w: number, h: number): DepthTarget {
    const { gl } = this;
    const rb = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, w, h);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    // (中身は 0 で始まるので、最初に描画先にしたときに 1 で消す)
    return { kind: 'depth', id: nextId++, effect, name, width: w, height: h, rb, stale: true };
  }

  private sharedDepth(w: number, h: number): DepthTarget {
    const key = `${w}x${h}`;
    let d = this.autoDepth.get(key);
    if (!d) this.autoDepth.set(key, (d = this.makeDepth(null, '(depth)', w, h)));
    return d;
  }

  private fbo(colors: (ColorTarget | null)[], depth: DepthTarget, lead: ColorTarget): Fbo {
    const key = `${colors.map(c => c?.id ?? '-').join(',')}|${depth.id}`;
    const old = this.fbos.get(key);
    if (old) return old;
    const { gl } = this;
    const state = this.renderer.state;
    const fbo = gl.createFramebuffer();
    state.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    colors.forEach((c, i) => {
      if (c) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, c.gl, 0);
    });
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, depth.rb);
    // (どの色のターゲットに書くかはフレームバッファが覚える)
    gl.drawBuffers(colors.map((c, i) => (c ? gl.COLOR_ATTACHMENT0 + i : gl.NONE)));
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    state.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!ok) {
      const names = colors.filter(c => c).map(c => c!.name).join(', ');
      const owners = [...new Set([...colors, depth].map(x => x?.effect ?? null).filter(e => e !== null))];
      const msg = t('レンダーターゲット {names} のフレームバッファを作れません', { names });
      const key = `${owners.map(e => e.id).join(',')}|${msg}`;
      if (!this.reported.has(key)) {
        this.reported.add(key);
        if (owners.length === 0) this.events.warn(msg, null);
        for (const e of owners) this.events.warn(msg, e);
      }
    }
    const rt = new THREE.WebGLRenderTarget(lead.width, lead.height, { depthBuffer: false });
    // (three.js の型にない関数。XR と同じく、外で作ったフレームバッファを付ける)
    (this.renderer as unknown as { setRenderTargetFramebuffer(rt: THREE.WebGLRenderTarget, fbo: WebGLFramebuffer): void }).setRenderTargetFramebuffer(rt, fbo);
    const made: Fbo = { fbo, rt, ids: [...colors.map(c => c?.id ?? 0), depth.id], ok };
    this.fbos.set(key, made);
    return made;
  }

  // ターゲットと、それを使うフレームバッファを捨てる
  private drop(t: Target): void {
    for (const [key, f] of this.fbos) {
      if (!f.ids.includes(t.id)) continue;
      // (f.rt は setRenderTargetFramebuffer で付けただけで、GL の資源を持たないので dispose しない。フレームバッファは自分で消す)
      this.gl.deleteFramebuffer(f.fbo);
      this.fbos.delete(key);
    }
    if (t.kind === 'color') t.tex.dispose();
    else this.gl.deleteRenderbuffer(t.rb);
  }
}
