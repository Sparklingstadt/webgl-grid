import * as THREE from 'three';
import { OutlineEffect } from 'three/examples/jsm/effects/OutlineEffect.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
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
  private ticking = false;
  private tickLast = 0;
  private pending = false;

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
    this.renderer = this.outline = this.canvas = null;
  }
  get mounted() { return !!this.renderer; }

  requestDraw() {
    if (this.pending || !this.renderer) return;
    this.pending = true;
    requestAnimationFrame(() => { this.pending = false; this.render(); });
  }
  startTicking() {
    if (this.ticking || !this.renderer) return;
    this.ticking = true;
    this.tickLast = 0;
    requestAnimationFrame(this.tick);
  }
  private tick = (now: number) => {
    if (!this.renderer || !this.systems.some(s => s.active())) { this.ticking = false; return; }
    const dt = this.tickLast ? Math.min(Math.max(now - this.tickLast, 0) / 1000, 1 / 20) : 1 / 60;
    this.tickLast = now;
    for (const s of this.systems) if (s.active()) s.update(dt);
    this.render();
    requestAnimationFrame(this.tick);
  };

  render() {
    if (!this.renderer || !this.outline) return;
    for (const cb of this.before) cb();
    if (!this.drawOverride?.()) this.outline.render(this.graph.scene, this.graph.camera);
    for (const cb of this.after) cb();
  }

  private resize(container: HTMLElement) {
    const { renderer } = this;
    if (!renderer) return;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.width = Math.max(container.clientWidth, 1);
    this.height = Math.max(container.clientHeight, 1);
    renderer.setSize(this.width, this.height, false);
    const { camera } = this.graph;
    camera.aspect = this.width / this.height;
    camera.updateProjectionMatrix();
    for (const cb of this.resizeHooks) cb();
    this.render();
  }
}
