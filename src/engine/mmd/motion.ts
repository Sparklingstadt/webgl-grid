import * as THREE from 'three';
import { cam, setViewName } from '../camera';
import { DEFAULT_FOV, FPS, MMD_SCALE } from '../constants';
import { requestDraw } from '../loop';
import { boxes } from '../objects';
import { camera } from '../scene';
import { publishSel } from '../selection';
import { fitEndToContent, seek, setPlaying, tl } from '../timeline';
import type { Any, MotionInfo, Obj } from '../types';
import { bump, toast } from '../ui';
import { loadMMDLoader } from './loader';
import { resetAnimatedPhysics } from './physics';
import { stageModel } from './stage';

// --- VMD モーションの再生 ---
// MMDAnimationHelper が、モーションの再生・IK (足の接地など)・付与 (連動する骨) を計算する。
// 物理演算はこのページの仕組み (physics.ts) で、モーションのあとに計算する。
// 再生位置はタイムラインが決める (モーションは繰り返さず、最後まで行ったら最後の姿勢で止まる)
export let animHelper: Any = null;
export async function ensureAnimHelper() {
  const { MMDAnimationHelper } = await import('three/examples/jsm/animation/MMDAnimationHelper.js');
  return animHelper ??= new MMDAnimationHelper();
}

// クリップの再生の設定と、タイムラインに印を付けるキーフレームの位置 (フレーム番号)
function motionInfo(target: THREE.Object3D, clip: THREE.AnimationClip): MotionInfo {
  const action = animHelper.objects.get(target).mixer.existingAction(clip);
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  const frames = new Set<number>();
  for (const track of clip.tracks) for (const t of track.times) frames.add(Math.round(t * FPS));
  return { action, duration: clip.duration, frames: Int32Array.from(frames).sort() };
}

export async function playMotions(vmds: File[], objs: Obj[]) {
  const label = vmds.map(f => f.name).join('、');
  toast(`${label} を読み込み中…`, 0);
  try {
    const { MMDLoader } = await loadMMDLoader();
    await ensureAnimHelper();
    const loader: Any = new MMDLoader();
    let used = false, hasModelMotion = false;
    for (const file of vmds) {
      const url = URL.createObjectURL(file);
      let vmd: Any;
      try {
        vmd = await new Promise((resolve, reject) => loader.loadVMD(url, resolve, undefined, reject));
      } finally {
        URL.revokeObjectURL(url);
      }
      // カメラの動き
      if (vmd.metadata.cameraCount > 0) {
        startCameraMotion(loader.animationBuilder.buildCameraAnimation(vmd));
        used = true;
      }
      // モデルの動き (骨と表情)
      if (vmd.metadata.motionCount + vmd.metadata.morphCount > 0) {
        hasModelMotion = true;
        for (const obj of objs) {
          if (!boxes.includes(obj)) continue; // 読み込み中に消された
          const mesh = obj.model;
          const clip = loader.animationBuilder.build(vmd, mesh);
          if (!clip.tracks.length) continue; // 骨や表情の名前が1つも合わない
          if (animHelper.objects.has(mesh)) animHelper.remove(mesh);
          mesh.pose(); // 前のモーションの姿勢を元に戻してから付ける
          animHelper.add(mesh, { animation: clip, physics: false });
          obj.motion = motionInfo(mesh, clip);
          obj.animated = true;
          used = true;
        }
      }
    }
    if (!used) {
      toast(hasModelMotion && !objs.length
        ? '先に .pmx のモデルを読み込んでください。'
        : `${label} には、このモデルの骨や表情に合う動きも、カメラの動きもありませんでした`, 8000);
      return false;
    }
    // 終了フレームをモーション (と曲) の長さに合わせ、ダンス・カメラ・曲を最初からそろえて再生する
    fitEndToContent();
    seek(tl.start / FPS);
    setPlaying(true);
    publishSel();
    bump('keysVersion');
    bump('modelVersion');
    toast(`${label} を再生しています${camMotion ? '。カメラを自分で動かすと、カメラモーションは止まります' : ''}`, 6000);
    return true;
  } catch (err: Any) {
    console.error(err);
    toast(`${label} を読み込めませんでした: ${err?.message ?? err}`, 8000);
    return false;
  }
}

// すべてのモーション (ダンスとカメラ) を、時刻 t (秒) の姿勢にする。
// warmup は、飛んだ先の姿勢に物理演算の剛体をなじませる回数
export function seekMotions(t: number, warmup = 30) {
  if (!animHelper) return;
  // (animHelper.objects は WeakMap で中身をたどれないので、再生中のモデルとカメラを自分で並べる)
  const list: [THREE.Object3D, MotionInfo][] = [
    ...boxes.filter(b => b.animated && b.motion).map(b => [b.model, b.motion!] as [THREE.Object3D, MotionInfo]),
    ...(camMotion ? [[camMotion.cam, camMotion.motion] as [THREE.Object3D, MotionInfo]] : []),
  ];
  for (const [target, info] of list) {
    // 最後まで行って止まった動きも、もう一度動くようにしてから時刻を合わせる
    info.action.paused = false;
    info.action.enabled = true;
    animHelper.objects.get(target)?.mixer?.setTime(Math.min(t, info.duration));
  }
  animHelper.update(0);
  if (warmup) resetAnimatedPhysics(warmup);
}
// モーションを delta 秒進める (0 なら、いまの時刻の姿勢を計算し直すだけ)
export function updateMotions(delta: number) {
  if (hasMotion()) animHelper.update(delta);
}
export function stopMotion(obj: Obj) {
  if (!obj.animated) return;
  animHelper.remove(obj.model);
  obj.animated = false;
  obj.motion = null;
}
export const hasMotion = () => !!camMotion || boxes.some(b => b.animated);

// --- VMD のカメラモーション ---
// MMD のカメラは、モデルが原点に立っている MMD の単位の座標で動く。
// 置いてある最初のモデルと同じ変換 (大きさ・向き・置き場所) をかけて、このページのカメラに写す
export let camMotion: { cam: THREE.PerspectiveCamera; motion: MotionInfo } | null = null;
function startCameraMotion(clip: THREE.AnimationClip) {
  if (camMotion) animHelper.remove(camMotion.cam);
  const mmdCam = new THREE.PerspectiveCamera(DEFAULT_FOV);
  animHelper.add(mmdCam, { animation: clip });
  camMotion = { cam: mmdCam, motion: motionInfo(mmdCam, clip) };
}
const _stage = new THREE.Matrix4(), _up = new THREE.Vector3();
export const cameraTarget = new THREE.Vector3(); // カメラモーションの注視点 (このページの座標)
function stageMatrix() {
  // ステージがあるときは、ステージの原点を基準にする
  if (stageModel) return _stage.copy(stageModel.matrixWorld);
  const model = boxes.find(b => b.s === 3);
  if (model) {
    model.node.updateMatrixWorld(true);
    return _stage.copy(model.model.matrixWorld);
  }
  // モデルがないときは、原点に身長 20 (MMD のモデルのよくある大きさ) のモデルが立っているとみなす
  return _stage.makeScale(MMD_SCALE, MMD_SCALE, MMD_SCALE);
}
export function applyCameraMotion() {
  const c = camMotion!.cam, m = stageMatrix();
  camera.position.copy(c.position).applyMatrix4(m);
  cameraTarget.copy(animHelper.cameraTarget.position).applyMatrix4(m);
  camera.up.copy(_up.copy(c.up).transformDirection(m));
  camera.lookAt(cameraTarget);
  if (camera.fov !== c.fov) { camera.fov = c.fov; camera.updateProjectionMatrix(); }
  camera.updateMatrixWorld();
}
// カメラモーションをやめる。keepView なら、いまの視点から手動の操作に引き継ぐ
export function stopCameraMotion(keepView: boolean) {
  if (!camMotion) return;
  if (keepView) {
    // カメラモーションの注視点・位置・視野角をそのまま引き継ぐ (傾き (ロール) だけは引き継げない)
    applyCameraMotion();
    const off = camera.position.clone().sub(cameraTarget);
    const len = Math.max(off.length(), 0.01);
    Object.assign(cam, {
      tx: cameraTarget.x, ty: Math.max(cameraTarget.y, 0), tz: cameraTarget.z,
      dist: Math.min(len, 60),
      yaw: Math.atan2(off.z, off.x),
      pitch: Math.min(Math.max(Math.asin(off.y / len), -1.4), 1.5),
      fov: camera.fov,
    });
  }
  animHelper.remove(camMotion.cam);
  camMotion = null;
  setViewName('');
  bump('keysVersion');
  requestDraw();
}
