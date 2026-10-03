import * as THREE from 'three';
import { errorText } from '../../core/errors';
import { findHairWeights } from '../../core/hairWeights';
import { t } from '../../core/i18n';
import type { System, Viewport } from '../render/Viewport';
import type { Any, ModelObj, Obj } from '../types';
import type { UiChannel } from '../UiChannel';
import type { World } from '../world/World';

// 物理エンジン Ammo.js (WebAssembly 版) は大きいので、剛体を持つモデルを初めて読んだときに取りに行く。
// アプリと同じ場所 (public/libs/) から配る (ページからの相対パス)
const AMMO_URL = 'libs/ammo.wasm.js';
let ammoReady: Promise<Any> | null = null;
function loadAmmo() {
  ammoReady ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = AMMO_URL;
    const w = window as Any;
    script.onload = () => w.Ammo().then((lib: Any) => { w.Ammo = lib; resolve(lib); }, reject);
    script.onerror = () => reject(new Error(t('Ammo.js を読み込めませんでした')));
    document.head.append(script);
  });
  return ammoReady;
}

interface Entry {
  obj: Obj; physics: Any; scale: number;
  prev: THREE.Vector3 | null; vel: THREE.Vector3; acc: THREE.Vector3;
  gravity: Any; force: Any; zero: Any; axisX: number; axisZ: number;
  prevR: number | null; w: number; alpha: number; dynamic: Any[];
  hair: { bodies: Any[]; constraints: Any[] } | null; // 髪の形を保つ錘と、それにつながる関節 (なければ null)
  hang: boolean;                                       // 錘を外して、髪を重力で垂らしている
}
const MMD_GRAVITY = 9.8 * 10; // MMD の重力 (モデルの単位で)
const INERTIA = 0.3;          // 運ぶ・落ちるときの揺れの強さ
const ROT_INERTIA = 0.5;      // 回すときの揺れの強さ
const _p = new THREE.Vector3(), _v = new THREE.Vector3(), _a = new THREE.Vector3();

// MMDPhysics は、剛体を「拡大縮小していないモデル自身の座標」(親から外し、大きさ 1) で扱う。
// update() は拡大縮小されたモデルを自分でそう直すが、直したあとの行列を戻さないので、描画を挟まずに続けて呼ぶ
// (warmup) と 2 回目から座標がずれる。作るとき (コンストラクタ) と reset() は直しもしない。
// そこで MMDPhysics を呼ぶときは必ず、その間だけモデルをこの状態にする (ボーンの位置もその座標で計算し直す)
function inModelFrame<T>(obj: Obj, fn: () => T): T {
  const mesh = obj.model, parent = mesh.parent, scale = mesh.scale.clone();
  mesh.parent = null;
  mesh.scale.set(1, 1, 1);
  mesh.updateMatrixWorld(true);
  try {
    return fn();
  } finally {
    mesh.parent = parent;
    mesh.scale.copy(scale);
    obj.node.updateMatrixWorld(true);
  }
}
// 髪の形を保つ錘と、それにつながる関節を探す (core/hairWeights.ts)
function findHairRig(mesh: Any, physics: Any): Entry['hair'] {
  const bones: THREE.Bone[] = mesh.skeleton.bones;
  // 頭のボーン (MMD の標準の名前「頭」) か、その子孫か
  const isHeadBone = (i: number) => {
    for (let b: THREE.Object3D | null = bones[i] ?? null; b && (b as THREE.Bone).isBone; b = b.parent) if (b.name === '頭') return true;
    return false;
  };
  const isLocked = (c: Any) => [c.translationLimitation1, c.translationLimitation2, c.rotationLimitation1, c.rotationLimitation2]
    .every((v: ArrayLike<number>) => Array.from(v).every(x => x === 0));
  const index = new Map<Any, number>(physics.bodies.map((b: Any, i: number) => [b, i]));
  const found = findHairWeights(
    physics.bodies.map((b: Any) => ({ type: b.params.type, groupTarget: b.params.groupTarget, boneIndex: b.params.boneIndex })),
    physics.constraints.map((c: Any) => ({ a: index.get(c.bodyA)!, b: index.get(c.bodyB)!, locked: isLocked(c.params) })),
    isHeadBone);
  if (!found.length) return null;
  const bodies = found.map(i => physics.bodies[i]);
  const set = new Set(bodies);
  return { bodies, constraints: physics.constraints.filter((c: Any) => set.has(c.bodyA) || set.has(c.bodyB)) };
}
// 物理演算を cycles 回 (1/60 秒ずつ) 進めて、いまの姿勢になじませる
function warmup(obj: Obj, physics: Any, cycles: number) {
  inModelFrame(obj, () => { for (let i = 0; i < cycles; i++) physics.update(1 / 60); });
}

// --- MMD の物理演算 (髪やスカートの揺れ) ---
// MMDPhysics はモデル自身の座標で計算するので、置き場所の加速度を「見かけの重力」として足し、
// 縦軸まわりに回したときは剛体ごとにオイラー力・遠心力・コリオリ力をかける
export class Physics implements System {
  readonly entries: Entry[] = [];

  constructor(private world: World, private viewport: Viewport, private ui: UiChannel) {
    world.events.on('removed', obj => this.stop(obj));
  }

  async start(obj: ModelObj) {
    const mesh = obj.model;
    const mmd = mesh.geometry.userData.MMD;
    if (!mmd?.rigidBodies?.length) return; // 剛体のないモデルは動かさない
    try {
      const Ammo = await loadAmmo();
      const { MMDPhysics } = await import('../../vendor/three-mmd/MMDPhysics.js');
      if (!this.world.has(obj)) return; // 読み込み中に消された
      const physics = inModelFrame(obj, () => new MMDPhysics(mesh, mmd.rigidBodies, mmd.constraints));
      warmup(obj, physics, 60); // 最初の姿勢になじませる
      // 物理演算の座標 (拡大縮小を外したモデル自身の座標) での、置き場所の回転軸 (縦軸) の位置。
      // メッシュは置き場所から mesh.position だけずらして k 倍しているので、置き場所の原点はここに来る
      const k = mesh.scale.x;
      this.entries.push({
        obj, physics, scale: 1 / k,
        prev: null, vel: new THREE.Vector3(), acc: new THREE.Vector3(),
        gravity: new Ammo.btVector3(0, -MMD_GRAVITY, 0), // 毎フレーム作り直すと Ammo のメモリが増え続けるので使い回す
        force: new Ammo.btVector3(0, 0, 0),
        zero: new Ammo.btVector3(0, 0, 0),
        axisX: mesh.position.x * (1 - 1 / k), axisZ: mesh.position.z * (1 - 1 / k),
        prevR: null, w: 0, alpha: 0,
        dynamic: physics.bodies.filter((b: Any) => b.params.type !== 0), // 骨に付いていくだけの剛体は除く
        hair: findHairRig(mesh, physics),
        hang: false,
      });
      this.viewport.startTicking();
    } catch (err) {
      console.error(err);
      this.ui.toast(t('物理演算を開始できませんでした: {error}', { error: errorText(err) }), 8000);
    }
  }
  // 髪を重力で垂らしているか。髪の形を保つ錘がない (か物理演算がない) モデルは null
  hairHang(obj: Obj): boolean | null {
    const p = this.entries.find(p => p.obj === obj);
    return p?.hair ? p.hang : null;
  }
  // 髪の錘を外して、髪を重力で垂らす (on) / 錘を戻して、モデルの作者が作った髪の形にする (off)
  setHairHang(obj: Obj, on: boolean) {
    const p = this.entries.find(p => p.obj === obj);
    if (!p?.hair || p.hang === on) return;
    p.hang = on;
    const { world } = p.physics, { bodies, constraints } = p.hair;
    if (on) {
      // 外した錘は動かなくなるが、錘のボーンは見た目に関わらないので構わない
      for (const c of constraints) world.removeConstraint(c.constraint);
      for (const b of bodies) world.removeRigidBody(b.body);
    } else {
      // 錘のボーンを最初の姿勢 (髪の節からの位置) に戻してから、錘と関節を戻し、全体を置き直す
      const rest = obj.model.userData.rest, bones = obj.model.skeleton.bones;
      for (const b of bodies) {
        const i = bones.indexOf(b.bone);
        if (i >= 0) { b.bone.position.copy(rest[i].p); b.bone.quaternion.copy(rest[i].q); }
        world.addRigidBody(b.body, 1 << b.params.groupIndex, b.params.groupTarget);
      }
      for (const c of constraints) world.addConstraint(c.constraint, true);
      this.reset(p);
      warmup(p.obj, p.physics, 60);
    }
    this.viewport.startTicking();
  }
  stop(obj: Obj) {
    const i = this.entries.findIndex(p => p.obj === obj);
    if (i >= 0) this.entries.splice(i, 1); // Ammo 側の後片付けの API はないので、参照を外すだけ
  }
  // 物理演算で動く骨 (手で動かすときは、これを最初の姿勢に戻さない)
  dynamicBones(obj: Obj): Set<THREE.Bone> {
    return new Set(this.entries.find(p => p.obj === obj)?.dynamic.map(b => b.bone));
  }
  // 飛んだ先の姿勢 (モーションの途中など) に、モーションのあるモデルの剛体をなじませる
  resetAnimated(cycles: number) {
    for (const p of this.entries) {
      if (!p.obj.animated) continue;
      this.reset(p);
      warmup(p.obj, p.physics, cycles);
    }
  }
  // 剛体を、いまのボーンの位置に置き直して止める。
  // MMDPhysics.reset() は、ボーンの位置をそのまま (拡大縮小・置き場所込みの座標で) 使い、速さも消さないので、
  // そのまま呼ぶと剛体が遠くへ飛ばされ、関節に引き戻されるときに髪とスカートが絡まる
  private reset(p: Entry) {
    inModelFrame(p.obj, () => p.physics.reset());
    for (const rb of p.physics.bodies) {
      rb.body.setLinearVelocity(p.zero);
      rb.body.setAngularVelocity(p.zero);
      rb.body.clearForces();
    }
    // 見かけの重力・回転の力の計算も、ここから測り直す
    p.prev = null;
    p.vel.set(0, 0, 0);
    p.acc.set(0, 0, 0);
    p.prevR = null;
    p.w = p.alpha = 0;
  }

  active() { return this.entries.length > 0; }
  update(dt: number) {
    for (const p of this.entries) {
      // モデルの動きの加速度を「見かけの重力」として足す (運ぶと髪がなびき、落ちると浮く)
      const o = p.obj;
      _p.set(o.x, o.py, o.z);
      if (p.prev && dt > 0) {
        _v.subVectors(_p, p.prev).divideScalar(dt);
        _a.subVectors(_v, p.vel).divideScalar(dt);
        p.vel.copy(_v);
        p.acc.lerp(_a, 0.25); // 急な変化はならす
      }
      p.prev = (p.prev ?? new THREE.Vector3()).copy(_p);
      // ワールドの加速度を、モデルの向き・単位に直す
      const a = _a.copy(p.acc).applyAxisAngle(THREE.Object3D.DEFAULT_UP, -o.r).multiplyScalar(p.scale * INERTIA);
      a.clampLength(0, MMD_GRAVITY * 2);
      p.gravity.setValue(-a.x, -MMD_GRAVITY - a.y, -a.z);
      p.physics.world.setGravity(p.gravity);
      this.applyRotationForces(p, dt);
      inModelFrame(o, () => p.physics.update(dt));
    }
  }
  // 縦軸まわりに回したときの揺れ。回転は剛体ごとに軸からの位置で力が変わるので、見かけの重力ではなく
  // 剛体 1 つずつに見かけの力をかける (Ammo は 1 回の計算のあとに力を消すので、毎フレームかけ直す)
  //   オイラー力 (回し始め・止めるときに取り残される) -α×r、遠心力 ω²r、コリオリ力 -2ω×v
  private applyRotationForces(p: Entry, dt: number) {
    const r = p.obj.r;
    if (p.prevR !== null && dt > 0) {
      const w = (r - p.prevR) / dt;
      p.alpha += ((w - p.w) / dt - p.alpha) * 0.25; // 急な変化はならす
      p.w = w;
    }
    p.prevR = r;
    const w = p.w, alpha = p.alpha;
    if (Math.abs(w) < 1e-3 && Math.abs(alpha) < 1e-2) return;
    const limit = MMD_GRAVITY * 2;
    for (const rb of p.dynamic) {
      const body = rb.body;
      const o = body.getCenterOfMassTransform().getOrigin();
      const x = o.x() - p.axisX, z = o.z() - p.axisZ;
      const v = body.getLinearVelocity();
      let ax = (w * w * x - alpha * z - 2 * w * v.z()) * ROT_INERTIA;
      let az = (w * w * z + alpha * x + 2 * w * v.x()) * ROT_INERTIA;
      const len = Math.hypot(ax, az);
      if (len > limit) { ax *= limit / len; az *= limit / len; }
      const m = rb.params.weight;
      p.force.setValue(ax * m, 0, az * m);
      body.activate(); // 止まって眠っている剛体も起こす
      body.applyCentralForce(p.force);
    }
  }
}
