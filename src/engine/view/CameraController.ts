import * as THREE from 'three';
import { DEFAULT_FOV } from '../../core/constants';
import { msg } from '../../core/i18n';
import type { SceneGraph } from '../render/SceneGraph';
import type { Viewport } from '../render/Viewport';
import type { Obj } from '../types';
import type { UiChannel } from '../UiChannel';
import type { World } from '../world/World';

export const CAM_DEFAULT = { yaw: Math.PI / 4, pitch: 0.6, dist: 9.8, tx: 0, ty: 0, tz: 0, fov: DEFAULT_FOV };
export type Ray = { ro: number[]; rd: number[] };

// カメラを外から動かすもの (VMD のカメラモーション)。target はその注視点 (このページの座標)
export interface CameraOverride {
  apply(camera: THREE.PerspectiveCamera): void;
  readonly target: THREE.Vector3;
  released(): void; // 自分でカメラを動かしてやめさせたとき
}

// 決まった向きから見る (ナビゲーションギズモ・テンキー 1/3/7)
const VIEWS: Record<string, { yaw?: number; pitch: number; name: string }> = {
  front: { yaw: Math.PI / 2, pitch: 0.05, name: msg('前') },   // MMD のモデルは +Z を向いている
  back: { yaw: -Math.PI / 2, pitch: 0.05, name: msg('後') },
  right: { yaw: 0, pitch: 0.05, name: msg('右') },
  left: { yaw: Math.PI, pitch: 0.05, name: msg('左') },
  top: { pitch: 1.5, name: msg('上') },
};

// --- オービットカメラ (注視点を中心に回転 / 地面に沿って移動) と、画面上の点からのレイ ---
// ty は注視点の高さ (ふだんは地面の 0。カメラモーションから引き継いだときだけ浮く)
export class CameraController {
  readonly cam = { ...CAM_DEFAULT };
  viewName = ''; // 「前」「右」「上」から見ているとき、その名前 (ビューポート左上の表示用)
  mode: 'orbit' | 'pan' = 'orbit';
  override: CameraOverride | null = null;
  private viewAnim = 0;
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();

  constructor(private graph: SceneGraph, private viewport: Viewport, private ui: UiChannel, private world: World) {}

  get camera() { return this.graph.camera; }

  setMode(m: 'orbit' | 'pan') {
    this.mode = m;
    this.ui.set({ mode: m });
    this.viewport.canvas?.classList.toggle('pan', m === 'pan');
  }

  // カメラの位置と向きを決める (カメラモーション中はそれに任せる)
  update() {
    const { camera, cam } = this;
    if (this.override) { this.override.apply(camera); return; }
    if (camera.fov !== cam.fov) { camera.fov = cam.fov; camera.updateProjectionMatrix(); }
    const cp = Math.cos(cam.pitch);
    camera.up.set(0, 1, 0);
    camera.position.set(cam.tx + cam.dist * cp * Math.cos(cam.yaw), cam.ty + cam.dist * Math.sin(cam.pitch), cam.tz + cam.dist * cp * Math.sin(cam.yaw));
    camera.lookAt(cam.tx, cam.ty, cam.tz);
    camera.updateMatrixWorld();
  }
  // 被写界深度のピントを合わせる点 (カメラモーション中はその注視点)
  private focus = new THREE.Vector3();
  focusPoint() { return this.override ? this.override.target : this.focus.set(this.cam.tx, this.cam.ty, this.cam.tz); }

  setOverride(o: CameraOverride | null) {
    this.override = o;
    this.viewName = '';
    this.viewport.requestDraw();
  }
  // カメラモーションをやめる。keepView なら、いまの視点から手動の操作に引き継ぐ (傾き (ロール) だけは引き継げない)
  releaseOverride(keepView: boolean) {
    const o = this.override;
    if (!o) return;
    if (keepView) {
      o.apply(this.camera);
      const off = this.camera.position.clone().sub(o.target);
      const len = Math.max(off.length(), 0.01);
      Object.assign(this.cam, {
        tx: o.target.x, ty: Math.max(o.target.y, 0), tz: o.target.z,
        dist: Math.min(len, 60),
        yaw: Math.atan2(off.z, off.x),
        pitch: Math.min(Math.max(Math.asin(off.y / len), -1.4), 1.5),
        fov: this.camera.fov,
      });
    }
    this.setOverride(null);
    o.released();
  }

  // 手でカメラを動かす (どれもカメラモーションをやめさせる)
  orbit(dx: number, dy: number) {
    const { cam } = this;
    this.userMoved();
    if (dx || dy) this.viewName = ''; // 「前」「上」などから回したら、ふつうの視点
    cam.yaw -= dx * 0.005;
    cam.pitch += dy * 0.005;
    // カメラが地面の下に潜らない角度まで (注視点が地面なら約 3° まで)
    const minPitch = cam.ty > 0 ? Math.asin(Math.min(Math.max((0.05 - cam.ty) / cam.dist, -1), 1)) : 0.05;
    cam.pitch = Math.min(Math.max(cam.pitch, minPitch), 1.5);
    this.viewport.requestDraw();
  }
  // 画面上の動きを地面上の前後左右に変換 (掴んだ地面が付いてくるように)
  pan(dx: number, dy: number) {
    const { cam } = this;
    this.userMoved();
    const k = cam.dist * 0.0015;
    const fx = -Math.cos(cam.yaw), fz = -Math.sin(cam.yaw); // 地面上の前方向
    const rx = -fz, rz = fx;                               // 地面上の右方向
    cam.tx += -rx * dx * k + fx * dy * k;
    cam.tz += -rz * dx * k + fz * dy * k;
    this.viewport.requestDraw();
  }
  // カメラの距離を factor 倍にする (ホイールとピンチで共通)
  zoomBy(factor: number) {
    this.releaseOverride(true);
    const { cam } = this;
    cam.dist = Math.min(Math.max(cam.dist * factor, Math.min(2, cam.dist)), 60); // カメラモーションから引き継いだ近い距離は保つ
    this.viewport.requestDraw();
  }
  private userMoved() {
    this.releaseOverride(true);
    this.viewAnim++;
  }

  // 少しかけて回し、その向きから見る
  snapView(key: string) {
    if (key === 'home') { this.resetView(); return; }
    const v = VIEWS[key];
    if (!v) return;
    this.releaseOverride(true);
    const { cam } = this;
    const from = { yaw: cam.yaw, pitch: cam.pitch };
    let toYaw = v.yaw ?? cam.yaw;
    toYaw = from.yaw + Math.atan2(Math.sin(toYaw - from.yaw), Math.cos(toYaw - from.yaw)); // 近いほうへ回る
    const t0 = performance.now(), id = ++this.viewAnim;
    const step = (now: number) => {
      if (id !== this.viewAnim) return;
      const s = Math.min((now - t0) / 220, 1), e = s * s * (3 - 2 * s);
      cam.yaw = from.yaw + (toYaw - from.yaw) * e;
      cam.pitch = from.pitch + (v.pitch - from.pitch) * e;
      if (s >= 1) this.viewName = v.name; // 左上の「上・透視投影」などは、着いてから
      this.viewport.render();
      if (s < 1) requestAnimationFrame(step);
    };
    if (this.viewport.mounted) requestAnimationFrame(step);
    else { cam.yaw = toYaw; cam.pitch = v.pitch; this.viewName = v.name; }
  }
  resetView() {
    this.releaseOverride(false);
    this.viewAnim++;
    Object.assign(this.cam, CAM_DEFAULT);
    this.viewName = '';
    this.viewport.requestDraw();
  }

  // 画面上の位置 (clientX/Y) を通るレイ
  screenRay(cx: number, cy: number): Ray {
    this.update();
    const r = this.viewport.canvas!.getBoundingClientRect();
    this.ndc.set((cx - r.left) / this.viewport.width * 2 - 1, -((cy - r.top) / this.viewport.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    return { ro: this.raycaster.ray.origin.toArray(), rd: this.raycaster.ray.direction.toArray() };
  }
  // 一番手前で当たる物 { obj, t } (なければ null)。three.js のレイキャストで、見た目の形どおりに判定する
  pick({ ro, rd }: Ray): { obj: Obj; t: number } | null {
    const { raycaster } = this;
    raycaster.ray.origin.fromArray(ro);
    raycaster.ray.direction.fromArray(rd);
    const nodes = this.world.objects.map(b => b.node);
    // 置き直した直後 (まだ描いていない) でも当たるよう、位置を最新にしてから調べる (描くときにも同じ計算をする)
    for (const n of nodes) n.updateMatrixWorld();
    const hit = raycaster.intersectObjects(nodes, true)[0];
    if (!hit) return null;
    let o: THREE.Object3D | null = hit.object;
    while (o && !o.userData.obj) o = o.parent;
    return o ? { obj: o.userData.obj, t: hit.distance } : null;
  }
}

// レイと水平面 y = h の交点 (xz)。面と平行なら null
export function rayPlane({ ro, rd }: Ray, h: number): [number, number] | null {
  if (Math.abs(rd[1]) < 1e-6) return null;
  const t = (h - ro[1]) / rd[1];
  return t > 0 ? [ro[0] + rd[0] * t, ro[2] + rd[2] * t] : null;
}
