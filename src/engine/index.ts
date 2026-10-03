import * as THREE from 'three';
import { OutlineEffect } from 'three/examples/jsm/effects/OutlineEffect.js';
import { CAM_DEFAULT, cam, cancelViewAnim, getCamera, setViewName } from './camera';
import { restoreFx } from './fx';
import { attachInput } from './input';
import { requestDraw, resize } from './loop';
import { stopCameraMotion } from './mmd/motion';
import { removeStage } from './mmd/stage';
import { stopMusic } from './music';
import { boxes, closePicker, makeBox, removeObject, updateAddButton } from './objects';
import { gl } from './scene';
import { selectObj } from './selection';
import { resetTimeline } from './timeline';
import { toast } from './ui';

// three.js の場面と操作 (エンジン) の入口。画面の部品 (React) は、ここから読み込む。
// 状態は ui ストアで知らされ、操作はここから export する関数で行う

export { FPS, PALETTE, PALETTE_NAMES, SHAPE_NAMES, paletteCss } from './constants';
export { ui, type SelInfo, type UiState } from './ui';
export { getCamera, resetView, setMode, snapView } from './camera';
export { onRender, requestDraw } from './loop';
export { addShape, closePicker, deleteSelected, pickColor, setObjColor, setObjProp } from './objects';
export { selectById, selectObj } from './selection';
export { loadFiles } from './mmd/loader';
export {
  BONE_MOVE, BONE_ROTATE, boneNote, getBoneFlags, getBoneGroups, getBoneSel, getBoneValue, getMorphs, getMorphValue,
  resetMorphs, resetPose, setBoneSel, setBoneValue, setMorphValue, type BoneGroup, type MorphItem,
} from './mmd/pose';
export { loadPoseFile, savePose } from './mmd/vpd';
export {
  deleteKeyHere, deleteSelectedKeys, getSelectedKeys, insertKey, moveSelectedKeys, selectKeys,
} from './keyframes';
export {
  getTimelineRows, jumpKey, jumpToEnd, jumpToStart, seekFrame, setPlaying, setRange, stepFrame, togglePlay, type TlRow,
} from './timeline';
export { setFx, setFxLevel } from './fx';
export type { BoneValue } from './types';

// ファイル > 最初の状態に戻す: 読み込んだモデル・モーション・曲を消し、原点の立方体 1 個と最初の視点に戻す
export function resetAll() {
  stopMusic();
  stopCameraMotion(false);
  selectObj(null);
  closePicker();
  cancelViewAnim();
  Object.assign(cam, CAM_DEFAULT);
  setViewName('');
  while (boxes.length) removeObject(boxes[0]);
  removeStage();
  boxes.push(makeBox(0, 0, 0));
  resetTimeline();
  updateAddButton();
  requestDraw();
}

// --- 始める (ビューポートの canvas ができたときに 1 回だけ) ---
let started = false;
export function initEngine(canvas: HTMLCanvasElement, viewport: HTMLElement) {
  if (started) return;
  started = true;
  gl.canvas = canvas;
  gl.viewport = viewport;
  try {
    gl.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch {
    toast('WebGL2 に対応していません', 0);
    return;
  }
  const { renderer } = gl;
  renderer.setClearColor(0x000000, 0); // 背景は CSS の色 (Blender のビューポートの灰色) を見せる
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // MMD モデルの輪郭線。太さ・色・表示の有無は、MMDLoader が .pmx の材質から読んで
  // material.userData.outlineParameters に入れてくれる。それ以外の物には輪郭線を付けない (選択中だけオレンジ)
  gl.outline = new OutlineEffect(renderer);
  boxes.push(makeBox(0, 0, 0)); // 原点に立方体を 1 つ
  attachInput(canvas);
  restoreFx();
  new ResizeObserver(resize).observe(viewport); // 窓の大きさ・サイドバー・タイムラインの開け閉めで変わる
  resize();
  resetTimeline();
  if (new URLSearchParams(location.search).has('debug')) exposeDebug();
}

// 動作確認用: ?debug を付けて開いたときだけ、中の状態をコンソールから触れるようにする
async function exposeDebug() {
  const [motion, physics, stage, music, selection, input, timeline, keyframes, loader, vpd, pose, fx, camera, sjis, ui] = await Promise.all([
    import('./mmd/motion'), import('./mmd/physics'), import('./mmd/stage'), import('./music'), import('./selection'),
    import('./input'), import('./timeline'), import('./keyframes'), import('./mmd/loader'), import('./mmd/vpd'),
    import('./mmd/pose'), import('./fx'), import('./camera'), import('./sjis'), import('./ui'),
  ]);
  Object.assign(window, {
    THREE, gl, camera: getCamera(), boxes, cam, ui: ui.ui, tl: timeline.tl, loadFiles: loader.loadFiles, loadPose: vpd.loadPose,
    applyPose: pose.applyPose, encodeShiftJis: sjis.encodeShiftJis, insertKey: keyframes.insertKey,
    seek: timeline.seek, setPlaying: timeline.setPlaying, selectObj: selection.selectObj, pickBox: camera.pickBox,
    screenRay: camera.screenRay, physicsList: physics.physicsList, pointers: input.pointers,
    getSel: () => selection.selObj, getAnimHelper: () => motion.animHelper, getCamMotion: () => motion.camMotion,
    getStage: () => stage.stageModel, getMusic: () => music.music, getDrag: () => input.drag, getFx: () => fx.fx,
  });
}
