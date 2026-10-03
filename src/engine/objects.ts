import * as THREE from 'three';
import { cam } from './camera';
import { MAX_BOXES, PALETTE } from './constants';
import { render, requestDraw } from './loop';
import { stopMotion } from './mmd/motion';
import { stopPhysics } from './mmd/physics';
import { noOutline, scene } from './scene';
import { selObj, selectObj } from './selection';
import { freeSpot, settleHeights, stackFrom as stackOf } from './stacking';
import type { Any, Obj } from './types';
import { ui } from './ui';

// --- 置いた物 (形と PMX モデル) の作成・削除・積み重ね ---
export const boxes: Obj[] = [];

const SHAPE_GEOMETRY = [
  new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
  // 寝かせたトーラス: 中心円の半径 0.35、管の半径 0.15 (高さ 0.3)
  new THREE.TorusGeometry(0.35, 0.15, 24, 64).rotateX(Math.PI / 2).translate(0, 0.15, 0),
  // 三角錐: 底面は外接円の半径 0.5 の正三角形、高さ 0.8
  new THREE.ConeGeometry(0.5, 0.8, 3, 1).translate(0, 0.4, 0),
];
const SHAPE_HEIGHT = [1, 0.3, 0.8];
let nextId = 1;
export function makeNode(obj: Omit<Obj, 'node' | 'id'>, object3d: THREE.Object3D): Obj {
  const node = new THREE.Group();
  node.add(object3d);
  object3d.traverse(o => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  scene.add(node);
  const full = obj as Obj;
  full.node = node;
  full.id = nextId++;
  node.userData.obj = full;
  return full;
}
export function makeBox(x: number, z: number, c: number, s = 0): Obj {
  const mesh = new THREE.Mesh(SHAPE_GEOMETRY[s], new THREE.MeshLambertMaterial({ flatShading: s === 2, userData: noOutline() }));
  return makeNode({ x, y: 0, z, c, s, r: 0, py: 0, vy: 0, h: SHAPE_HEIGHT[s], hx: 0.5, hz: 0.5, mesh }, mesh);
}
export function removeObject(obj: Obj) {
  scene.remove(obj.node);
  stopPhysics(obj);
  stopMotion(obj);
  if (obj.s === 3) disposeModel(obj.node);
  else obj.mesh!.material.dispose();
  boxes.splice(boxes.indexOf(obj), 1);
}
// MMD モデルの形状・材質・テクスチャを片付ける
export function disposeModel(root: THREE.Object3D) {
  root.traverse(o => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    for (const m of [mesh.material].flat() as Any[]) {
      // MMD の材質はテクスチャを uniforms の中に持っている
      for (const v of [...Object.values(m), ...Object.values(m.uniforms ?? {}).map((u: Any) => u.value)]) {
        if ((v as Any)?.isTexture) (v as THREE.Texture).dispose();
      }
      m.dispose();
    }
  });
}

export function updateAddButton() {
  ui.set({ canAdd: boxes.length < MAX_BOXES });
}
// 追加メニューで最後に選んだ形 (スマホで地面を長押ししたときに置く形)
let currentShape = 0;
// 追加 > 立方体など: 画面中央の近くに置いて、それを選ぶ
export function addShape(s: number) {
  currentShape = s;
  if (boxes.length >= MAX_BOXES) return;
  const [x, z] = findFreeSpot(Math.SQRT1_2);
  const box = makeBox(x, z, nextColor(), s);
  boxes.push(box);
  selectObj(box);
  updateAddButton();
  requestDraw();
}
// 置いた物を、少し上から落として着地させる
export function dropIn(b: Obj) {
  settle();
  b.py = b.y + 1.5;
  b.vy = 0;
  startFall();
  updateAddButton();
}
// 指定した地面の位置に形を置く。ほかの物と重なればその上に積む
export function placeBox(x: number, z: number) {
  if (boxes.length >= MAX_BOXES) return false;
  const b = makeBox(x, z, nextColor(), currentShape);
  boxes.push(b);
  dropIn(b);
  selectObj(b);
  return true;
}
export function deleteBox(box: Obj) {
  if (pickerBox === box) closePicker();
  if (selObj === box) selectObj(null);
  removeObject(box);
  settle();
  updateAddButton();
  requestDraw();
}
export function deleteSelected() {
  if (selObj) deleteBox(selObj);
}
// サイドバーの「オブジェクト」から位置・向き・色を変える
export function setObjProp(key: 'x' | 'z' | 'r', v: number) {
  const o = selObj;
  if (!o || !Number.isFinite(v)) return;
  if (key === 'r') o.r = v * Math.PI / 180;
  else o[key] = v;
  settle();
  requestDraw();
}
export function setObjColor(c: number) {
  if (!selObj || selObj.s === 3) return;
  selObj.c = c;
  requestDraw();
}

// --- 色選び (スマホで形をタップしたときに出すパレット) ---
export let pickerBox: Obj | null = null; // パレットで色を変えている形
export function openPicker(box: Obj, x: number, y: number) {
  pickerBox = box;
  ui.set({ palette: { x, y, c: box.c } });
  requestDraw();
}
export function closePicker() {
  if (!pickerBox && !ui.get().palette) return;
  pickerBox = null;
  ui.set({ palette: null });
  requestDraw();
}
export function pickColor(i: number) {
  if (pickerBox) pickerBox.c = i;
  closePicker();
}
// まだ使われていない色を優先し、全色使用中なら一番使われていない色を選ぶ
export function nextColor() {
  const used = PALETTE.map((_, i) => boxes.filter(b => b.c === i).length);
  return used.indexOf(Math.min(...used));
}

// --- 積み重ね (計算は stacking.ts) ---
export const stackFrom = (b: Obj) => stackOf(boxes, b);
export function settle(exclude: Obj[] = []) {
  settleHeights(boxes, exclude);
  startFall();
}

// 落下アニメーション: 表示上の高さ py を、重力で y まで落とす (着地で少し跳ねる)。
// 上がるときは y より少し高くまで跳び上がってから、同じ重力で着地する
const GRAVITY = 40;
const HOP = 0.25; // 跳び乗るときに y より上へ跳ぶ高さ
let falling = false, lastTime = 0;
export function startFall() {
  for (const b of boxes) {
    if (b.py >= b.y) continue;
    const v0 = Math.sqrt(2 * GRAVITY * (b.y - b.py + HOP));
    if (b.vy > -v0) b.vy = -v0; // vy は下向きが正
  }
  if (falling || !boxes.some(b => b.py !== b.y || b.vy !== 0)) return;
  falling = true;
  lastTime = 0;
  requestAnimationFrame(fallStep);
}
function fallStep(now: number) {
  // 最初のフレームは基準時刻だけ取る (rAF の時刻は performance.now() より前のことがある)
  const dt = lastTime ? Math.min(Math.max(now - lastTime, 0) / 1000, 1 / 30) : 0;
  lastTime = now;
  let moving = false;
  for (const b of boxes) {
    if (b.py === b.y && b.vy === 0) continue;
    b.vy += GRAVITY * dt;
    b.py -= b.vy * dt;
    if (b.vy > 0 && b.py <= b.y) {
      b.py = b.y;
      b.vy = b.vy > 3 ? -b.vy * 0.25 : 0; // 速ければ小さく跳ね返る
    }
    if (b.py !== b.y || b.vy !== 0) moving = true;
  }
  render();
  if (moving) requestAnimationFrame(fallStep);
  else falling = false;
}

// 画面中央 (注視点) に近い、ほかの物と重ならないマス目を探す (半径 rad の物を置く)
export const findFreeSpot = (rad: number, cx = Math.round(cam.tx), cz = Math.round(cam.tz)) => freeSpot(boxes, rad, cx, cz);
