import * as THREE from 'three';
import { t } from '../../core/i18n';
import type { Color3 } from '../../core/materials/nodes';
import { orthoD3D, toMmd } from '../../core/mme/coords.ts';
import type { CameraState, LightState } from '../../core/mme/semantics.ts';
import type { Clock } from '../anim/Clock';
import type { MaterialLibrary } from '../materials/MaterialLibrary';
import type { SceneGraph } from '../render/SceneGraph';
import type { Viewport } from '../render/Viewport';
import type { Obj } from '../types';
import type { UiChannel } from '../UiChannel';
import type { Selection } from '../world/Selection';
import type { World } from '../world/World';
import { Assignments } from './Assignments';
import { EffectInstance } from './EffectInstance';
import type { EffectStore, LoadedEffect } from './EffectStore';
import { CANVAS, Framebuffers, type DrawTarget } from './Framebuffers';
import { Offscreen } from './Offscreen';
import { SHADOW_DISTANCE_MAX, type MmeSettings } from '../../core/mme/settings.ts';
import { PostChain, type FrameState } from './PostChain';
import { ScenePass, toSrgb, type PassTable, type Slot, type SlotFor } from './ScenePass';
import { Skinner } from './Skinner';

// --- MME 互換の 1 フレーム (設計書「1 フレームの流れ」): セルフシャドウの深度 → オフスクリーン (Offscreen) →
// ポストエフェクトの入れ子 (PostChain) のいちばん内側で、モデルごとに地面の影・本体・輪郭線 → 編集用の表示 ---

export interface MmeRendererDeps {
  viewport: Viewport; graph: SceneGraph; world: World; selection: Selection; clock: Clock; library: MaterialLibrary;
  store: EffectStore; settings: MmeSettings; stage: () => THREE.Object3D | null; ui: UiChannel;
}

export type { DrawTarget, FrameState };

// セルフシャドウの深度マップの大きさと、影の範囲の既定 (標準のエンジンの太陽の影と同じ範囲になる値)
const SHADOW_SIZE = 2048;
const SHADOW_DISTANCE = 8875;
// 編集用の表示だけを描くときにカメラに見せるレイヤー
const OVERLAY_LAYER = 31;
const DEG = Math.PI / 180;

export class MmeRenderer {
  readonly warnings: string[] = []; // 描くときの、どのエフェクトのものでもない警告 (同じものは 1 回)。エフェクトの警告は EffectInstance.warnings
  skinner = new Skinner();
  private instances = new Map<LoadedEffect, EffectInstance>();
  private shadow: THREE.WebGLRenderTarget | null = null;
  private noShadow = false; // 浮動小数のテクスチャに描けない
  private prevTime: number | null = null;
  private frameNo = 0;
  // three.js の描画の中 (Scene.onAfterRender) で描くための空の場面。renderBufferDirect は render の中でしか使えないため
  private host = new THREE.Scene();
  private job: (() => void) | null = null;
  // 描く形を GPU に送らせるための見えないメッシュ (render が場面の物の形を送る。renderBufferDirect は送らない)
  private uploaders: THREE.Mesh[] = [];
  private hiddenMaterial = new THREE.MeshBasicMaterial({ visible: false });
  private proxy = new THREE.Mesh(); // renderBufferDirect に渡す物 (単位行列。three.js の骨やモーフ・面の反転を効かせない)
  private clearColor = new THREE.Color();
  private fb: Framebuffers | null = null; // レンダーターゲット (描画先を作り直したら作り直す)
  private chain: PostChain | null = null;
  private scenePass: ScenePass;
  private offscreen: Offscreen;
  private assignments: Assignments;
  // Main の表: 材質・物の割り当て (なければ default.fx)。ステージは default.fx
  private main: PassTable = { name: 'Main', owner: null, slotFor: (obj, mesh, i) => this.mainSlot(obj, mesh, i) };
  private mainSlotFor: SlotFor;
  // このフレームの Main のメッシュ・材質ごとの割り当て (フレームの途中でエフェクトを止めても、次のフレームまで変えない)
  private mainSlots = new Map<THREE.Mesh, Map<number, Slot>>();

  constructor(private d: MmeRendererDeps) {
    this.assignments = new Assignments(d.store, m => this.warn(m));
    this.mainSlotFor = this.assignments.slotFor('Main', null, null);
    this.scenePass = new ScenePass({
      graph: d.graph, world: d.world, library: d.library, settings: d.settings, stage: d.stage,
      renderer: () => d.viewport.renderer!,
      outputting: () => d.viewport.outputting,
      requestDraw: () => d.viewport.requestDraw(),
      toast: m => d.ui.toast(m, 8000),
      defaultEffect: d.store.defaultEffect,
      fb: () => this.fb!,
      instance: e => this.instance(e),
      skinner: () => this.skinner,
      shadowMap: () => this.shadow?.texture ?? null,
      offscreen: (e, name, owner) => this.offscreen.texture(e, name, owner),
      warn: m => this.warn(m),
    });
    this.offscreen = new Offscreen({
      fb: () => this.fb!,
      scene: this.scenePass,
      slotFor: (tab, defaults, owner) => this.assignments.slotFor(tab, defaults, owner),
      prepare: (e, screen) => this.prepare(this.fb!, e, screen),
      stopped: e => this.stopped(e),
      warn: (m, e) => (e ? this.warnFor(e, m) : this.warn(m)),
    });
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
    if (this.offscreen.begin(frame.frameNo)) this.prune(); // (捨てたオフスクリーンでだけ使っていた .fx の資源も捨てる)
    this.mainSlots.clear();
    const geometries = this.scenePass.geometries(frame);
    renderer.getClearColor(this.clearColor);
    const clearAlpha = renderer.getClearAlpha();
    try {
      this.inThree(renderer, geometries, () => this.drawFrame(renderer, fb, frame, clearAlpha));
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

  // セルフシャドウの深度マップ → オフスクリーン → ポストエフェクトの入れ子と場面 (three.js の render の中で呼ぶ)
  private drawFrame(renderer: THREE.WebGLRenderer, fb: Framebuffers, frame: FrameState, clearAlpha: number): void {
    // 物の .fx のレンダーターゲット
    const uses = this.scenePass.uses(this.main, frame);
    for (const e of new Set([this.d.store.defaultEffect, ...uses.map(u => u.effect)])) this.prepare(fb, e, frame.screen);
    // セルフシャドウの深度マップ (R = z / w。何もない所は 1)
    if (frame.selfShadow && this.shadow) {
      const surface = { kind: 'three', target: this.shadow } as const;
      const target = fb.bindSurface(surface);
      fb.defaultSurface = surface;
      renderer.setClearColor(0xffffff, 1);
      this.clear(renderer);
      this.scenePass.drawSelfShadow(this.main, frame, target);
    }
    // オフスクリーン: ポストエフェクトと Main の物のエフェクトが宣言するもの (その中の入れ子は Offscreen が先に描く)
    const posts = this.posts(fb, frame.screen);
    for (const p of posts) this.offscreen.ensure(p, null, frame);
    for (const u of uses) this.offscreen.ensure(u.effect, u.obj, frame);
    // ポストエフェクトがあれば canvas の代わりの絵に描いてから写す (Framebuffers.screenSurface)。背景の空は描かない。いまの消す色で消す
    const surface = posts.length > 0 ? fb.screenSurface() : CANVAS;
    const target = fb.bindSurface(surface);
    fb.defaultSurface = surface;
    renderer.setClearColor(this.clearColor, clearAlpha);
    this.clear(renderer);
    if (posts.length === 0) {
      this.scenePass.draw(this.main, frame, target);
    } else {
      this.chain!.run(posts, frame, t => this.scenePass.draw(this.main, frame, t));
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
    if (inst.stopped) return; // (止めたエフェクトのターゲットは作らない)
    for (const w of fb.prepare(e, screen)) if (!inst.warnings.includes(w)) inst.warnings.push(w);
  }

  // 使う .fx のテクスチャと、MMD モデルの .pmx の読み込みが終わる (失敗しても) まで待つ
  async whenReady(): Promise<void> {
    const waits: Promise<void>[] = [this.scenePass.whenReady()];
    const effects = new Set<LoadedEffect>([this.d.store.defaultEffect]);
    for (const obj of this.d.world.objects) for (const e of this.assignments.referenced(obj)) if (e.result.ok && !this.stopped(e)) effects.add(e);
    for (const p of this.d.store.posts) if (p.enabled && p.effect.result.ok) effects.add(p.effect);
    // (オフスクリーンに描くエフェクトは、前のフレームで描いたもの)
    for (const e of this.offscreen.effects()) if (e.result.ok && !this.stopped(e)) effects.add(e);
    for (const e of effects) waits.push(this.instance(e).ready());
    await Promise.all(waits);
  }

  // どの物にも割り当てていない・ポストエフェクトの一覧にない・オフスクリーンで使っていない .fx の資源と、場面にないモデルのトゥーンの画像を捨てる
  prune(): void {
    this.scenePass.prune();
    const used = new Set<LoadedEffect>([
      this.d.store.defaultEffect, ...this.d.world.objects.flatMap(o => this.assignments.referenced(o)), ...this.d.store.posts.map(p => p.effect),
      ...this.offscreen.effects(),
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
    this.assignments.clearWarnings();
    for (const inst of this.instances.values()) inst.dispose();
    this.instances.clear();
    this.skinner.dispose();
    this.skinner = new Skinner();
    this.shadow?.dispose();
    this.shadow = null;
    this.noShadow = false;
    this.scenePass.dispose();
    this.offscreen.dispose();
    this.mainSlots.clear();
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
      warn: (m, e) => (e ? this.warnFor(e, m) : this.warn(m)),
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
      checkLink: (m, inst, effect) => this.scenePass.checkLink(m, inst, effect),
      offscreen: (e, name) => this.offscreen.texture(e, name, null),
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
    // (セルフシャドウを切ったら、深度マップ (2048² の R32F) を捨てる。入れたら作り直す)
    if (!settings.selfShadow && this.shadow) {
      this.shadow.dispose();
      this.shadow = null;
    }
    const selfShadow = settings.selfShadow && this.shadowTarget(renderer) !== null;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    return { camera, light: this.light(), eye: position, time, elapsed, selfShadow, screen: [size.x, size.y], frameNo: ++this.frameNo };
  }

  // 太陽: 色 = 色 × min(明るさ ÷ π, 1)、向き = 来る向きの逆。影のカメラは標準のエンジンの太陽の影のカメラ。範囲は MMD の影の距離と
  // 同じく、値が大きいほど狭い ((10000 − 値) に比例。既定の 8875 で標準のエンジンと同じ範囲)
  private light(): LightState {
    const { sun } = this.d.graph;
    const k = Math.min(sun.intensity / Math.PI, 1);
    const color = toSrgb(sun.color).map(v => v * k) as Color3;
    const eye = sun.getWorldPosition(new THREE.Vector3());
    const target = sun.target.getWorldPosition(new THREE.Vector3());
    const world = new THREE.Matrix4().lookAt(eye, target, new THREE.Vector3(0, 1, 0)).setPosition(eye);
    const c = sun.shadow.camera;
    const v = Math.min(Math.max(this.d.settings.shadowDistance, 0), SHADOW_DISTANCE_MAX); // (10000 だと範囲が潰れる)
    const s = (10000 - v) / (10000 - SHADOW_DISTANCE); // (1 より大きいと既定より広い)
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

  // Main で材質を描くもの (Assignments)。GPU で止めたエフェクトは default.fx (そのフレームのうちに止めたものは、次のフレームから)
  private mainSlot(obj: Obj | null, mesh: THREE.Mesh, materialIndex: number): Slot {
    let slots = this.mainSlots.get(mesh);
    if (!slots) this.mainSlots.set(mesh, (slots = new Map()));
    let slot = slots.get(materialIndex);
    if (!slot) {
      slot = this.mainSlotFor(obj, mesh, materialIndex);
      if (slot.kind === 'effect' && this.stopped(slot.effect)) slot = { kind: 'effect', effect: this.d.store.defaultEffect };
      slots.set(materialIndex, slot);
    }
    return slot;
  }

  // いま使っているエフェクトが宣言するオフスクリーン (割り当てのタブ。名前ごとに 1 つ)
  offscreenTabs(): { name: string; description: string }[] {
    return this.offscreen.tabs();
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

  private instance(e: LoadedEffect): EffectInstance {
    let inst = this.instances.get(e);
    if (!inst) {
      inst = new EffectInstance(e, () => this.d.viewport.requestDraw());
      this.instances.set(e, inst);
    }
    return inst;
  }

  // three.js の render の中 (空の場面の onAfterRender) で fn を呼ぶ。そのとき描く形 (geometries) を GPU に送らせる
  private inThree(renderer: THREE.WebGLRenderer, geometries: THREE.BufferGeometry[], fn: () => void): void {
    const geos = new Set<THREE.BufferGeometry>();
    if (this.chain) geos.add(this.chain.quad);
    for (const g of geometries) geos.add(g);
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

  // 色・深度・ステンシル (0) を消す
  private clear(renderer: THREE.WebGLRenderer): void {
    renderer.state.buffers.color.setMask(true);
    renderer.state.buffers.stencil.setClear(0);
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

  // エフェクトの警告。まだ資源 (EffectInstance) がなければ作らずに、名前を付けて全体の警告にする
  private warnFor(e: LoadedEffect, message: string): void {
    const inst = this.instances.get(e);
    if (inst) inst.warn(message);
    else this.warn(`${e.name}: ${message}`);
  }
}
