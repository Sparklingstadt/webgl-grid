import * as THREE from 'three';
import { OutlineEffect } from 'three/examples/jsm/effects/OutlineEffect.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { outputFrame, scaleFov } from '../../core/output';
import type { SceneGraph } from './SceneGraph';

// 毎フレーム計算するもの (再生・モーション・物理演算・落下など)。active のあいだだけ update される
export interface System {
  active(): boolean;
  update(dt: number): void;
}

// --- 描画先 (WebGL) と描画ループ ---
// mount するまでは何も描かない (テストでは mount せずにエンジンを動かせる)。
// 描く前と描いたあとにすることは、各部が onBeforeRender / onRender で登録する
export class Viewport {
  renderer: THREE.WebGLRenderer | null = null;
  outline: OutlineEffect | null = null;
  canvas: HTMLCanvasElement | null = null;
  width = 1;
  height = 1;
  // 後処理 (効果) で描いたら true を返す。描かなければ、輪郭線付きでふつうに描く
  drawOverride: (() => boolean) | null = null;
  private readonly systems: System[] = [];
  private readonly before = new Set<() => void>();
  private readonly after = new Set<() => void>();
  private readonly resizeHooks = new Set<() => void>();
  private observer: ResizeObserver | null = null;
  private container: HTMLElement | null = null;
  // レンダリング (画像・動画の書き出し) 中は、その大きさで描き、描画ループを止めておく
  private output: { width: number; height: number; fovScale: number } | null = null;
  private ticking = false;
  private tickLast = 0;
  private scheduled = false; // 次のフレームの呼び出しを頼んである
  private dirty = false;     // 次のフレームで描き直す

  constructor(readonly graph: SceneGraph) {}

  // 毎フレームの計算は、登録した順に行う
  addSystem(s: System) { this.systems.push(s); }
  onBeforeRender(cb: () => void) { this.before.add(cb); return () => { this.before.delete(cb); }; }
  onRender(cb: () => void) { this.after.add(cb); return () => { this.after.delete(cb); }; }
  onResize(cb: () => void) { this.resizeHooks.add(cb); return () => { this.resizeHooks.delete(cb); }; }

  // canvas に描き始める。WebGL が使えなければ false
  mount(canvas: HTMLCanvasElement, container: HTMLElement) {
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    } catch {
      return false;
    }
    this.canvas = canvas;
    this.container = container;
    const { renderer } = this;
    renderer.setClearColor(0x000000, 0); // 背景は CSS の色 (Blender のビューポートの灰色) を見せる
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // MMD モデルの輪郭線。太さ・色・表示の有無は、MMDLoader が .pmx の材質から読んで
    // material.userData.outlineParameters に入れてくれる
    this.outline = new OutlineEffect(renderer);
    // 物理ベースのマテリアル (プリンシプル BSDF) の映り込み・環境の光。部屋の中のような柔らかい光にする
    const pmrem = new THREE.PMREMGenerator(renderer);
    this.graph.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.graph.scene.environmentIntensity = 0.3;
    pmrem.dispose();
    // 窓の大きさ・サイドバー・タイムラインの開け閉めで大きさが変わる
    this.observer = new ResizeObserver(() => this.resize(container));
    this.observer.observe(container);
    this.resize(container);
    this.startTicking();
    return true;
  }
  unmount() {
    this.observer?.disconnect();
    this.observer = null;
    this.renderer?.dispose();
    this.renderer = this.outline = this.canvas = this.container = null;
    this.output = null;
  }
  get mounted() { return !!this.renderer; }

  // 描き直しを頼む。何度頼まれても、次のフレームで 1 回だけ描く (再生中は、毎フレームの描画にまとめる)
  requestDraw() {
    this.dirty = true;
    this.schedule();
  }
  startTicking() {
    if (this.ticking || !this.renderer) return;
    this.ticking = true;
    this.tickLast = 0;
    this.schedule();
  }
  private schedule() {
    if (this.scheduled || !this.renderer) return;
    this.scheduled = true;
    requestAnimationFrame(this.frame);
  }
  // 1 フレーム: 動いているもの (System) を進めてから、1 回だけ描く
  private frame = (now: number) => {
    this.scheduled = false;
    if (!this.renderer) { this.ticking = false; return; }
    if (this.output) return; // レンダリング中 (終わったら動かし直す)
    if (this.ticking) {
      if (this.systems.some(s => s.active())) {
        const dt = this.tickLast ? Math.min(Math.max(now - this.tickLast, 0) / 1000, 1 / 20) : 1 / 60;
        this.tickLast = now;
        for (const s of this.systems) if (s.active()) s.update(dt);
        this.dirty = true;
      } else {
        this.ticking = false;
      }
    }
    if (this.dirty) this.render();
    if (this.ticking) this.schedule();
  };

  render() {
    if (!this.renderer || !this.outline) return;
    this.dirty = false;
    for (const cb of this.before) cb();
    if (this.output && this.output.fovScale !== 1) {
      // (カメラは毎回、描く前に自分の画角へ戻すので、ここで狭めても次の描画には残らない)
      const { camera } = this.graph;
      camera.fov = scaleFov(camera.fov, this.output.fovScale);
      camera.updateProjectionMatrix();
    }
    if (!this.drawOverride?.()) this.outline.render(this.graph.scene, this.graph.camera);
    for (const cb of this.after) cb();
  }

  // --- レンダリング (書き出し) ---
  // 描画先を width × height (等倍) にして、背景を塗り、描画ループを止める。描くのは呼ぶ側 (render() のあと、すぐ canvas を読む)。
  // ビューポートに出している出力の枠 (outputFrame) の中が、そのまま描かれるように画角を合わせる
  beginOutput(width: number, height: number, background: THREE.ColorRepresentation) {
    const { renderer } = this;
    if (!renderer) throw new Error('描画先がありません');
    this.output = { width, height, fovScale: outputFrame(this.width, this.height, width, height).fovScale };
    renderer.setClearColor(background, 1);
    this.applySize(width, height, 1);
  }
  endOutput() {
    if (!this.output) return;
    this.output = null;
    this.renderer?.setClearColor(0x000000, 0);
    if (this.container) this.resize(this.container);
    // 止めていたあいだの描画ループを動かし直す
    this.ticking = false;
    this.startTicking();
    this.requestDraw();
  }
  get outputting() { return !!this.output; }
  // 動いているもの (System) を dt 秒だけ進める (レンダリングでは、描画ループの代わりに 1 フレームずつ呼ぶ)
  stepSystems(dt: number) {
    for (const s of this.systems) if (s.active()) s.update(dt);
  }

  private resize(container: HTMLElement) {
    if (!this.renderer || this.output) return; // レンダリング中は、終わってから合わせる
    this.applySize(Math.max(container.clientWidth, 1), Math.max(container.clientHeight, 1), Math.min(window.devicePixelRatio || 1, 2));
    this.render();
  }
  private applySize(width: number, height: number, pixelRatio: number) {
    const renderer = this.renderer!;
    renderer.setPixelRatio(pixelRatio);
    this.width = width;
    this.height = height;
    renderer.setSize(width, height, false);
    const { camera } = this.graph;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    for (const cb of this.resizeHooks) cb();
  }
}
