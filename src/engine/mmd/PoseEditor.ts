import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { DEG } from '../../core/constants';
import { t } from '../../core/i18n';
import type { BoneValue } from '../../core/types';
import type { SceneGraph } from '../render/SceneGraph';
import type { Viewport } from '../render/Viewport';
import type { ModelObj } from '../types';
import type { UiChannel } from '../UiChannel';
import type { Selection } from '../world/Selection';
import type { Physics } from './Physics';
import { BONE_MOVE, BONE_ROTATE, type Posing } from './Posing';

// --- ポーズモード (Blender のポーズモード): MMD モデルのボーンを、ビューポートで選んで回す・動かす ---
// 関節を点、親子を線でモデルに重ねて出し (IK はオレンジ・移動できるボーンは緑・回すだけは青・選んでいるボーンは白)、
// 関節を押すとボーンを選ぶ。ギズモ (three.js の TransformControls) で回す (FK)・動かす (IK のターゲット・センターなど)。
// 動かした値は、サイドバーのボーンと同じ「手で動かした値」(Posing) になる (元に戻す・キーフレームもそのまま)
export type PoseTool = 'rotate' | 'translate';
const COLORS = { ik: 0xff9a3c, move: 0x5fd35f, rotate: 0x5aa0ff, selected: 0xffffff, line: 0x9aa0a6 };
const BONE_VISIBLE = 0x08, BONE_OPERABLE = 0x10;
const PICK_PX = 14; // 関節を押したとみなす距離 (画面のピクセル)

const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _s = new THREE.Vector3(), _e = new THREE.Euler();

interface Overlay { group: THREE.Group; joints: THREE.Mesh[]; bones: number[]; lines: THREE.LineSegments; parents: number[]; kind: ('ik' | 'move' | 'rotate')[] }

export class PoseEditor {
  active = false;
  tool: PoseTool = 'rotate';
  private model: ModelObj | null = null;
  private overlay: Overlay | null = null;
  private controls: TransformControls | null = null;
  private proxy = new THREE.Object3D();
  private dragging = false;
  private canvas: HTMLCanvasElement | null = null;
  private offSync: (() => void) | null = null;

  constructor(private graph: SceneGraph, private viewport: Viewport, private selection: Selection, private posing: Posing, private physics: Physics, private ui: UiChannel) {
    this.proxy.name = '__pose_proxy';
    graph.scene.add(this.proxy);
    selection.events.on('changed', () => { if (this.active && this.selection.model !== this.model) this.setActive(!!this.selection.model); });
  }

  // 描画先ができたとき・片付けるとき (ギズモは canvas のポインターを使う。ほかの操作より先に受け取るよう、先に作る)
  mount(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    // ほかのボーンの関節を押したら、ギズモより先にそのボーンを選ぶ (ギズモの輪の中にある関節も選べるように)
    canvas.addEventListener('pointerdown', this.onPointerDown, { capture: true });
    // 関節は、物の位置を決めたあと (エンジンの描く前の処理のあと) に合わせる
    this.offSync ??= this.viewport.onBeforeRender(() => this.sync());
    const c = this.controls = new TransformControls(this.graph.camera, canvas);
    c.setSpace('local');
    c.setSize(0.8);
    const helper = c.getHelper();
    helper.userData.editorOnly = true;
    helper.traverse(o => { o.userData.editorOnly = true; });
    this.graph.scene.add(helper);
    c.addEventListener('dragging-changed', e => { this.dragging = !!(e as unknown as { value: boolean }).value; });
    c.addEventListener('objectChange', () => this.fromGizmo());
    c.addEventListener('change', () => this.viewport.requestDraw());
    this.attach();
  }
  unmount() {
    this.canvas?.removeEventListener('pointerdown', this.onPointerDown, { capture: true });
    if (this.controls) { this.graph.scene.remove(this.controls.getHelper()); this.controls.detach(); this.controls.dispose(); }
    this.controls = null;
    this.canvas = null;
  }
  // ギズモの取っ手にマウスが乗っている・掴んでいる (そのあいだは、カメラを動かさない)
  get busy() { return this.active && !!this.controls && (this.controls.axis !== null || this.dragging); }

  // ポーズモードにする・やめる (選んでいる MMD モデルで)
  setActive(on: boolean) {
    const m = on ? this.selection.model : null;
    if (on && !m) { this.ui.toast(t('ポーズモードは、MMD モデルを選んでから使います')); return; }
    this.active = !!m;
    if (this.model !== m) { this.removeOverlay(); this.model = m; }
    if (m && !this.overlay) this.overlay = this.buildOverlay(m);
    this.attach();
    this.ui.set({ poseMode: this.active, poseTool: this.tool });
    this.viewport.requestDraw();
  }
  setTool(tool: PoseTool) {
    this.tool = tool;
    this.ui.set({ poseTool: tool });
    this.attach();
  }

  // 画面の位置 (client) にいちばん近い関節のボーン (PICK_PX 以内)
  pickBone(x: number, y: number): number | null {
    const o = this.overlay, canvas = this.canvas;
    if (!this.active || !o || !canvas) return null;
    const r = canvas.getBoundingClientRect(), cam = this.graph.camera;
    let best: number | null = null, bd = PICK_PX;
    o.joints.forEach((j, k) => {
      _p.setFromMatrixPosition(j.matrixWorld).project(cam);
      if (_p.z > 1) return;
      const sx = r.left + (_p.x + 1) / 2 * r.width, sy = r.top + (1 - _p.y) / 2 * r.height;
      const d = Math.hypot(sx - x, sy - y);
      if (d < bd) { bd = d; best = o.bones[k]; }
    });
    return best;
  }
  private onPointerDown = (e: PointerEvent) => {
    if (!this.active || !this.model || e.button !== 0) return;
    const b = this.pickBone(e.clientX, e.clientY);
    if (b === null || b === this.posing.boneSel(this.model)) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    this.selectBone(b);
  };
  selectBone(i: number) {
    if (!this.model) return;
    this.posing.setBoneSel(this.model, i);
    this.attach();
    this.viewport.requestDraw();
  }

  // 選んでいるボーンの回転 (R)・移動 (G) を、最初の姿勢に戻す
  resetSelected(what: 'rotate' | 'translate') {
    const m = this.model, i = m ? this.posing.boneSel(m) : undefined;
    if (!m || i === undefined) return;
    const v = this.posing.boneValue(m, i);
    this.posing.setBoneValue(m, i, what === 'rotate' ? { ...v, rx: 0, ry: 0, rz: 0 } : { ...v, px: 0, py: 0, pz: 0 });
  }

  // --- 中身 ---
  private flagsOf(m: ModelObj, i: number) { return this.posing.boneFlags(m, i); }
  private kindOf(m: ModelObj, i: number): 'ik' | 'move' | 'rotate' {
    const iks: { target: number }[] = m.model.geometry.userData.MMD?.iks ?? [];
    if (iks.some(ik => ik.target === i)) return 'ik';
    return this.flagsOf(m, i) & BONE_MOVE ? 'move' : 'rotate';
  }

  private buildOverlay(m: ModelObj): Overlay {
    const bones: THREE.Bone[] = m.model.skeleton.bones;
    const flags: number[] = m.model.userData.boneFlags ?? [];
    // (物理演算で動くボーン (髪・スカートなど) は、手で動かしても物理に戻されるので出さない)
    const physical = this.physics.dynamicBones(m);
    const shown = bones.map((_, i) => i).filter(i => (flags[i] & BONE_VISIBLE) && (flags[i] & BONE_OPERABLE) && (flags[i] & (BONE_ROTATE | BONE_MOVE)) && !physical.has(bones[i]));
    const set = new Set(shown);
    // 線を引く親 (表示しているボーンのうち、いちばん近い先祖)
    const parents = shown.map(i => {
      for (let b = bones[i].parent; b; b = b.parent) { const k = bones.indexOf(b as THREE.Bone); if (set.has(k)) return k; }
      return -1;
    });
    const box = new THREE.Box3().setFromObject(m.model);
    const size = Math.max(box.max.y - box.min.y, 0.5) * 0.011;
    const geo = new THREE.SphereGeometry(size, 10, 6), ikGeo = new THREE.OctahedronGeometry(size * 2);
    const group = new THREE.Group();
    group.name = '__pose_overlay';
    group.userData.editorOnly = true;
    const kind = shown.map(i => this.kindOf(m, i));
    const joints = shown.map((_, k) => {
      // IK は大きなひし形で、ほかの関節の上に
      const mesh = new THREE.Mesh(kind[k] === 'ik' ? ikGeo : geo, new THREE.MeshBasicMaterial({ color: COLORS[kind[k]], depthTest: false, transparent: true, opacity: 0.9 }));
      mesh.renderOrder = kind[k] === 'ik' ? 21 : 20;
      mesh.raycast = () => {};
      group.add(mesh);
      return mesh;
    });
    const lines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: COLORS.line, depthTest: false, transparent: true, opacity: 0.7 }));
    lines.renderOrder = 19;
    lines.raycast = () => {};
    group.add(lines);
    group.traverse(o => { o.userData.editorOnly = true; });
    this.graph.scene.add(group);
    return { group, joints, bones: shown, lines, parents: parents.map(p => shown.indexOf(p)), kind };
  }
  private removeOverlay() {
    const o = this.overlay;
    if (!o) return;
    this.graph.scene.remove(o.group);
    o.group.traverse(c => { (c as THREE.Mesh).geometry?.dispose(); ((c as THREE.Mesh).material as THREE.Material | undefined)?.dispose(); });
    this.overlay = null;
  }

  // ギズモを、選んでいるボーンに付ける (回せない・動かせないボーンや、ポーズモードでないときは外す)
  private attach() {
    const c = this.controls, m = this.model;
    if (!c) return;
    const i = this.active && m ? this.posing.boneSel(m) : undefined;
    if (i === undefined || !m) { c.detach(); return; }
    const f = this.flagsOf(m, i);
    const mode = this.tool === 'translate' && f & BONE_MOVE ? 'translate' : f & BONE_ROTATE ? 'rotate' : f & BONE_MOVE ? 'translate' : null;
    if (!mode) { c.detach(); return; }
    c.setMode(mode);
    this.placeProxy(m, i);
    if (c.object !== this.proxy) c.attach(this.proxy);
  }
  // 掴んでいる物 (proxy) を、ボーンの場面での位置と向きに
  private placeProxy(m: ModelObj, i: number) {
    const b: THREE.Bone = m.model.skeleton.bones[i];
    b.updateWorldMatrix(true, false);
    b.matrixWorld.decompose(this.proxy.position, this.proxy.quaternion, _s);
    this.proxy.updateMatrixWorld();
  }

  // ギズモで動かした → ボーンの「手で動かした値」に直す (Posing は 最初の向き × 回転 (YXZ の度)、最初の位置 + ずれ)
  private fromGizmo() {
    const m = this.model, c = this.controls;
    const i = m ? this.posing.boneSel(m) : undefined;
    if (!m || !c || i === undefined) return;
    const b: THREE.Bone = m.model.skeleton.bones[i], rest = m.model.userData.rest[i], parent = b.parent!;
    parent.updateWorldMatrix(true, false);
    const v: BoneValue = { ...this.posing.boneValue(m, i) };
    if (c.mode === 'rotate') {
      parent.matrixWorld.decompose(_p, _q, _s);
      const local = _q.invert().multiply(this.proxy.quaternion);
      const pose = _q2.copy(rest.q).invert().multiply(local);
      _e.setFromQuaternion(pose, 'YXZ');
      Object.assign(v, { rx: _e.x / DEG, ry: _e.y / DEG, rz: _e.z / DEG });
    } else {
      const local = parent.worldToLocal(this.proxy.position.clone());
      Object.assign(v, { px: local.x - rest.p.x, py: local.y - rest.p.y, pz: local.z - rest.p.z });
    }
    this.posing.setBoneValue(m, i, v);
  }

  // 描く前: 関節と線をボーンの位置に合わせ、選んでいるボーンの色を変える。掴んでいないときは、ギズモをボーンに合わせる
  private sync() {
    const o = this.overlay, m = this.model;
    if (o) o.group.visible = this.active;
    if (!this.active || !o || !m) return;
    const bones: THREE.Bone[] = m.model.skeleton.bones, sel = this.posing.boneSel(m);
    m.model.updateMatrixWorld(true);
    const pos: number[] = [];
    o.bones.forEach((bi, k) => {
      bones[bi].getWorldPosition(o.joints[k].position);
      o.joints[k].scale.setScalar(bi === sel ? 1.6 : 1);
      (o.joints[k].material as THREE.MeshBasicMaterial).color.setHex(bi === sel ? COLORS.selected : COLORS[o.kind[k]]);
      const pk = o.parents[k];
      if (pk >= 0) pos.push(...bones[o.bones[pk]].getWorldPosition(_p).toArray(), ...o.joints[k].position.toArray());
    });
    o.lines.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    if (!this.dragging && sel !== undefined && this.controls?.object) this.placeProxy(m, sel);
  }
}
