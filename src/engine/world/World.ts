import * as THREE from 'three';
import { Emitter } from '../../core/events';
import { MAX_BOXES, MMD_SCALE, PALETTE } from '../../core/constants';
import { freeSpot, radiusOf, settleHeights, stackFrom } from '../../core/stacking';
import { surfaceShader } from '../../core/materials/tree';
import type { MaterialLibrary } from '../materials/MaterialLibrary';
import type { SceneGraph } from '../render/SceneGraph';
import type { System, Viewport } from '../render/Viewport';
import type { Any, ModelObj, Obj } from '../types';
import type { UiChannel } from '../UiChannel';

const SHAPE_GEOMETRY = [
  new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
  // 寝かせたトーラス: 中心円の半径 0.35、管の半径 0.15 (高さ 0.3)
  new THREE.TorusGeometry(0.35, 0.15, 24, 64).rotateX(Math.PI / 2).translate(0, 0.15, 0),
  // 三角錐: 底面は外接円の半径 0.5 の正三角形、高さ 0.8
  new THREE.ConeGeometry(0.5, 0.8, 3, 1).translate(0, 0.4, 0),
];
const SHAPE_HEIGHT = [1, 0.3, 0.8];
// 落下アニメーション: 表示上の高さ py を、重力で y まで落とす (着地で少し跳ねる)。
// 上がるときは y より少し高くまで跳び上がってから、同じ重力で着地する
const GRAVITY = 40;
const HOP = 0.25; // 跳び乗るときに y より上へ跳ぶ高さ

type WorldEvents = { added: [obj: Obj]; removed: [obj: Obj] };

// --- 置いた物 (形と PMX モデル) の一覧・作成・削除・積み重ね・落下 ---
export class World implements System {
  readonly objects: Obj[] = [];
  readonly events = new Emitter<WorldEvents>();
  private nextId = 1;
  // 消した物の形状を、すぐには捨てない (元に戻せるように History が持っておき、要らなくなったら dispose を呼ぶ)
  keepRemoved = false;

  constructor(private graph: SceneGraph, private viewport: Viewport, private ui: UiChannel, private lib: MaterialLibrary) {}

  has(obj: Obj) { return this.objects.includes(obj); }
  find(id: number | null) { return this.objects.find(o => o.id === id) ?? null; }
  get models() { return this.objects.filter((o): o is ModelObj => o.s === 3); }
  get full() { return this.objects.length >= MAX_BOXES; }

  private add(base: Omit<Obj, 'node' | 'id'>, object3d: THREE.Object3D): Obj {
    const node = new THREE.Group();
    node.add(object3d);
    object3d.traverse(o => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.graph.scene.add(node);
    const obj = { ...base, node, id: this.nextId++ } as Obj;
    node.userData.obj = obj;
    this.objects.push(obj);
    this.publishCanAdd();
    this.events.emit('added', obj);
    return obj;
  }
  // 形 s (0: 立方体, 1: トーラス, 2: 三角錐) を (x, z) に置く。色 c を省くと、使われていない色。
  // 形ごとに、その色のマテリアルを 1 つ作ってスロットに入れる
  addShape(s: number, x: number, z: number, c = this.nextColor()): Obj {
    const mat = this.lib.create('マテリアル', { auto: true });
    surfaceShader(mat.tree)!.values.baseColor = [...PALETTE[c]];
    const material = this.lib.instance(mat.id);
    material.flatShading = s === 2;
    const mesh = new THREE.Mesh(SHAPE_GEOMETRY[s], material);
    return this.add({ x, y: 0, z, c, s, r: 0, py: 0, vy: 0, h: SHAPE_HEIGHT[s], hx: 0.5, hz: 0.5, mesh, slots: [mat.id] }, mesh);
  }
  // 形の色を、パレットの色 c にする (スロットのマテリアルのベースカラー。ほかの物と共有していれば、そちらも変わる)
  setShapeColor(obj: Obj, c: number) {
    obj.c = c;
    const id = obj.slots[0];
    if (!id) return;
    this.lib.edit(id, data => {
      const bsdf = surfaceShader(data.tree);
      if (bsdf) bsdf.values.baseColor = [...PALETTE[c]];
    });
  }
  // スロット i のマテリアルを替える (null ならマテリアルなし)
  setSlot(obj: Obj, i: number, id: string | null) {
    const target: THREE.Mesh = obj.s === 3 ? obj.model : obj.mesh!;
    const list = [target.material].flat();
    if (i < 0 || i >= list.length) return;
    this.lib.release(list[i]);
    const m = this.lib.instance(id);
    if (obj.s === 2) m.flatShading = true;
    list[i] = m;
    target.material = Array.isArray(target.material) ? list : list[0];
    obj.slots[i] = id;
    this.viewport.requestDraw();
  }
  // MMD モデル (材質はマテリアルに変換したもの。slots はそのマテリアル) を、(cx, cz) に近い空いている場所に置く
  addModel(mesh: Any, cx: number, cz: number, slots: string[]): ModelObj {
    // MMD_SCALE 倍にして、足元の中心が置き場所に来るようにずらす
    const bbox = new THREE.Box3().setFromObject(mesh);
    const size = bbox.getSize(new THREE.Vector3()), center = bbox.getCenter(new THREE.Vector3());
    const k = MMD_SCALE;
    mesh.scale.setScalar(k);
    mesh.position.set(-center.x * k, -bbox.min.y * k, -center.z * k);
    const base = { x: 0, y: 0, z: 0, c: -1, s: 3, r: 0, py: 0, vy: 0,
                   h: size.y * k, hx: Math.max(size.x * k / 2, 0.05), hz: Math.max(size.z * k / 2, 0.05) };
    [base.x, base.z] = this.findFreeSpot(radiusOf(base), cx, cz);
    const obj = this.add({ ...base, model: mesh, slots }, mesh) as ModelObj;
    // 当たり判定用の複製。置いたモデルはポーズを変えないので、骨やモーフの計算をしない普通のメッシュで判定する
    // (骨で変形するメッシュのまま判定すると、頂点ごとに骨を計算するので 9 万ポリゴンで 1 回 50ms ほどかかる)
    const proxy: Any = new THREE.Mesh(mesh.geometry, new THREE.MeshBasicMaterial());
    proxy.morphTargetInfluences = undefined;
    proxy.position.copy(mesh.position);
    proxy.scale.copy(mesh.scale);
    proxy.visible = false;
    proxy.castShadow = false;
    proxy.userData.pickProxy = true;
    obj.node.add(proxy);
    mesh.traverse((o: Any) => { if (o.isMesh) o.raycast = () => {}; });
    this.dropIn(obj);
    return obj;
  }
  remove(obj: Obj) {
    if (!this.has(obj)) return;
    this.graph.scene.remove(obj.node);
    this.objects.splice(this.objects.indexOf(obj), 1);
    this.events.emit('removed', obj); // 物理演算・モーション・選択などが後片付けする
    this.lib.releaseAll(obj.node);
    if (!this.keepRemoved) this.dispose(obj);
    this.settle();
    this.publishCanAdd();
    this.viewport.requestDraw();
  }
  // 消した物の形状を片付ける
  dispose(obj: Obj) { if (obj.s === 3) disposeModel(obj.node); }
  // 消した物を、objects の index 番目に置き直す (元に戻すとき)。材質はスロットのマテリアルから作り直す
  restore(obj: Obj, index: number) {
    if (this.has(obj)) return;
    this.graph.scene.add(obj.node);
    this.objects.splice(Math.min(Math.max(index, 0), this.objects.length), 0, obj);
    const target: THREE.Mesh = obj.s === 3 ? obj.model : obj.mesh!;
    const list = obj.slots.map(id => {
      const m = this.lib.instance(id);
      if (obj.s === 2) m.flatShading = true;
      return m;
    });
    target.material = Array.isArray(target.material) ? list : list[0];
    this.publishCanAdd();
    this.events.emit('added', obj);
    this.viewport.requestDraw();
  }
  // objects を ids の順に並べ替える (積み重ねは並び順に下から決まる)
  reorder(ids: number[]) {
    const rank = new Map(ids.map((id, i) => [id, i]));
    this.objects.sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
  }
  clear() {
    while (this.objects.length) this.remove(this.objects[0]);
  }
  private publishCanAdd() { this.ui.set({ canAdd: !this.full }); }

  // まだ使われていない色を優先し、全色使用中なら一番使われていない色を選ぶ
  nextColor() {
    const used = PALETTE.map((_, i) => this.objects.filter(b => b.c === i).length);
    return used.indexOf(Math.min(...used));
  }
  // (cx, cz) に近い、ほかの物と重ならないマス目 (半径 rad の物を置く)
  findFreeSpot(rad: number, cx: number, cz: number) { return freeSpot(this.objects, rad, Math.round(cx), Math.round(cz)); }

  // --- 積み重ね ---
  stackFrom(b: Obj) { return stackFrom(this.objects, b); }
  // 重力: 下にあるものから順に、足場の一番高い所まで落とす (exclude は動かさない)
  settle(exclude: Obj[] = []) {
    settleHeights(this.objects, exclude);
    this.startFall();
  }
  // 置いた物を、少し上から落として着地させる
  dropIn(b: Obj) {
    this.settle();
    b.py = b.y + 1.5;
    b.vy = 0;
    this.startFall();
  }
  startFall() {
    for (const b of this.objects) {
      if (b.py >= b.y) continue;
      const v0 = Math.sqrt(2 * GRAVITY * (b.y - b.py + HOP));
      if (b.vy > -v0) b.vy = -v0; // vy は下向きが正
    }
    // 描画できないとき (テストなど) は、すぐに着地させる
    if (!this.viewport.mounted) for (const b of this.objects) { b.py = b.y; b.vy = 0; }
    this.viewport.startTicking();
  }
  // 落下中の物があるあいだ動く
  active() { return this.objects.some(b => b.py !== b.y || b.vy !== 0); }
  update(dt: number) {
    dt = Math.min(dt, 1 / 30);
    for (const b of this.objects) {
      if (b.py === b.y && b.vy === 0) continue;
      b.vy += GRAVITY * dt;
      b.py -= b.vy * dt;
      if (b.vy > 0 && b.py <= b.y) {
        b.py = b.y;
        b.vy = b.vy > 3 ? -b.vy * 0.25 : 0; // 速ければ小さく跳ね返る
      }
    }
  }

  // 描く前: 位置・向き・色を three.js のオブジェクトに写す
  sync() {
    for (const b of this.objects) {
      b.node.position.set(b.x, b.py, b.z);
      b.node.rotation.y = b.r;
    }
  }
  // 掴んでいる物 (とパレットで色を変えている形) を明るくする
  setHighlight(obj: Obj, on: boolean) {
    if (!!obj.highlighted === on) return;
    obj.highlighted = on;
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
}

// MMD モデルの形状を片付ける (材質は MaterialLibrary に返す。テクスチャはマテリアルの画像として残る)
export function disposeModel(root: THREE.Object3D) {
  root.traverse(o => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) mesh.geometry.dispose();
  });
}
