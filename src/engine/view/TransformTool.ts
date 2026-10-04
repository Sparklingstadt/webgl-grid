import * as THREE from 'three';
import { DEG } from '../../core/constants';
import type { History } from '../history/History';
import type { SceneGraph } from '../render/SceneGraph';
import type { Viewport } from '../render/Viewport';
import { isShape, type Obj } from '../types';
import type { UiChannel } from '../UiChannel';
import type { Selection } from '../world/Selection';
import type { World } from '../world/World';
import { rayPlane, type CameraController } from './CameraController';

export type TransformMode = 'grab' | 'rotate' | 'scale';
export type TransformAxis = 'x' | 'z' | null;
interface Item { obj: Obj; x: number; z: number; r: number; scale: number }
interface State {
  mode: TransformMode; items: Item[]; axis: TransformAxis; typed: string;
  pivot: [number, number]; planeY: number; center: { x: number; y: number }; start: { x: number; y: number }; ground0: [number, number] | null;
}

// --- G・R・S (Blender のモーダルな移動・回転・拡大縮小) ---
// キーを押したら、マウスを動かすと選んでいる物が動く。クリック・Enter で決める、Esc・右クリックでやめる (元に戻す)。
// 移動は X・Y キーで軸をしぼる (Y は奥行き)。数字を打つと、その値ちょうど (移動は距離・回転は度・拡大縮小は倍率)。
// 回転と拡大縮小は、選んでいる物の真ん中を中心にする (位置も一緒に回る・広がる)。大きさは形だけ (MMD モデル・ライトは変えない)。
// スナップ (Blender と同じ): Ctrl を押しているあいだ (見出しの磁石を入れているときは、押していないあいだ)、
// 移動はグリッド (1 m。Shift も押すと 0.1 m) に、回転は 15° (Shift で 1°) ずつ、拡大縮小は 0.1 倍 (Shift で 0.01 倍) ずつ。
// 決めるまでを、元に戻すの 1 手にする
export class TransformTool {
  private s: State | null = null;
  private mouse: { x: number; y: number } | null = null; // いまのマウスの位置 (クライアント座標)
  private ctrl = false; private shift = false;           // いま押している修飾キー
  snapOn = false;                                         // 見出しの磁石 (Shift+Tab)
  private abort: AbortController | null = null;

  constructor(private world: World, private selection: Selection, private camera: CameraController, private graph: SceneGraph,
              private viewport: Viewport, private history: History, private ui: UiChannel) {}

  // 描画先ができたら、マウスの位置を見はじめる (返り値で片付ける)
  mount() {
    const ac = new AbortController();
    addEventListener('pointermove', e => { this.mouse = { x: e.clientX, y: e.clientY }; this.mods(e); if (this.s) this.update(); }, { passive: true, signal: ac.signal });
    return () => { this.cancel(); ac.abort(); };
  }

  get active() { return !!this.s; }
  setSnap(on: boolean) {
    this.snapOn = on;
    this.ui.set({ snap: on });
    if (this.s) this.update();
  }
  private mods(e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) {
    const ctrl = e.ctrlKey || e.metaKey, changed = ctrl !== this.ctrl || e.shiftKey !== this.shift;
    this.ctrl = ctrl;
    this.shift = e.shiftKey;
    return changed;
  }

  start(mode: TransformMode) {
    const canvas = this.viewport.canvas;
    if (!canvas) return false;
    if (this.s) { this.restore(); this.s.mode = mode; this.s.typed = ''; this.begin(); this.update(); return true; } // (途中でほかの操作に切り替える)
    const items = this.selection.list.filter(o => !o.hidden && (mode !== 'scale' || isShape(o)))
      .map(obj => ({ obj, x: obj.x, z: obj.z, r: obj.r, scale: obj.scale ?? 1 }));
    if (!items.length) return false;
    this.history.checkpoint(); // (前の操作がまだ手になっていなければ、先に 1 手にしておく)
    this.history.hold();
    const n = items.length;
    const pivot: [number, number] = [items.reduce((a, i) => a + i.x, 0) / n, items.reduce((a, i) => a + i.z, 0) / n];
    const planeY = items.reduce((a, i) => a + i.obj.py, 0) / n;
    const r = canvas.getBoundingClientRect();
    const inside = this.mouse && this.mouse.x >= r.left && this.mouse.x <= r.right && this.mouse.y >= r.top && this.mouse.y <= r.bottom;
    const start = inside ? { ...this.mouse! } : { x: r.left + r.width * 0.6, y: r.top + r.height * 0.5 };
    if (!inside) this.mouse = { ...start };
    this.s = { mode, items, axis: null, typed: '', pivot, planeY, center: this.toScreen(pivot[0], planeY, pivot[1]), start, ground0: null };
    this.begin();
    // 決める・やめるまでは、ビューポートの操作 (選ぶ・カメラ) より先にマウスを受け取る
    this.abort = new AbortController();
    const opt = { capture: true, signal: this.abort.signal };
    addEventListener('pointerdown', e => {
      e.stopPropagation();
      e.preventDefault();
      if (e.button === 2) this.cancel(); else this.confirm();
      // (続けて届くクリック・右クリックのメニューを止める)
      addEventListener('click', ev => ev.stopPropagation(), { capture: true, once: true });
    }, opt);
    addEventListener('contextmenu', e => e.preventDefault(), opt);
    // キーも、フォーカスのある部品 (アウトライナーの行など) より先に受け取る
    addEventListener('keydown', e => { if (this.key(e)) { e.preventDefault(); e.stopPropagation(); } }, opt);
    addEventListener('keyup', e => { if (this.mods(e)) this.update(); }, opt);
    this.update();
    return true;
  }
  private begin() {
    const s = this.s!;
    s.start = { ...(this.mouse ?? s.start) };
    s.ground0 = rayPlane(this.camera.screenRay(s.start.x, s.start.y), s.planeY);
    canvasCursor(this.viewport.canvas, s.mode);
  }

  // 動いている途中のキー。使ったら true
  key(e: KeyboardEvent): boolean {
    const s = this.s;
    if (!s) return false;
    if (e.key === 'Control' || e.key === 'Meta' || e.key === 'Shift') { if (this.mods(e)) this.update(); return true; }
    if (e.key === 'Escape') { this.cancel(); return true; }
    if (e.key === 'Enter' || e.key === ' ') { this.confirm(); return true; }
    const k = e.key.toLowerCase();
    if (k === 'g' || k === 'r' || k === 's') { this.start(k === 'g' ? 'grab' : k === 'r' ? 'rotate' : 'scale'); return true; }
    if (s.mode === 'grab' && (k === 'x' || k === 'y')) {
      const axis: TransformAxis = k === 'x' ? 'x' : 'z';
      s.axis = s.axis === axis ? null : axis;
      this.update();
      return true;
    }
    if (/^[0-9.]$/.test(e.key)) { s.typed += e.key; this.update(); return true; }
    if (e.key === '-') { s.typed = s.typed.startsWith('-') ? s.typed.slice(1) : `-${s.typed}`; this.update(); return true; }
    if (e.key === 'Backspace') { s.typed = s.typed.slice(0, -1); this.update(); return true; }
    return true; // (ほかのキーは、動かしているあいだは使わない)
  }

  confirm() {
    if (!this.s) return;
    this.end();
    this.history.release();
    this.history.checkpoint(); // (すぐ 1 手にする。続けて G・R・S しても混ざらない。マウスを押しているあいだは、離したときに)
  }
  cancel() {
    if (!this.s) return;
    this.restore();
    this.world.settle();
    this.end();
    this.history.release();
  }
  private end() {
    this.s = null;
    this.abort?.abort();
    this.abort = null;
    canvasCursor(this.viewport.canvas, null);
    this.ui.set({ transform: null });
    this.selection.publish();
    this.viewport.requestDraw();
  }
  private restore() {
    for (const i of this.s!.items) Object.assign(i.obj, { x: i.x, z: i.z, r: i.r, scale: i.scale === 1 ? undefined : i.scale });
  }

  // マウス (か打った数字) に合わせて動かす
  private update() {
    const s = this.s!, m = this.mouse ?? s.start;
    const typed = s.typed && s.typed !== '-' && s.typed !== '.' ? Number(s.typed) : null;
    const num = typed !== null && Number.isFinite(typed) ? typed : null;
    const [px, pz] = s.pivot;
    const snap = num === null && this.snapOn !== this.ctrl, fine = this.shift;
    const round = (v: number, step: number) => Math.round(v / step) * step;
    if (s.mode === 'grab') {
      let dx = 0, dz = 0;
      if (num !== null) { if (s.axis === 'z') dz = num; else dx = num; }
      else {
        const g = rayPlane(this.camera.screenRay(m.x, m.y), s.planeY);
        if (g && s.ground0) { dx = g[0] - s.ground0[0]; dz = g[1] - s.ground0[1]; }
        if (s.axis === 'x') dz = 0;
        if (s.axis === 'z') dx = 0;
        // (真ん中がグリッドの目に乗るように)
        if (snap) { const st = fine ? 0.1 : 1; if (s.axis !== 'z') dx = round(px + dx, st) - px; if (s.axis !== 'x') dz = round(pz + dz, st) - pz; }
      }
      for (const i of s.items) { i.obj.x = i.x + dx; i.obj.z = i.z + dz; }
      this.publish(num !== null ? s.typed : `${fmt(dx)}, ${fmt(dz)}`);
    } else if (s.mode === 'rotate') {
      // 画面の上で時計回りにマウスを回すと、上から見て時計回り
      const ang = (p: { x: number; y: number }) => Math.atan2(p.y - s.center.y, p.x - s.center.x);
      let a = num !== null ? num * DEG : -(ang(m) - ang(s.start));
      a = Math.atan2(Math.sin(a), Math.cos(a));
      if (snap) a = round(a, (fine ? 1 : 15) * DEG);
      const c = Math.cos(a), sn = Math.sin(a);
      for (const i of s.items) {
        const dx = i.x - px, dz = i.z - pz;
        i.obj.x = px + c * dx + sn * dz;
        i.obj.z = pz - sn * dx + c * dz;
        i.obj.r = i.r + a;
      }
      this.publish(num !== null ? `${s.typed}°` : `${(a / DEG).toFixed(1)}°`);
    } else {
      const d = (p: { x: number; y: number }) => Math.hypot(p.x - s.center.x, p.y - s.center.y);
      let f = num ?? d(m) / Math.max(d(s.start), 10);
      if (snap) f = Math.max(round(f, fine ? 0.01 : 0.1), fine ? 0.01 : 0.1);
      for (const i of s.items) {
        const k = Math.min(Math.max(i.scale * f, 0.05), 20);
        i.obj.scale = k === 1 ? undefined : k;
        i.obj.x = px + (i.x - px) * f;
        i.obj.z = pz + (i.z - pz) * f;
      }
      this.publish(num !== null ? `${s.typed}×` : `${f.toFixed(3)}×`);
    }
    this.world.settle();
    this.selection.publish();
    this.viewport.requestDraw();
  }
  private publish(value: string) {
    const s = this.s!;
    const snap = !s.typed && this.snapOn !== this.ctrl;
    this.ui.set({ transform: { mode: s.mode, axis: s.axis, value, count: s.items.length, snap } });
  }
  private toScreen(x: number, y: number, z: number) {
    const r = this.viewport.canvas!.getBoundingClientRect(), v = new THREE.Vector3(x, y, z).project(this.graph.camera);
    return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
  }
}

const fmt = (v: number) => (Math.abs(v) < 5e-4 ? '0' : v.toFixed(2));
const canvasCursor = (canvas: HTMLCanvasElement | null, mode: TransformMode | null) => {
  canvas?.classList.toggle('transforming', !!mode);
};
