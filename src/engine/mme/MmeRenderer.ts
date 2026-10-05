import * as THREE from 'three';
import type { Pass } from '../../core/fx/index.ts';
import { t } from '../../core/i18n';
import type { Color3 } from '../../core/materials/nodes';
import { inputLink, surfaceShader, upstreamOrder } from '../../core/materials/tree';
import { orthoD3D, toMmd } from '../../core/mme/coords.ts';
import { runTechnique } from '../../core/mme/script.ts';
import { SHADOW_COLOR, type CameraState, type LightState, type MaterialState, type MmdPass, type SemanticContext } from '../../core/mme/semantics.ts';
import { pickTechnique, type TechniqueQuery } from '../../core/mme/technique.ts';
import type { Clock } from '../anim/Clock';
import { mmeTexturesOf } from '../materials/fromMmd';
import type { MaterialData, MaterialLibrary } from '../materials/MaterialLibrary';
import type { SceneGraph } from '../render/SceneGraph';
import type { Viewport } from '../render/Viewport';
import type { Obj } from '../types';
import type { UiChannel } from '../UiChannel';
import type { Selection } from '../world/Selection';
import type { World } from '../world/World';
import { EffectInstance, type BaseState, type TextureSource } from './EffectInstance';
import type { EffectStore, LoadedEffect } from './EffectStore';
import { CANVAS, Framebuffers, type DrawTarget } from './Framebuffers';
import { mmdSourceOf, type MmdData } from './mmdData';
import type { MmeSettings } from '../../core/mme/settings.ts';
import { builtins, PostChain, ScriptTargets, type FrameState } from './PostChain';
import { Skinner, type MmeGeometry } from './Skinner';

// --- MME 互換の 1 フレーム (設計書「1 フレームの流れ」): セルフシャドウの深度 → ポストエフェクトの入れ子 (PostChain) の
// いちばん内側で、モデルごとに地面の影・本体・輪郭線 → 編集用の表示 ---

export interface MmeRendererDeps {
  viewport: Viewport; graph: SceneGraph; world: World; selection: Selection; clock: Clock; library: MaterialLibrary;
  store: EffectStore; settings: MmeSettings; stage: () => THREE.Object3D | null; ui: UiChannel;
}

export type { DrawTarget, FrameState };

// PMX の材質のフラグ
const DOUBLE_SIDED = 0x01, GROUND_SHADOW = 0x02, CAST_SELF_SHADOW = 0x04, RECEIVE_SELF_SHADOW = 0x08, EDGE = 0x10;
// セルフシャドウの深度マップの大きさと、影の範囲の既定 (標準のエンジンの太陽の影と同じ範囲になる値)
const SHADOW_SIZE = 2048;
const SHADOW_DISTANCE = 8875;
// 編集用の表示だけを描くときにカメラに見せるレイヤー
const OVERLAY_LAYER = 31;
const DEG = Math.PI / 180;

interface SubsetTextures { material: THREE.Texture | null; sphere: THREE.Texture | null; toon: THREE.Texture | null }
// 材質の部分 (サブセット)。index は材質の番号 (technique の Subset と照らす)。group が null なら形全体。flags は PMX の材質のフラグ
export interface Subset {
  index: number; group: THREE.GeometryGroup | null; state: MaterialState; flags: number; doubleSided: boolean; textures: SubsetTextures;
}
// 描く物 (メッシュ 1 つ) と、1 フレームの値
export interface DrawItem { mesh: THREE.Mesh; effect: LoadedEffect; geo: MmeGeometry; subsets: Subset[] }
interface Toon { tex: THREE.DataTexture; color: Color3; version: number }

const WHITE: Color3 = [1, 1, 1];

// 祖先まで見えているか
function visibleChain(o: THREE.Object3D | null): boolean {
  for (; o; o = o.parent) if (!o.visible) return false;
  return true;
}

function toSrgb(c: THREE.Color): Color3 {
  const o = { r: 0, g: 0, b: 0 };
  c.getRGB(o, THREE.SRGBColorSpace);
  return [o.r, o.g, o.b];
}

// マテリアルのベースカラーにつながっている画像 (なければ null)
function baseImage(lib: MaterialLibrary, data: MaterialData): THREE.Texture | null {
  const bsdf = surfaceShader(data.tree);
  const link = bsdf && inputLink(data.tree, bsdf.id, 'baseColor');
  if (!link) return null;
  for (const n of upstreamOrder(data.tree, link.from.node)) {
    if (n.type !== 'image') continue;
    const img = lib.images.get(String(n.props.image));
    if (img) return img.texture;
  }
  return null;
}

// MMDLoader はトゥーンの画像を three.js のグラデーション用に 90° 回して (上の行が右の列に) 持っているので、元の向きに戻す。
// color はいちばん下の行の色 (TOONCOLOR)。画像はガンマ空間のまま
function unrotateToon(img: { data: ArrayLike<number>; width: number; height: number }): { tex: THREE.DataTexture; color: Color3 } {
  const { width: w, height: h, data } = img;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // 元の (x, y) は、回した画像の (w/2 − (y − h/2), h/2 + (x − w/2)) にある (画素の中心で)
      const rx = Math.min(Math.max(Math.floor(w / 2 - (y + 0.5 - h / 2)), 0), w - 1);
      const ry = Math.min(Math.max(Math.floor(h / 2 + (x + 0.5 - w / 2)), 0), h - 1);
      for (let k = 0; k < 4; k++) out[(y * w + x) * 4 + k] = data[(ry * w + rx) * 4 + k];
    }
  }
  const tex = new THREE.DataTexture(out, w, h);
  tex.colorSpace = THREE.NoColorSpace;
  tex.flipY = false;
  tex.needsUpdate = true;
  const b = (h - 1) * w * 4;
  return { tex, color: [out[b] / 255, out[b + 1] / 255, out[b + 2] / 255] };
}

export class MmeRenderer {
  readonly warnings: string[] = []; // 描くときの、どのエフェクトのものでもない警告 (同じものは 1 回)。エフェクトの警告は EffectInstance.warnings
  skinner = new Skinner();
  private instances = new Map<LoadedEffect, EffectInstance>();
  private shadow: THREE.WebGLRenderTarget | null = null;
  private noShadow = false; // 浮動小数のテクスチャに描けない
  private toons = new WeakMap<THREE.Texture, Toon>();
  private toonTextures = new Set<THREE.DataTexture>();
  private prevTime: number | null = null;
  // three.js の描画の中 (Scene.onAfterRender) で描くための空の場面。renderBufferDirect は render の中でしか使えないため
  private host = new THREE.Scene();
  private job: (() => void) | null = null;
  // 描く形を GPU に送らせるための見えないメッシュ (render が場面の物の形を送る。renderBufferDirect は送らない)
  private uploaders: THREE.Mesh[] = [];
  private hiddenMaterial = new THREE.MeshBasicMaterial({ visible: false });
  private proxy = new THREE.Mesh(); // renderBufferDirect に渡す物 (単位行列。three.js の骨やモーフ・面の反転を効かせない)
  private clearColor = new THREE.Color();
  private linked = new WeakSet<THREE.Material>(); // リンクできたかを確かめた材質
  private fb: Framebuffers | null = null; // レンダーターゲット (描画先を作り直したら作り直す)
  private chain: PostChain | null = null;

  constructor(private d: MmeRendererDeps) {
    this.host.onAfterRender = () => {
      const job = this.job;
      this.job = null;
      job?.();
    };
  }

  // canvas に描く。false: 描けなかった (呼ぶ側が標準のエンジンで描く)
  render(): boolean {
    const renderer = this.d.viewport.renderer;
    if (!renderer) return false;
    const { scene, camera } = this.d.graph;
    scene.updateMatrixWorld();
    camera.updateMatrixWorld();
    const fb = this.framebuffers(renderer);
    const frame = this.frame(renderer);
    fb.begin(frame.screen);
    const items = this.collect(frame);
    renderer.getClearColor(this.clearColor);
    const clearAlpha = renderer.getClearAlpha();
    try {
      this.inThree(renderer, items, () => this.drawFrame(renderer, fb, items, frame, clearAlpha));
    } finally {
      // (途中で例外が出ても、標準のエンジンが canvas に描けるように戻す)
      fb.bindSurface(CANVAS);
      renderer.setClearColor(this.clearColor, clearAlpha);
      renderer.state.buffers.color.setMask(true);
    }
    // 3. 編集用の表示 (書き出しには写さない)
    if (!this.d.viewport.outputting) this.overlay(renderer);
    return true;
  }

  // セルフシャドウの深度マップ → ポストエフェクトの入れ子と場面 (three.js の render の中で呼ぶ)
  private drawFrame(renderer: THREE.WebGLRenderer, fb: Framebuffers, items: DrawItem[], frame: FrameState, clearAlpha: number): void {
    // 物の .fx のレンダーターゲット
    for (const e of new Set([this.d.store.defaultEffect, ...items.map(it => it.effect)])) this.prepare(fb, e, frame.screen);
    // セルフシャドウの深度マップ (R = z / w。何もない所は 1)
    if (frame.selfShadow && this.shadow) {
      const surface = { kind: 'three', target: this.shadow } as const;
      const target = fb.bindSurface(surface);
      fb.defaultSurface = surface;
      renderer.setClearColor(0xffffff, 1);
      this.clear(renderer);
      for (const item of items) {
        for (const sub of item.subsets) if (sub.flags & CAST_SELF_SHADOW) this.drawPass(item, sub, 'zplot', frame, target);
      }
    }
    // ポストエフェクトがあれば canvas の代わりの絵に描いてから写す (Framebuffers.screenSurface)。背景の空は描かない。いまの消す色で消す
    const posts = this.posts(fb, frame.screen);
    const surface = posts.length > 0 ? fb.screenSurface() : CANVAS;
    const target = fb.bindSurface(surface);
    fb.defaultSurface = surface;
    renderer.setClearColor(this.clearColor, clearAlpha);
    this.clear(renderer);
    if (posts.length === 0) {
      this.drawScene(items, frame, target);
    } else {
      this.chain!.run(posts, frame, t => this.drawScene(items, frame, t));
      fb.bindSurface(CANVAS);
      this.clear(renderer);
      const tex = fb.screenTexture;
      if (tex) this.chain!.present(tex);
    }
    this.opaque(renderer, clearAlpha);
  }

  // オンで、コンパイルできて、止めていないポストエフェクト (一覧の順。最後がいちばん外側)。レンダーターゲットも用意する
  private posts(fb: Framebuffers, screen: [number, number]): LoadedEffect[] {
    const out: LoadedEffect[] = [];
    for (const p of this.d.store.posts) {
      if (!p.enabled || !p.effect.result.ok || this.stopped(p.effect)) continue;
      this.prepare(fb, p.effect, screen);
      out.push(p.effect);
    }
    return out;
  }

  private prepare(fb: Framebuffers, e: LoadedEffect, screen: [number, number]): void {
    const inst = this.instance(e);
    for (const w of fb.prepare(e, screen)) if (!inst.warnings.includes(w)) inst.warnings.push(w);
  }

  // モデルを置いた順に: 地面の影 → 本体 → 輪郭線。描画先はいまのもの (ポストエフェクトは ScriptExternal からここを呼ぶ)。
  // 物の .fx の Script が「既定の描画先」と言ったら、いまの描画先
  drawScene(items: DrawItem[], frame: FrameState, target: DrawTarget): void {
    const fb = this.fb;
    const outer = fb?.defaultSurface;
    if (fb) fb.defaultSurface = fb.current;
    try {
      this.drawItems(items, frame, target);
    } finally {
      if (fb && outer) fb.defaultSurface = outer;
    }
  }

  private drawItems(items: DrawItem[], frame: FrameState, target: DrawTarget): void {
    const { groundShadow } = this.d.settings;
    for (const item of items) {
      if (groundShadow) for (const sub of item.subsets) if (sub.flags & GROUND_SHADOW) this.drawPass(item, sub, 'shadow', frame, target);
      for (const sub of item.subsets) {
        this.drawPass(item, sub, frame.selfShadow && sub.flags & RECEIVE_SELF_SHADOW ? 'object_ss' : 'object', frame, target);
      }
      if (item.geo.edge) for (const sub of item.subsets) if (sub.flags & EDGE) this.drawPass(item, sub, 'edge', frame, target);
    }
  }

  // 使う .fx のテクスチャと、MMD モデルの .pmx の読み込みが終わる (失敗しても) まで待つ
  async whenReady(): Promise<void> {
    const waits: Promise<void>[] = [];
    const effects = new Set<LoadedEffect>([this.d.store.defaultEffect]);
    const visit = (root: THREE.Object3D) => root.traverse(o => {
      if (this.isMmd(o)) waits.push(this.skinner.settled(o as THREE.SkinnedMesh));
    });
    for (const obj of this.d.world.objects) {
      effects.add(this.effectOf(obj));
      visit(obj.node);
    }
    for (const p of this.d.store.posts) if (p.enabled && p.effect.result.ok) effects.add(p.effect);
    const stage = this.d.stage();
    if (stage) visit(stage);
    for (const e of effects) waits.push(this.instance(e).ready());
    await Promise.all(waits);
  }

  // どの物にも割り当てていない・ポストエフェクトの一覧にない .fx の資源を捨てる
  prune(): void {
    const used = new Set<LoadedEffect>([
      this.d.store.defaultEffect, ...this.d.world.objects.map(o => this.effectOf(o)), ...this.d.store.posts.map(p => p.effect),
    ]);
    for (const [e, inst] of this.instances) {
      if (used.has(e)) continue;
      inst.dispose();
      this.fb?.release(e);
      this.instances.delete(e);
    }
  }

  // GPU の資源と変形した形と警告を捨てる (次に描くときに作り直す)
  dispose(): void {
    this.warnings.length = 0;
    for (const inst of this.instances.values()) inst.dispose();
    this.instances.clear();
    this.skinner.dispose();
    this.skinner = new Skinner();
    this.shadow?.dispose();
    this.shadow = null;
    this.noShadow = false;
    for (const t of this.toonTextures) t.dispose();
    this.toonTextures.clear();
    this.toons = new WeakMap();
    this.uploaders = [];
    this.prevTime = null;
    this.fb?.dispose();
    this.fb = null;
    this.chain?.dispose();
    this.chain = null;
  }

  // レンダーターゲットとポストエフェクトの入れ子 (最初に描くときに作る)
  private framebuffers(renderer: THREE.WebGLRenderer): Framebuffers {
    if (this.fb) return this.fb;
    const fb = new Framebuffers(renderer, {
      warn: (m, e) => (e ? this.instance(e).warn(m) : this.warn(m)),
      broken: effects => {
        for (const e of effects) {
          const inst = this.instances.get(e);
          if (!inst || inst.stopped) continue;
          inst.stopped = true;
          this.d.ui.toast(t('{name} のレンダーターゲットを GPU で使えないので止めました', { name: e.name }), 8000);
          this.d.viewport.requestDraw();
        }
      },
    });
    this.fb = fb;
    this.chain = new PostChain({
      fb, instance: e => this.instance(e),
      render: (m, geometry) => renderer.renderBufferDirect(this.d.graph.camera, null as unknown as THREE.Scene, geometry, m, this.proxy, null as unknown as THREE.GeometryGroup),
      checkLink: (m, inst, effect) => this.checkLink(renderer, m, inst, effect),
    });
    return fb;
  }

  // --- フレームの値 ---
  private frame(renderer: THREE.WebGLRenderer): FrameState {
    const { graph, clock, settings } = this.d;
    const cam = graph.camera;
    const position = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
    const camera: CameraState = {
      position,
      target: position.clone().add(cam.getWorldDirection(new THREE.Vector3())),
      up: new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1).normalize(), // (真下を見るときも決まるように、カメラの上)
      fovY: cam.fov * DEG, aspect: cam.aspect, near: cam.near, far: cam.far,
    };
    const time = clock.t;
    const elapsed = this.prevTime === null ? 0 : Math.max(time - this.prevTime, 0);
    this.prevTime = time;
    const selfShadow = settings.selfShadow && this.shadowTarget(renderer) !== null;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    return { camera, light: this.light(), eye: position, time, elapsed, selfShadow, screen: [size.x, size.y] };
  }

  // 太陽: 色 = 色 × min(明るさ ÷ π, 1)、向き = 来る向きの逆。影のカメラは標準のエンジンの太陽の影のカメラ (範囲を shadowDistance で広げる)
  private light(): LightState {
    const { sun } = this.d.graph;
    const k = Math.min(sun.intensity / Math.PI, 1);
    const color = toSrgb(sun.color).map(v => v * k) as Color3;
    const eye = sun.getWorldPosition(new THREE.Vector3());
    const target = sun.target.getWorldPosition(new THREE.Vector3());
    const world = new THREE.Matrix4().lookAt(eye, target, new THREE.Vector3(0, 1, 0)).setPosition(eye);
    const c = sun.shadow.camera;
    const s = Math.max(this.d.settings.shadowDistance, 1) / SHADOW_DISTANCE; // (0 だと範囲が潰れる)
    return {
      direction: this.d.graph.sunDirection().negate(),
      color,
      shadowView: toMmd(world.invert()),
      shadowProjection: orthoD3D(c.left * s, c.right * s, c.bottom * s, c.top * s, c.near, c.far),
    };
  }

  // 浮動小数 (R32F) のセルフシャドウの深度マップ。描けない環境では null (セルフシャドウを切る)
  private shadowTarget(renderer: THREE.WebGLRenderer): THREE.WebGLRenderTarget | null {
    if (this.shadow || this.noShadow) return this.shadow;
    if (!renderer.extensions.has('EXT_color_buffer_float')) {
      this.noShadow = true;
      this.warn(t('浮動小数のテクスチャに描けない環境なので、セルフシャドウを切ります'));
      return null;
    }
    this.shadow = new THREE.WebGLRenderTarget(SHADOW_SIZE, SHADOW_SIZE, {
      type: THREE.FloatType, format: THREE.RedFormat, depthBuffer: true, generateMipmaps: false,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
    });
    return this.shadow;
  }

  // --- 描く物 ---
  // ステージ (背景として先に描く。モデルの地面の影が床に重なるように) と、置いた物 (見えているもの) の見えているメッシュ。
  // 編集用の物 (editorOnly) は除く
  private collect(frame: FrameState): DrawItem[] {
    const items: DrawItem[] = [];
    const stage = this.d.stage();
    if (stage && visibleChain(stage)) this.collectFrom(stage, this.d.store.defaultEffect, frame, items);
    const outputting = this.d.viewport.outputting;
    for (const obj of this.d.world.objects) {
      if (outputting ? obj.hideRender : obj.hidden || obj.colHidden) continue;
      if (visibleChain(obj.node)) this.collectFrom(obj.node, this.effectOf(obj), frame, items);
    }
    return items;
  }

  private collectFrom(root: THREE.Object3D, effect: LoadedEffect, frame: FrameState, items: DrawItem[]): void {
    const visit = (o: THREE.Object3D) => {
      if (!o.visible || o.userData.editorOnly) return;
      if ((o as THREE.Mesh).isMesh) {
        const item = this.item(o as THREE.Mesh, effect, frame);
        if (item) items.push(item);
      }
      for (const c of o.children) visit(c);
    };
    visit(root);
  }

  // .fx を割り当てていない・コンパイルできなかった・GPU で止めた物は default.fx
  private effectOf(obj: Obj): LoadedEffect {
    const e = this.d.store.objectEffect(obj.id);
    return e?.result.ok && !this.stopped(e) ? e : this.d.store.defaultEffect;
  }

  // 全部の警告 (エフェクトの警告は「名前: 」を付ける。テスト用)
  allWarnings(): string[] {
    return [...this.warnings, ...[...this.instances].flatMap(([e, inst]) => inst.warnings.map(w => `${e.name}: ${w}`))];
  }

  // そのエフェクトの描いたときの警告 (まだ描いていなければ空)
  warningsOf(e: LoadedEffect): string[] {
    return [...(this.instances.get(e)?.warnings ?? [])];
  }

  // そのエフェクトを GPU で使えないので止めたか (ポストエフェクトは飛ばす)
  stopped(e: LoadedEffect): boolean {
    return this.instances.get(e)?.stopped ?? false;
  }

  private isMmd(o: THREE.Object3D): boolean {
    const m = o as THREE.SkinnedMesh;
    return m.isSkinnedMesh === true && (mmdSourceOf(m.geometry) !== undefined || 'sourceFile' in m.userData);
  }

  private item(mesh: THREE.Mesh, effect: LoadedEffect, frame: FrameState): DrawItem | null {
    if (!this.isMmd(mesh)) return { mesh, effect, geo: this.skinner.plain(mesh), subsets: this.subsets(mesh, null) };
    const sm = mesh as THREE.SkinnedMesh;
    // クローンは userData の File を失う。形が差し替わった (デフォーマで変形した) クローンは .pmx を引けない
    if (!(mmdSourceOf(sm.geometry) ?? sm.userData.sourceFile instanceof Blob)) {
      this.warn(t('{name}: 元の .pmx が分からないので描けません (デフォーマで変形したモデルの複製)', { name: sm.name || t('MMD モデル') }));
      return null;
    }
    // .pmx を読み終えていなければ、このフレームは描かない (読み終えたら描き直す)
    const geo = this.skinner.mmd(sm, frame.eye, Math.tan(frame.camera.fovY / 2), () => this.d.viewport.requestDraw());
    const data = this.skinner.data(sm);
    if (!geo || !data) {
      if (this.skinner.failed(sm)) this.warn(t('{name}: .pmx を読めないので描けません', { name: sm.name || t('MMD モデル') }));
      return null;
    }
    return { mesh, effect, geo, subsets: this.subsets(mesh, data) };
  }

  // 材質の部分。材質が 1 つなら形全体
  private subsets(mesh: THREE.Mesh, data: MmdData | null): Subset[] {
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const groups: (THREE.GeometryGroup | null)[] = Array.isArray(mesh.material) && mesh.geometry.groups.length ? mesh.geometry.groups : [null];
    const out: Subset[] = [];
    for (const g of groups) {
      const index = g?.materialIndex ?? 0;
      const m = materials[index];
      if (m?.visible) out.push(this.subset(mesh, m, index, g, data));
    }
    return out;
  }

  // 材質の値 (設計書「MMD が .fx に渡す値」)。MMD の材質は .pmx の値、形はベースカラーとアルファから
  private subset(mesh: THREE.Mesh, m: THREE.Material, index: number, group: THREE.GeometryGroup | null, data: MmdData | null): Subset {
    const lib = this.d.library;
    const md = lib.materials.get(m.userData.materialId);
    const material = md ? baseImage(lib, md) : null;
    const mme = mmeTexturesOf(m);
    const info = data?.materials[index];
    const toon = mme?.toon ? this.toonOf(mme.toon) : null;
    const sphereMode = info?.sphereMode ?? 0;
    const sphere = mme?.sphere && (sphereMode === 1 || sphereMode === 2) ? mme.sphere : null;
    const textures: SubsetTextures = { material, sphere, toon: toon?.tex ?? null };
    const transparent = md ? md.settings.blend === 'blend' : m.transparent;
    const common = {
      groundShadowColor: SHADOW_COLOR, hasTexture: !!material, hasSphere: !!sphere, hasToon: !!mme?.toon, sphereAdd: !!sphere && sphereMode === 2, transparent,
    };
    let state: MaterialState;
    const src = md?.mmd;
    if (src) {
      state = {
        ...common, diffuse: src.diffuse, ambient: src.ambient, specular: src.specular, power: src.shininess,
        toon: toon?.color ?? WHITE, edgeColor: src.edgeColor,
      };
    } else {
      // 形: 拡散色 = ベースカラー (ガンマ空間に直す)、環境色 = その半分、反射なし、輪郭線なし
      const [base, alpha] = this.baseColor(md, m);
      state = {
        ...common, diffuse: [...base, alpha], ambient: base.map(v => v * 0.5) as Color3, specular: [0, 0, 0], power: 5,
        toon: toon?.color ?? WHITE, edgeColor: [0, 0, 0, 1],
      };
    }
    const shapeFlags = (mesh.castShadow ? GROUND_SHADOW | CAST_SELF_SHADOW : 0) | (mesh.receiveShadow ? RECEIVE_SELF_SHADOW : 0);
    const flags = info ? info.flags : shapeFlags;
    const doubleSided = info ? (info.flags & DOUBLE_SIDED) !== 0 : !(md?.settings.backfaceCulling ?? m.side === THREE.FrontSide);
    return { index, group, state, flags, doubleSided, textures };
  }

  // ベースカラー (ガンマ空間) とアルファ。画像がつながっていれば白 (画像の色をそのまま使う)
  private baseColor(md: MaterialData | undefined, m: THREE.Material): [Color3, number] {
    const bsdf = md && surfaceShader(md.tree);
    if (md && bsdf) {
      const linked = !!inputLink(md.tree, bsdf.id, 'baseColor');
      const c = bsdf.values.baseColor as Color3;
      const alpha = inputLink(md.tree, bsdf.id, 'alpha') ? 1 : Number(bsdf.values.alpha ?? 1);
      return [linked ? WHITE : toSrgb(new THREE.Color().setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace)), alpha];
    }
    const color = (m as THREE.MeshStandardMaterial).color;
    return [color ? toSrgb(color) : WHITE, m.opacity];
  }

  // トゥーンの画像を元の向きにしたテクスチャといちばん下の行の色 (画像ごとに 1 回だけ作る)。読み終えていなければ null
  private toonOf(src: THREE.Texture): Toon | null {
    const img = src.image as { data?: ArrayLike<number>; width?: number; height?: number } | null | undefined;
    if (!img?.data || !img.width || !img.height) return null;
    const old = this.toons.get(src);
    if (old && old.version === src.version) return old;
    if (old) { old.tex.dispose(); this.toonTextures.delete(old.tex); }
    const made = unrotateToon({ data: img.data, width: img.width, height: img.height });
    const toon: Toon = { ...made, version: src.version };
    this.toons.set(src, toon);
    this.toonTextures.add(made.tex);
    return toon;
  }

  // --- 描く ---
  private instance(e: LoadedEffect): EffectInstance {
    let inst = this.instances.get(e);
    if (!inst) {
      inst = new EffectInstance(e, () => this.d.viewport.requestDraw());
      this.instances.set(e, inst);
    }
    return inst;
  }

  // その MMDPass の technique を選んで (なければ default.fx のもの)、Script のとおりに描く
  private drawPass(item: DrawItem, sub: Subset, pass: MmdPass, frame: FrameState, target: DrawTarget): void {
    const s = sub.state;
    const q: TechniqueQuery = { pass, subset: sub.index, useTexture: s.hasTexture, useSphereMap: s.hasSphere, useToon: s.hasToon, selfShadow: frame.selfShadow };
    let effect = item.effect;
    let tech = effect.result.ok ? pickTechnique(effect.result.effect, q) : null;
    if (!tech) {
      effect = this.d.store.defaultEffect;
      tech = effect.result.ok ? pickTechnique(effect.result.effect, q) : null;
    }
    if (!tech) return;
    const inst = this.instance(effect);
    if (inst.stopped) return; // (このフレームの途中で止めた。次のフレームから default.fx)
    // 物の technique の Script: Draw=Geometry でいまの材質の部分を描く。描画先を替えたら、終わったあと既定の描画先に戻す
    const warn = (m: string) => inst.warn(m); // (そのエフェクトの警告)
    const st = new ScriptTargets(this.fb!, effect, inst, warn, target);
    runTechnique(tech, 'object', {
      ...st.commands(),
      drawPass: (p, mode) => {
        if (mode === 'buffer') warn(t('物の .fx の Draw=Buffer にはまだ対応していないので無視します'));
        else if (!inst.stopped) {
          this.drawGeometry(inst, effect, p, item, sub, pass, frame, st.current());
          if (st.changed) this.fb!.afterDraw();
        }
      },
      drawExternal: () => {},
      warn,
    });
    if (st.changed) this.fb!.bindSurface(this.fb!.defaultSurface);
  }

  private drawGeometry(inst: EffectInstance, effect: LoadedEffect, p: Pass, item: DrawItem, sub: Subset, pass: MmdPass, frame: FrameState, target: DrawTarget): void {
    const renderer = this.d.viewport.renderer!;
    const base: BaseState = { kind: pass === 'zplot' ? 'zplot' : pass === 'edge' ? 'edge' : 'object', doubleSided: sub.doubleSided };
    const m = inst.material(p, target.flipY, base);
    if (!m) return;
    const ctx: SemanticContext = {
      camera: frame.camera, light: frame.light, world: item.mesh.matrixWorld, material: sub.state, pass,
      time: frame.time, elapsed: frame.elapsed, screen: frame.screen, selfShadow: frame.selfShadow,
    };
    const { textures: t } = sub;
    // (深度マップに描いているあいだは、その深度マップを読ませない)
    const shadow = pass === 'zplot' ? null : this.shadow?.texture ?? null;
    const textures: TextureSource = {
      role: name => (name === 'material' ? t.material : name === 'sphere' ? t.sphere : name === 'toon' ? t.toon : name === 'selfShadow' ? shadow
        : this.fb?.colorTexture(effect, name) ?? null),
    };
    inst.bind(m, p, ctx, builtins(target), textures);
    const geometry = pass === 'edge' && item.geo.edge ? item.geo.edge : item.geo.geometry;
    // (scene と group は null でよい: three.js は空の場面・形全体として扱う)
    renderer.renderBufferDirect(this.d.graph.camera, null as unknown as THREE.Scene, geometry, m, this.proxy, sub.group as THREE.GeometryGroup);
    this.checkLink(renderer, m, inst, effect);
  }

  // 材質で初めて描いたあとに、シェーダーをリンクできたかを確かめる。できなければ、そのエフェクトを止めてお知らせを 1 回出す
  private checkLink(renderer: THREE.WebGLRenderer, m: THREE.Material, inst: EffectInstance, effect: LoadedEffect): void {
    if (this.linked.has(m)) return;
    this.linked.add(m);
    const program = (renderer.properties.get(m) as { currentProgram?: { program?: WebGLProgram } }).currentProgram?.program;
    const gl = renderer.getContext();
    if (!program || gl.getProgramParameter(program, gl.LINK_STATUS) !== false) return;
    inst.stopped = true;
    this.d.ui.toast(t('{name} のシェーダーを GPU で使えないので止めました', { name: effect.name }), 8000);
    this.d.viewport.requestDraw();
  }

  // three.js の render の中 (空の場面の onAfterRender) で fn を呼ぶ。そのとき items の形を GPU に送らせる
  private inThree(renderer: THREE.WebGLRenderer, items: DrawItem[], fn: () => void): void {
    const geos = new Set<THREE.BufferGeometry>();
    if (this.chain) geos.add(this.chain.quad);
    for (const it of items) {
      geos.add(it.geo.geometry);
      if (it.geo.edge) geos.add(it.geo.edge);
    }
    let i = 0;
    for (const g of geos) {
      let u = this.uploaders[i];
      if (!u) {
        u = new THREE.Mesh(g, this.hiddenMaterial);
        u.frustumCulled = false;
        this.uploaders.push(u);
      }
      u.geometry = g;
      if (u.parent !== this.host) this.host.add(u);
      i++;
    }
    for (; i < this.uploaders.length; i++) this.host.remove(this.uploaders[i]);
    let error: unknown = null;
    let failed = false;
    this.job = () => {
      try { fn(); } catch (e) { error = e; failed = true; }
    };
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    try {
      renderer.render(this.host, this.d.graph.camera);
    } finally {
      renderer.autoClear = autoClear;
      this.job = null;
      // 形を離す (捨てた形を持ち続けない)
      for (const u of this.uploaders) this.host.remove(u);
    }
    if (failed) throw error;
  }

  // D3D は画面の不透明度を使わないが、canvas は不透明度のぶん後ろが透けるので、描いたあとに 1 にそろえる
  private opaque(renderer: THREE.WebGLRenderer, clearAlpha: number): void {
    const gl = renderer.getContext();
    gl.colorMask(false, false, false, true);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    // three.js が覚えている色のマスクと消す色を捨てて、元の消す色に戻す
    renderer.state.buffers.color.reset();
    renderer.setClearColor(this.clearColor, clearAlpha);
  }

  private clear(renderer: THREE.WebGLRenderer): void {
    renderer.state.buffers.color.setMask(true);
    renderer.clear(true, true, true);
  }

  // グリッド・編集用の物 (ライトやカメラの目印など) を、MME の深度を使って上に重ね、選んでいる物の輪郭線を描く
  private overlay(renderer: THREE.WebGLRenderer): void {
    const { scene, camera, grid } = this.d.graph;
    const tagged: THREE.Object3D[] = [];
    const tag = (o: THREE.Object3D) => {
      if (o.layers.isEnabled(OVERLAY_LAYER)) return;
      o.layers.enable(OVERLAY_LAYER);
      tagged.push(o);
    };
    const untag = () => {
      for (const o of tagged) o.layers.disable(OVERLAY_LAYER);
      tagged.length = 0;
    };
    const mask = camera.layers.mask;
    const autoClear = renderer.autoClear, shadowAuto = renderer.shadowMap.autoUpdate;
    camera.layers.set(OVERLAY_LAYER);
    renderer.autoClear = false;
    renderer.shadowMap.autoUpdate = false; // (隠した物の影を計算し直さない)
    try {
      scene.traverse(o => {
        if (o === grid || (o as THREE.Light).isLight) tag(o);
        else if (o.userData.editorOnly) o.traverse(tag);
      });
      renderer.render(scene, camera);
      untag();
      // 選んでいる物の輪郭線 (OutlineEffect)。選んでいる物だけを見せる
      const outline = this.d.viewport.outline;
      const picked = this.d.selection.list;
      if (outline && picked.length) {
        for (const obj of picked) obj.node.traverse(tag);
        outline.renderOutline(scene, camera);
      }
    } finally {
      untag();
      camera.layers.mask = mask;
      renderer.autoClear = autoClear;
      renderer.shadowMap.autoUpdate = shadowAuto;
    }
  }

  private warn(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }
}
