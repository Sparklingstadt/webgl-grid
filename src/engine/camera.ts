import * as THREE from 'three';
import { DEFAULT_FOV } from './constants';
import { render, requestDraw } from './loop';
import { applyCameraMotion, camMotion, stopCameraMotion } from './mmd/motion';
import { boxes } from './objects';
import { camera, gl } from './scene';
import type { Obj } from './types';
import { ui } from './ui';

// --- オービットカメラ (注視点を中心に回転 / 地面に沿って移動) ---
// ty は注視点の高さ (ふだんは地面の 0。カメラモーションから引き継いだときだけ浮く)
export const CAM_DEFAULT = { yaw: Math.PI / 4, pitch: 0.6, dist: 9.8, tx: 0, ty: 0, tz: 0, fov: DEFAULT_FOV };
export const cam = { ...CAM_DEFAULT };
// 「前」「右」「上」から見ているとき、その名前 (ビューポート左上の表示用)
export let viewName = '';
export const setViewName = (name: string) => { viewName = name; };

// 左のツールバー: ドラッグでカメラを回すか、平行移動するか
export let mode: 'orbit' | 'pan' = 'orbit';
export function setMode(m: 'orbit' | 'pan') {
  mode = m;
  ui.set({ mode: m });
  gl.canvas?.classList.toggle('pan', m === 'pan');
}

function camPos(): [number, number, number] {
  const cp = Math.cos(cam.pitch);
  return [
    cam.tx + cam.dist * cp * Math.cos(cam.yaw),
    cam.ty + cam.dist * Math.sin(cam.pitch),
    cam.tz + cam.dist * cp * Math.sin(cam.yaw)];
}
export function updateCamera() {
  if (camMotion) { applyCameraMotion(); return; }
  if (camera.fov !== cam.fov) { camera.fov = cam.fov; camera.updateProjectionMatrix(); }
  camera.up.set(0, 1, 0);
  camera.position.set(...camPos());
  camera.lookAt(cam.tx, cam.ty, cam.tz);
  camera.updateMatrixWorld();
}
export const getCamera = () => camera;

// カメラの距離を factor 倍にする (ホイールとピンチで共通)
export function zoomBy(factor: number) {
  stopCameraMotion(true);
  cam.dist = Math.min(Math.max(cam.dist * factor, Math.min(2, cam.dist)), 60); // カメラモーションから引き継いだ近い距離は保つ
  requestDraw();
}

// --- 画面上の点からのレイ ---
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
export type Ray = { ro: number[]; rd: number[] };
export function screenRay(cx: number, cy: number): Ray {
  updateCamera();
  // 画面上の位置 (clientX/Y) を、ビューポートの中の位置に直す
  const r = gl.canvas.getBoundingClientRect();
  ndc.set((cx - r.left) / gl.width * 2 - 1, -((cy - r.top) / gl.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  return { ro: raycaster.ray.origin.toArray(), rd: raycaster.ray.direction.toArray() };
}
// 一番手前で当たる物 { box, t } (なければ null)。three.js のレイキャストで、見た目の形どおりに判定する
export function pickBox({ ro, rd }: Ray): { box: Obj; t: number } | null {
  raycaster.ray.origin.fromArray(ro);
  raycaster.ray.direction.fromArray(rd);
  const hit = raycaster.intersectObjects(boxes.map(b => b.node), true)[0];
  if (!hit) return null;
  let o: THREE.Object3D | null = hit.object;
  while (o && !o.userData.obj) o = o.parent;
  return o ? { box: o.userData.obj, t: hit.distance } : null;
}
// レイと水平面 y = h の交点 (xz)。面と平行なら null
export function rayPlane({ ro, rd }: Ray, h: number): [number, number] | null {
  if (Math.abs(rd[1]) < 1e-6) return null;
  const t = (h - ro[1]) / rd[1];
  return t > 0 ? [ro[0] + rd[0] * t, ro[2] + rd[2] * t] : null;
}

// --- 決まった向きから見る (ナビゲーションギズモ・テンキー 1/3/7・Home) ---
const VIEWS: Record<string, { yaw?: number; pitch: number; name: string }> = {
  front: { yaw: Math.PI / 2, pitch: 0.05, name: '前' },   // MMD のモデルは +Z を向いている
  back: { yaw: -Math.PI / 2, pitch: 0.05, name: '後' },
  right: { yaw: 0, pitch: 0.05, name: '右' },
  left: { yaw: Math.PI, pitch: 0.05, name: '左' },
  top: { pitch: 1.5, name: '上' },
};
let viewAnim = 0;
export const cancelViewAnim = () => { viewAnim++; };
// 少しかけて回し、その向きから見る
export function snapView(key: string) {
  if (key === 'home') { resetView(); return; }
  const v = VIEWS[key];
  if (!v) return;
  stopCameraMotion(true);
  const from = { yaw: cam.yaw, pitch: cam.pitch };
  let toYaw = v.yaw ?? cam.yaw;
  toYaw = from.yaw + Math.atan2(Math.sin(toYaw - from.yaw), Math.cos(toYaw - from.yaw)); // 近いほうへ回る
  const t0 = performance.now(), id = ++viewAnim;
  const step = (now: number) => {
    if (id !== viewAnim) return;
    const s = Math.min((now - t0) / 220, 1), e = s * s * (3 - 2 * s);
    cam.yaw = from.yaw + (toYaw - from.yaw) * e;
    cam.pitch = from.pitch + (v.pitch - from.pitch) * e;
    render();
    if (s < 1) requestAnimationFrame(step);
    else { viewName = v.name; requestDraw(); } // 左上の「上・透視投影」などを描き直す
  };
  requestAnimationFrame(step);
}
export function resetView() {
  stopCameraMotion(false);
  viewAnim++;
  Object.assign(cam, CAM_DEFAULT);
  viewName = '';
  requestDraw();
}
