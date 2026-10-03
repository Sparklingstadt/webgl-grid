import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { MAX_CLONES, MAX_DELAY_FRAMES, clonerLayout, cloneCount, type ClonerSettings } from '../../core/cloner';
import type { Viewport } from '../render/Viewport';
import { isModel, type Any, type Obj } from '../types';
import type { World } from './World';

const GROUP = '__clones';
const noRaycast = () => {};
// MMD モデルの、あるフレームの姿勢 (ディレイのために覚えておく)
interface PoseSnap { pos: Float32Array; quat: Float32Array; morphs: Float32Array | null }

// --- クローナー (Cinema 4D のクローナー) ---
// 物をクローナーにすると、元の物は隠し、その位置と向きを中心に、クローンを直線・放射・グリッドに並べる (core/cloner.ts)。
// クローンは物の three.js のグループ (node) の子なので、元の物を動かす・回すと一緒に動く。
// 形のクローンは同じ形状と材質を使う普通のメッシュ。MMD モデルのクローンは骨ごと複製し、
// 毎フレーム元のモデルの骨と表情を写す (モーション・物理演算・手で動かしたボーンが、そのまま全部のクローンに出る)。
// ディレイのエフェクタがあれば、元のモデルの姿勢をフレームごとに覚えておき、遅れたクローンには前のフレームの姿勢を写す
// (再生していくと覚えるので、飛んだ直後はまだ遅れない)
export class Cloners {
  private history = new WeakMap<Obj, Map<number, PoseSnap>>();

  constructor(private world: World, private viewport: Viewport, private frameNow: () => number) {
    viewport.onBeforeRender(() => this.sync());
  }

  // 物のクローナーの設定を変える (null でやめる)
  set(obj: Obj, settings: ClonerSettings | null) {
    obj.cloner = settings;
    this.rebuild(obj);
    this.viewport.requestDraw();
  }

  // クローンを作り直す
  rebuild(obj: Obj) {
    const old = obj.node.getObjectByName(GROUP);
    if (old) { obj.node.remove(old); disposeClones(old); }
    const src: THREE.Mesh = isModel(obj) ? obj.model : obj.mesh!;
    const proxy = obj.node.children.find(c => c.userData.pickProxy) as THREE.Mesh | undefined;
    // 元の物は隠し、クリックでも当たらないようにする (クローンのどれかを押すと、この物が選ばれる)
    src.visible = !obj.cloner;
    setPickable(isModel(obj) ? proxy : src, !obj.cloner);
    if (!obj.cloner) return;
    const group = new THREE.Group();
    group.name = GROUP;
    for (const p of clonerLayout(obj.cloner, isModel(obj) ? MAX_CLONES.model : MAX_CLONES.shape)) {
      const g = new THREE.Group();
      g.position.set(p.x, p.y, p.z);
      g.rotation.y = p.ry;
      g.scale.setScalar(p.scale);
      g.userData.delay = Math.round(p.delay);
      if (isModel(obj)) {
        const m: Any = cloneSkinned(obj.model);
        m.visible = true;
        // 材質の配列は、クローンごとに別にする (中の材質は同じ)。輪郭線 (OutlineEffect) は描くあいだ配列の中身を入れ替えるので、
        // 同じ配列を共有すると、入れ替えと戻しが食い違う
        if (Array.isArray(m.material)) m.material = [...m.material];
        m.traverse((o: Any) => { if (o.isMesh) { o.raycast = noRaycast; o.castShadow = o.receiveShadow = true; } });
        g.add(m);
        if (proxy) { const pc = proxy.clone(); setPickable(pc, true); g.add(pc); } // 当たり判定は骨で変形しない複製で
      } else {
        const m = new THREE.Mesh(src.geometry, src.material);
        m.castShadow = m.receiveShadow = true;
        g.add(m);
      }
      group.add(g);
    }
    obj.node.add(group);
  }

  private remember(obj: Obj, bones: THREE.Bone[], inf: number[] | undefined) {
    let map = this.history.get(obj);
    if (!map) this.history.set(obj, map = new Map());
    rememberPose(map, this.frameNow(), bones, inf);
    return map;
  }

  // クローンの数 (サイドバーに出す)
  count(obj: Obj) { return obj.cloner ? cloneCount(obj.cloner, isModel(obj) ? MAX_CLONES.model : MAX_CLONES.shape) : 0; }

  // 描く前: 材質 (スロットを替えた・作り直した) と、MMD モデルの骨・表情を元の物に合わせる
  private sync() {
    for (const obj of this.world.objects) {
      if (!obj.cloner) continue;
      const group = obj.node.getObjectByName(GROUP);
      if (!group) continue;
      if (!isModel(obj)) {
        for (const g of group.children) {
          const m = g.children[0] as THREE.Mesh;
          if (m.material !== obj.mesh!.material) m.material = obj.mesh!.material;
        }
        continue;
      }
      const src = obj.model, bones: THREE.Bone[] = src.skeleton.bones, inf: number[] | undefined = src.morphTargetInfluences;
      const delayed = group.children.some(g => g.userData.delay > 0);
      const snaps = delayed ? this.remember(obj, bones, inf) : null;
      const frame = this.frameNow();
      for (const g of group.children) {
        const m = g.children[0] as Any;
        syncMaterials(m, src);
        const cb: THREE.Bone[] = m.skeleton.bones;
        const snap = snaps && g.userData.delay > 0 ? nearest(snaps, frame - g.userData.delay) : null;
        if (snap) {
          for (let i = 0; i < bones.length; i++) {
            cb[i].position.fromArray(snap.pos, i * 3);
            cb[i].quaternion.fromArray(snap.quat, i * 4);
          }
          if (snap.morphs && m.morphTargetInfluences) for (let k = 0; k < snap.morphs.length; k++) m.morphTargetInfluences[k] = snap.morphs[k];
          continue;
        }
        for (let i = 0; i < bones.length; i++) {
          cb[i].position.copy(bones[i].position);
          cb[i].quaternion.copy(bones[i].quaternion);
          cb[i].scale.copy(bones[i].scale);
        }
        if (inf && m.morphTargetInfluences) for (let k = 0; k < inf.length; k++) m.morphTargetInfluences[k] = inf[k];
      }
    }
  }
}

// いまのフレームの元のモデルの姿勢を覚え、遅れの範囲より前のものは捨てる
function rememberPose(map: Map<number, PoseSnap>, frame: number, bones: THREE.Bone[], inf: number[] | undefined) {
  let snap = map.get(frame);
  if (!snap) map.set(frame, snap = { pos: new Float32Array(bones.length * 3), quat: new Float32Array(bones.length * 4), morphs: inf ? new Float32Array(inf.length) : null });
  bones.forEach((b, i) => { b.position.toArray(snap.pos, i * 3); b.quaternion.toArray(snap.quat, i * 4); });
  if (inf && snap.morphs) snap.morphs.set(inf);
  for (const f of map.keys()) if (f > frame || f < frame - MAX_DELAY_FRAMES) map.delete(f); // (戻ったときは、先のフレームは捨てる)
}
// フレーム f にいちばん近い、覚えている姿勢
function nearest(map: Map<number, PoseSnap>, f: number): PoseSnap | null {
  let best: PoseSnap | null = null, bd = Infinity;
  for (const [k, s] of map) { const d = Math.abs(k - f); if (d < bd) { bd = d; best = s; } }
  return best;
}

// クローンの材質を元のモデルに合わせる (配列は別のまま、中身だけ)
function syncMaterials(m: Any, src: Any) {
  if (!Array.isArray(src.material)) { if (m.material !== src.material) m.material = src.material; return; }
  if (!Array.isArray(m.material) || m.material === src.material || m.material.length !== src.material.length) { m.material = [...src.material]; return; }
  for (let i = 0; i < src.material.length; i++) if (m.material[i] !== src.material[i]) m.material[i] = src.material[i];
}

// 当たり判定のオン・オフ (オフのあいだは、元の raycast を覚えておく)
function setPickable(o: THREE.Object3D | undefined, on: boolean) {
  if (!o) return;
  if (on) {
    if (o.userData.raycast) { o.raycast = o.userData.raycast; delete o.userData.raycast; }
  } else if (!o.userData.raycast) {
    o.userData.raycast = o.raycast;
    o.raycast = noRaycast;
  }
}
// クローンを片付ける (形状と材質は元の物のものなので捨てない。骨の情報だけ)
function disposeClones(group: THREE.Object3D) {
  group.traverse(o => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) (o as THREE.SkinnedMesh).skeleton.dispose(); });
}
