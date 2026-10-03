import * as THREE from 'three';
import { cam, updateCamera, viewName } from './camera';
import { PALETTE } from './constants';
import { renderWithFx, resizeFx } from './fx';
import { drag } from './input';
import { applyPose } from './mmd/pose';
import { camMotion, hasMotion, updateMotions } from './mmd/motion';
import { physicsList, stepPhysics } from './mmd/physics';
import { boxes, pickerBox } from './objects';
import { LIGHT, camera, gl, scene, sun } from './scene';
import { publishSel, selObj, setOutlined } from './selection';
import { advanceTimeline, currentFrame, tl } from './timeline';
import type { Any, Obj } from './types';
import { ui } from './ui';

// --- 描画ループ ---
// 物理演算・モーション・再生があるあいだは毎フレーム計算して描き直す。それ以外は変化があったときだけ描く
let ticking = false, tickLast = 0;
export function startTicking() {
  if (ticking) return;
  ticking = true;
  tickLast = 0;
  requestAnimationFrame(tick);
}
function tick(now: number) {
  if (!physicsList.length && !hasMotion() && !tl.playing) { ticking = false; return; }
  const dt = tickLast ? Math.min(Math.max(now - tickLast, 0) / 1000, 1 / 20) : 1 / 60;
  tickLast = now;
  if (tl.playing) advanceTimeline(dt); // モーションを先に進めてから物理演算
  else updateMotions(0);
  // 手で動かしたボーン (とキーフレーム) は、モーションより優先する
  for (const b of boxes) if (b.animated && b.pose?.size) applyPose(b);
  stepPhysics(dt);
  render();
  requestAnimationFrame(tick);
}

let pending = false;
export function requestDraw() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => { pending = false; render(); });
}
// 描くたびに呼ぶ (ナビゲーションギズモがカメラの向きを描き直す)
const renderListeners = new Set<() => void>();
export function onRender(cb: () => void) {
  renderListeners.add(cb);
  return () => { renderListeners.delete(cb); };
}

// 掴んでいる物 (とパレットで色を変えている形) を明るくする
function setHighlight(obj: Obj, on: boolean) {
  obj.node.traverse(o => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const m of [mesh.material].flat() as Any[]) {
      if (!m.emissive) continue;
      m.userData.baseEmissive ??= m.emissive.clone();
      m.emissive.copy(m.userData.baseEmissive);
      if (on) m.emissive.addScalar(obj.s === 3 ? 0.12 : 0.3); // トゥーン調のモデルは明るくなりやすいので控えめに
    }
  });
}
export function render() {
  if (!gl.renderer) return;
  updateCamera();
  const held = drag?.box?.box ?? drag?.rot?.box ?? drag?.twist?.box ?? pickerBox;
  for (const b of boxes) {
    b.node.position.set(b.x, b.py, b.z);
    b.node.rotation.y = b.r;
    if (b.mesh) b.mesh.material.color.setRGB(...PALETTE[b.c], THREE.LinearSRGBColorSpace);
    setHighlight(b, b === held);
    setOutlined(b, b === selObj);
  }
  // 影は注視点のまわりだけ計算する
  const span = Math.max(12, cam.dist * 1.2);
  sun.target.position.set(cam.tx, 0, cam.tz);
  sun.position.copy(sun.target.position).addScaledVector(LIGHT, 40);
  Object.assign(sun.shadow.camera, { left: -span, right: span, top: span, bottom: -span, near: 1, far: 100 });
  sun.shadow.camera.updateProjectionMatrix();
  if (!renderWithFx()) gl.outline.render(scene, camera);
  // ビューポート左上の文字 (Blender の「ユーザー・透視投影」と「(フレーム) 選んでいる物」)
  publishSel();
  const what = camMotion ? 'カメラ' : viewName || 'ユーザー';
  ui.set({ viewInfo: `${what}・透視投影\n(${currentFrame()}) ${ui.get().sel?.name ?? ''}` });
  for (const cb of renderListeners) cb();
}

export function resize() {
  const { renderer, viewport } = gl;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  gl.width = Math.max(viewport.clientWidth, 1);
  gl.height = Math.max(viewport.clientHeight, 1);
  renderer.setSize(gl.width, gl.height, false);
  camera.aspect = gl.width / gl.height;
  camera.updateProjectionMatrix();
  resizeFx();
  render();
}
