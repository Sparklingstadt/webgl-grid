import * as THREE from 'three';
import { cam } from './camera';
import { VIEWPORT_BG } from './constants';
import { requestDraw } from './loop';
import { cameraTarget, camMotion } from './mmd/motion';
import { FX_KEYS, FX_LEVEL_DEFAULT, applyFxLevels, createPostFx, type FxKey, type FxLevel, type FxState, type PostFx } from './postfx';
import { camera, gl, scene } from './scene';
import { hideToast, toast, ui } from './ui';

// --- 効果 (MME 風の後処理) のオン・オフと強さ。設定はブラウザに保存する ---
const FX_KEY = 'webgl-grid-fx';
const FX_LEVEL_KEY = 'webgl-grid-fx-level';
const fxState: FxState = { ao: false, dof: false, bloom: false, diffusion: false, color: false };
try { Object.assign(fxState, JSON.parse(localStorage.getItem(FX_KEY) ?? '{}')); } catch { /* 保存されていない */ }
const fxLevel: FxLevel = { ...FX_LEVEL_DEFAULT };
try { Object.assign(fxLevel, JSON.parse(localStorage.getItem(FX_LEVEL_KEY) ?? '{}')); } catch { /* 保存されていない */ }
ui.set({ fxState: { ...fxState }, fxLevel: { ...fxLevel } });

export const anyFx = () => FX_KEYS.some(k => fxState[k]);
export let fx: PostFx | null = null;
let fxLoading: Promise<void> | null = null;
export function ensureFx() {
  fxLoading ??= createPostFx(gl.renderer, scene, camera, gl.outline, gl.width, gl.height, VIEWPORT_BG).then(p => {
    fx = p;
    applyFxLevels(fx, fxLevel);
  });
  return fxLoading;
}
// 前回オンにしていた効果を準備する
export function restoreFx() {
  if (anyFx()) ensureFx().then(requestDraw, err => console.error(err));
}

export async function setFx(k: FxKey, on: boolean) {
  fxState[k] = on;
  ui.set({ fxState: { ...fxState } });
  try { localStorage.setItem(FX_KEY, JSON.stringify(fxState)); } catch { /* 保存できなくても使える */ }
  if (anyFx() && !fx) {
    toast('効果を準備中…', 0);
    try {
      await ensureFx();
      hideToast();
    } catch (err) {
      console.error(err);
      toast(`効果を読み込めませんでした: ${(err as Error)?.message ?? err}`, 8000);
    }
  }
  requestDraw();
}
// 強さのスライダー。オフの効果を動かしたら、その効果をオンにする (色調の 3 本は「色調」のオン・オフに付く)
export function setFxLevel(k: keyof FxLevel, v: number) {
  fxLevel[k] = v;
  ui.set({ fxLevel: { ...fxLevel } });
  try { localStorage.setItem(FX_LEVEL_KEY, JSON.stringify(fxLevel)); } catch { /* 保存できなくても使える */ }
  if (fx) applyFxLevels(fx, fxLevel);
  const target: FxKey = k === 'temp' || k === 'sat' || k === 'bright' ? 'color' : k;
  if (!fxState[target]) setFx(target, true);
  else requestDraw();
}

// 被写界深度のピントを合わせる点 (カメラモーション中はその注視点)
const _focus = new THREE.Vector3();
const focusPoint = () => camMotion ? cameraTarget : _focus.set(cam.tx, cam.ty, cam.tz);
// 効果を使うときは後処理を通して描く。描いたら true
export function renderWithFx() {
  if (!fx || !anyFx()) return false;
  for (const k of FX_KEYS) fx.passes[k].enabled = fxState[k];
  if (fxState.dof) fx.passes.dof.uniforms.focus.value = camera.position.distanceTo(focusPoint());
  fx.composer.render();
  return true;
}
export function resizeFx() {
  if (!fx) return;
  fx.composer.setPixelRatio(gl.renderer.getPixelRatio());
  fx.composer.setSize(gl.width, gl.height);
}
