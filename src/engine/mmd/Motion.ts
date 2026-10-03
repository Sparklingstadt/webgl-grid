import * as THREE from 'three';
import { DEFAULT_FOV, FPS, MMD_SCALE } from '../../core/constants';
import { errorText } from '../../core/errors';
import { t } from '../../core/i18n';
import type { System } from '../render/Viewport';
import type { Any, ModelObj, MotionInfo, Obj } from '../types';
import type { UiChannel } from '../UiChannel';
import type { CameraController, CameraOverride } from '../view/CameraController';
import type { World } from '../world/World';
import { loadMMDLoader } from './MmdLoader';
import type { Physics } from './Physics';
import type { Stage } from './Stage';

// --- VMD モーション (ダンスとカメラ) の再生 ---
// MMDAnimationHelper が、モーションの再生・IK (足の接地など)・付与 (連動する骨) を計算する。
// 再生位置はタイムライン (Clock) が決め、seek / update で合わせる。
// モーションは繰り返さず、最後まで行ったら最後の姿勢で止まる
export class Motion implements System {
  helper: Any = null;
  camera: { cam: THREE.PerspectiveCamera; motion: MotionInfo } | null = null; // VMD のカメラモーション
  cameraFile: File | null = null; // カメラモーションの .vmd (プロジェクトに入れる)
  isPlaying = () => false; // タイムラインが再生中か (止まっているあいだは、毎フレーム姿勢だけ計算し直す)
  private stageMat = new THREE.Matrix4();
  private up = new THREE.Vector3();
  private target = new THREE.Vector3();

  constructor(private world: World, private physics: Physics, private stage: Stage, private cameraCtl: CameraController, private ui: UiChannel) {
    world.events.on('removed', obj => this.stop(obj));
  }

  async ensureHelper() {
    const { MMDAnimationHelper } = await import('../../vendor/three-mmd/MMDAnimationHelper.js');
    return this.helper ??= new MMDAnimationHelper();
  }
  get hasMotion() { return !!this.camera || this.world.objects.some(b => b.animated); }
  // 一番長いモーションの長さ (秒)
  get duration() {
    let d = this.camera?.motion.duration ?? 0;
    for (const b of this.world.objects) if (b.motion) d = Math.max(d, b.motion.duration);
    return d;
  }

  // .vmd を読んで、モデルの動きを objs に、カメラの動きをカメラに付ける。何か付いたら true
  async load(vmds: File[], objs: ModelObj[]) {
    const label = vmds.map(f => f.name).join('、');
    this.ui.toast(t('{name} を読み込み中…', { name: label }), 0);
    try {
      const [{ MMDLoader }, helper] = await Promise.all([loadMMDLoader(), this.ensureHelper()]);
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
          this.startCamera(loader.animationBuilder.buildCameraAnimation(vmd));
          this.cameraFile = file;
          used = true;
        }
        // モデルの動き (骨と表情)
        if (vmd.metadata.motionCount + vmd.metadata.morphCount > 0) {
          hasModelMotion = true;
          for (const obj of objs) {
            if (!this.world.has(obj)) continue; // 読み込み中に消された
            const mesh = obj.model;
            const clip = loader.animationBuilder.build(vmd, mesh);
            if (!clip.tracks.length) continue; // 骨や表情の名前が1つも合わない
            if (helper.objects.has(mesh)) helper.remove(mesh);
            mesh.pose(); // 前のモーションの姿勢を元に戻してから付ける
            helper.add(mesh, { animation: clip, physics: false });
            obj.motion = this.info(mesh, clip);
            obj.motionFile = file;
            obj.animated = true;
            used = true;
          }
        }
      }
      if (!used) {
        this.ui.toast(hasModelMotion && !objs.length
          ? t('先に .pmx のモデルを読み込んでください。')
          : t('{name} には、このモデルの骨や表情に合う動きも、カメラの動きもありませんでした', { name: label }), 8000);
        return false;
      }
      this.ui.toast(this.camera ? t('{name} を再生しています。カメラを自分で動かすと、カメラモーションは止まります', { name: label }) : t('{name} を再生しています', { name: label }), 6000);
      return true;
    } catch (err) {
      console.error(err);
      this.ui.toast(t('{name} を読み込めませんでした: {error}', { name: label, error: errorText(err) }), 8000);
      return false;
    }
  }
  // クリップの再生の設定と、タイムラインに印を付けるキーフレームの位置 (フレーム番号)
  private info(target: THREE.Object3D, clip: THREE.AnimationClip): MotionInfo {
    const action = this.helper.objects.get(target).mixer.existingAction(clip);
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    const frames = new Set<number>();
    for (const track of clip.tracks) for (const t of track.times) frames.add(Math.round(t * FPS));
    return { action, duration: clip.duration, frames: Int32Array.from(frames).sort() };
  }

  // すべてのモーションを、時刻 t (秒) の姿勢にする。warmup は、飛んだ先の姿勢に物理演算の剛体をなじませる回数
  seek(t: number, warmup = 30) {
    const { helper } = this;
    if (!helper) return;
    // (helper.objects は WeakMap で中身をたどれないので、再生中のモデルとカメラを自分で並べる)
    const list: [THREE.Object3D, MotionInfo][] = [
      ...this.world.objects.filter(b => b.animated && b.motion).map(b => [b.model, b.motion!] as [THREE.Object3D, MotionInfo]),
      ...(this.camera ? [[this.camera.cam, this.camera.motion] as [THREE.Object3D, MotionInfo]] : []),
    ];
    for (const [target, info] of list) {
      // 最後まで行って止まった動きも、もう一度動くようにしてから時刻を合わせる
      info.action.paused = false;
      info.action.enabled = true;
      helper.objects.get(target)?.mixer?.setTime(Math.min(t, info.duration));
    }
    helper.update(0);
    if (warmup) this.physics.resetAnimated(warmup);
  }
  // 再生で delta 秒進める
  advance(delta: number) {
    if (this.hasMotion) this.helper.update(delta);
  }
  // 止まっているあいだも、毎フレーム姿勢を計算し直す (手で動かしたボーンをモーションに重ねるため)
  active() { return this.hasMotion && !this.isPlaying(); }
  update() { this.helper.update(0); }

  stop(obj: Obj) {
    if (!obj.animated) return;
    this.helper.remove(obj.model);
    obj.animated = false;
    obj.motion = null;
    obj.motionFile = undefined;
  }

  // --- カメラモーション ---
  // MMD のカメラは、モデルが原点に立っている MMD の単位の座標で動く。
  // ステージがあればステージ、なければ置いてある最初のモデルと同じ変換をかけて、このページのカメラに写す
  private startCamera(clip: THREE.AnimationClip) {
    if (this.camera) this.helper.remove(this.camera.cam);
    const cam = new THREE.PerspectiveCamera(DEFAULT_FOV);
    this.helper.add(cam, { animation: clip });
    this.camera = { cam, motion: this.info(cam, clip) };
    const override: CameraOverride = {
      target: this.target,
      apply: camera => this.applyCamera(camera),
      released: () => this.removeCamera(), // 自分でカメラを動かしたら、カメラモーションをやめる
    };
    this.cameraCtl.setOverride(override);
  }
  private stageMatrix() {
    if (this.stage.model) return this.stageMat.copy(this.stage.model.matrixWorld);
    const model = this.world.models[0];
    if (model) {
      model.node.updateMatrixWorld(true);
      return this.stageMat.copy(model.model.matrixWorld);
    }
    // モデルがないときは、原点に身長 20 (MMD のモデルのよくある大きさ) のモデルが立っているとみなす
    return this.stageMat.makeScale(MMD_SCALE, MMD_SCALE, MMD_SCALE);
  }
  private applyCamera(camera: THREE.PerspectiveCamera) {
    const c = this.camera!.cam, m = this.stageMatrix();
    camera.position.copy(c.position).applyMatrix4(m);
    this.target.copy(this.helper.cameraTarget.position).applyMatrix4(m);
    camera.up.copy(this.up.copy(c.up).transformDirection(m));
    camera.lookAt(this.target);
    if (camera.fov !== c.fov) { camera.fov = c.fov; camera.updateProjectionMatrix(); }
    camera.updateMatrixWorld();
  }
  private removeCamera() {
    if (!this.camera) return;
    this.helper.remove(this.camera.cam);
    this.camera = null;
    this.cameraFile = null;
    this.ui.bump('keysVersion');
  }
}
