import { cam, cancelViewAnim, mode, pickBox, rayPlane, screenRay, setViewName, zoomBy } from './camera';
import { requestDraw } from './loop';
import { stopCameraMotion } from './mmd/motion';
import { musicWaiting, playMusic } from './music';
import { boxes, closePicker, deleteBox, openPicker, placeBox, settle, stackFrom, startFall } from './objects';
import { gl } from './scene';
import { selectObj } from './selection';
import { overlaps, topOf } from './stacking';
import type { Obj } from './types';

// --- ビューポートのポインター操作 (マウスとタッチ) ---
//   物をドラッグ: 運ぶ (スマホは長押ししてから)。Shift+ドラッグ: 縦軸まわりに回す
//   2 本指: 物を押さえてひねると回す / 何もない所ではピンチでズーム
//   何もない所をドラッグ: カメラを回す・動かす。地面を長押し (スマホ): 形を置く
//   クリック: 選ぶ。ダブルクリック・ダブルタップ: 削除
type RotGroup = { box: Obj; group: { o: Obj; dx: number; dz: number; r: number }[] };
type Drag = {
  id: number; x: number; y: number; sx: number; sy: number;
  box?: { box: Obj; group: { o: Obj; dx: number; dy: number; dz: number }[]; held: number; h: number; ox: number; oz: number } | null;
  rot?: RotGroup | null;
  twist?: (RotGroup & { ids: number[]; last: number; total: number }) | null;
  pinch?: { ids: number[]; last: number } | null;
  pending?: { box?: Obj; timer: number } | null;
  grabbed?: boolean; placed?: boolean;
};
export let drag: Drag | null = null;
export const pointers = new Map<number, { x: number; y: number }>(); // 画面に触れている指 (マウス) の位置
const LONG_PRESS_MS = 400; // スマホで形を掴む・置くまでの長押し時間
const DOUBLE_TAP_MS = 300;
// 長押しが成立したことを振動で知らせる (ブラウザは、まだ一度も操作されていないページからの振動を拒否する)
const buzz = () => { if (navigator.userActivation?.hasBeenActive ?? true) navigator.vibrate?.(15); };

// b とその上に載っている物を、b を軸にまとめて回すための情報
const rotationGroup = (b: Obj): RotGroup =>
  ({ box: b, group: stackFrom(b).map(o => ({ o, dx: o.x - b.x, dz: o.z - b.z, r: o.r })) });
// 回し始めからの角度 a (ラジアン) だけ回す
function rotateGroup({ box, group }: RotGroup, a: number) {
  const c = Math.cos(a), sn = Math.sin(a);
  for (const g of group) {
    g.o.x = box.x + g.dx * c + g.dz * sn;
    g.o.z = box.z - g.dx * sn + g.dz * c;
    g.o.r = g.r + a;
  }
  requestDraw();
}
const pointerAngle = ([a, b]: number[]) => {
  const p = pointers.get(a)!, q = pointers.get(b)!;
  return Math.atan2(q.y - p.y, q.x - p.x);
};
const pointerDistance = ([a, b]: number[]) => {
  const p = pointers.get(a)!, q = pointers.get(b)!;
  return Math.max(Math.hypot(q.x - p.x, q.y - p.y), 1);
};

function onPointerDown(e: PointerEvent) {
  const canvas = gl.canvas;
  if (musicWaiting) playMusic(); // 自動再生を止められていた曲は、画面を触ったときに再生する
  closePicker(); // パレットの外を触ったら閉じる
  // 前のドラッグの「離した」が届いていなかったら (同じポインターがまた押された・マウスなのに 2 本目)、それは終わらせる
  if (drag && (drag.id === e.pointerId || e.pointerType === 'mouse')) {
    pointers.clear();
    endDrag(new PointerEvent('pointercancel', { pointerId: drag.id, pointerType: e.pointerType }));
  }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  try { canvas.setPointerCapture(e.pointerId); } catch { /* 捕捉できなくても操作は続ける */ }
  if (drag) {
    // 形を押さえたままもう1本の指を置いたら、2本指をひねって回す (スマホ用)
    const held = drag.box?.box ?? drag.rot?.box ?? drag.pending?.box;
    if (drag.twist || drag.pinch || pointers.size !== 2) return;
    const ids = [drag.id, e.pointerId];
    if (drag.pending) { clearTimeout(drag.pending.timer); drag.pending = null; }
    if (held) {
      drag.twist = { ...rotationGroup(held), ids, last: pointerAngle(ids), total: 0 };
      drag.box = drag.rot = null;
    } else {
      // 形以外に置いた2本の指は、ピンチでズーム
      drag.pinch = { ids, last: pointerDistance(ids) };
      stopCameraMotion(true);
    }
    return;
  }
  const d: Drag = drag = { id: e.pointerId, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY };
  // 形を掴んだら、掴んだ点の高さの水平面に沿って動かす
  const ray = screenRay(e.clientX, e.clientY);
  const picked = pickBox(ray);
  if (picked) {
    const { box, t } = picked;
    const hy = ray.ro[1] + ray.rd[1] * t;
    const hit = [ray.ro[0] + ray.rd[0] * t, ray.ro[2] + ray.rd[2] * t];
    // 上に載っている物も一緒に運ぶ。運んでいる間は持ち上げた高さを保ち、離したときに落とす
    const grab = () => {
      const group = stackFrom(box).map(o => ({ o, dx: o.x - box.x, dy: o.y - box.y, dz: o.z - box.z }));
      d.box = { box, group, held: box.py, h: hy, ox: box.x - hit[0], oz: box.z - hit[1] };
      selectObj(box); // 掴んだ物を選ぶ
      requestDraw();
    };
    if (e.shiftKey) {
      // Shift+ドラッグ: 縦軸まわりに回す
      d.rot = rotationGroup(box);
      selectObj(box);
    } else if (e.pointerType === 'touch') {
      // スマホは長押しで掴む。その前に指を動かしたら、ふつうにカメラを動かす
      d.pending = {
        box,
        timer: window.setTimeout(() => {
          d.pending = null;
          d.grabbed = true;
          grab();
          buzz();
        }, LONG_PRESS_MS),
      };
    } else {
      grab();
    }
  } else if (e.pointerType === 'touch' && !e.shiftKey) {
    // スマホで何もない地面を長押ししたら、そこに形を置く
    const ground = rayPlane(ray, 0);
    if (ground) {
      d.pending = {
        timer: window.setTimeout(() => {
          d.pending = null;
          d.grabbed = true; // 離したときにタップ扱いにしない
          d.placed = true;  // 置いたあとは、その指を離すまで何もしない
          if (placeBox(ground[0], ground[1])) buzz();
        }, LONG_PRESS_MS),
      };
    }
  }
  canvas.classList.add('dragging');
}

// マウスを乗せたときのカーソル変更。当たり判定は 1 フレームに 1 回まで
let hoverAt: { x: number; y: number } | null = null;
function updateHover() {
  if (!hoverAt) return;
  const { x, y } = hoverAt;
  hoverAt = null;
  if (!drag) gl.canvas.classList.toggle('over-box', !!pickBox(screenRay(x, y)));
}
function onPointerMove(e: PointerEvent) {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!drag) {
    if (!hoverAt) requestAnimationFrame(updateHover);
    hoverAt = { x: e.clientX, y: e.clientY };
    return;
  }
  if (drag.twist) {
    // 画面上で指を時計回りにひねると、上から見て時計回りに回る
    const t = drag.twist;
    const ang = pointerAngle(t.ids);
    let d = ang - t.last;
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    t.last = ang;
    t.total += d;
    rotateGroup(t, -t.total);
    return;
  }
  if (drag.pinch) {
    // 指を広げると近づき、狭めると離れる
    const d = pointerDistance(drag.pinch.ids);
    zoomBy(drag.pinch.last / d);
    drag.pinch.last = d;
    return;
  }
  if (e.pointerId !== drag.id || drag.placed) return; // 2本目の指の動きは、ひねり・ピンチ以外では使わない
  if (drag.pending) {
    // 長押しになる前に指が動いたら、形は掴まずにカメラの操作にする
    if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) <= 10) return;
    clearTimeout(drag.pending.timer);
    drag.pending = null;
  }
  if (drag.rot) {
    // 右へドラッグすると手前の面が右へ動く向きに回す
    rotateGroup(drag.rot, (e.clientX - drag.sx) * 0.01);
    return;
  }
  if (drag.box) { carry(drag.box, e); return; }
  stopCameraMotion(true); // 自分でカメラを動かしたら、カメラモーションをやめる
  cancelViewAnim();
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (mode === 'orbit') {
    if (dx || dy) setViewName(''); // 「前」「上」などから回したら、ふつうの視点
    cam.yaw -= dx * 0.005;
    cam.pitch += dy * 0.005;
    // カメラが地面の下に潜らない角度まで (注視点が地面なら約 3° まで)
    const minPitch = cam.ty > 0 ? Math.asin(Math.min(Math.max((0.05 - cam.ty) / cam.dist, -1), 1)) : 0.05;
    cam.pitch = Math.min(Math.max(cam.pitch, minPitch), 1.5);
  } else {
    // 画面上の動きを地面上の前後左右に変換 (掴んだ地面が付いてくるように)
    const k = cam.dist * 0.0015;
    const fx = -Math.cos(cam.yaw), fz = -Math.sin(cam.yaw); // 地面上の前方向
    const rx = -fz, rz = fx;                               // 地面上の右方向
    cam.tx += -rx * dx * k + fx * dy * k;
    cam.tz += -rz * dx * k + fz * dy * k;
  }
  drag.x = e.clientX;
  drag.y = e.clientY;
  requestDraw();
}
// 掴んだ物 (と上に載っている物) を運ぶ。ほかの物の上まで来たらその上に載せる
function carry(held: NonNullable<Drag['box']>, e: PointerEvent) {
  const hit = rayPlane(screenRay(e.clientX, e.clientY), held.h);
  if (!hit) return;
  const { box, group } = held;
  const members = group.map(g => g.o);
  box.x = hit[0] + held.ox;
  box.z = hit[1] + held.oz;
  for (const g of group) { g.o.x = box.x + g.dx; g.o.z = box.z + g.dz; }
  // 運んでいない物を落とし、運んでいる山はその上に載せる
  settle(members);
  const others = boxes.filter(o => !members.includes(o));
  const base = Math.max(held.held, ...group.map(g =>
    Math.max(0, ...others.filter(o => overlaps(o, g.o)).map(topOf)) - g.dy));
  held.held = base;
  for (const g of group) {
    if (g.o.py > base + g.dy) { g.o.py = base + g.dy; g.o.vy = 0; } // 下がる分は手で持っているので即座に
    g.o.y = base + g.dy;
  }
  startFall();
  requestDraw();
}

// クリックした物を選ぶ (Blender と同じく、何もない所をクリックすると選択を解除)。
// スマホで形をタップしたときは、色のパレットも出す。
// ダブルクリック・ダブルタップ (削除) と区別するため、パレットは少し待ってから出す
let wasDragged = false;
let colorTimer = 0;
let ignoreClicksUntil = 0; // ダブルタップで削除した直後のクリックは無視する
let lastPointerType = 'mouse';
function onClick(e: MouseEvent) {
  if (wasDragged || e.detail > 1 || performance.now() < ignoreClicksUntil) return;
  const picked = pickBox(screenRay(e.clientX, e.clientY));
  selectObj(picked?.box ?? null);
  if (!picked || picked.box.s === 3 || lastPointerType !== 'touch') return;
  clearTimeout(colorTimer);
  const { clientX: x, clientY: y } = e;
  colorTimer = window.setTimeout(() => { if (boxes.includes(picked.box)) openPicker(picked.box, x, y); }, DOUBLE_TAP_MS);
}
// 削除して、カーソルの形を下にある物に合わせ直す
function deleteAt(box: Obj, x: number, y: number) {
  clearTimeout(colorTimer);
  deleteBox(box);
  gl.canvas.classList.toggle('over-box', !!pickBox(screenRay(x, y)));
}
// ダブルクリックした物を削除 (タッチはブラウザによって dblclick が来ないので、下のダブルタップで扱う)
function onDblClick(e: MouseEvent) {
  if (lastPointerType === 'touch') return;
  const picked = pickBox(screenRay(e.clientX, e.clientY));
  if (picked) deleteAt(picked.box, e.clientX, e.clientY);
}
// 同じ物を素早く2回タップしたら削除
let lastTap: { box: Obj; t: number; x: number; y: number } | null = null;
function handleTap(e: PointerEvent) {
  const picked = pickBox(screenRay(e.clientX, e.clientY));
  const now = performance.now();
  if (picked && lastTap && lastTap.box === picked.box && now - lastTap.t < DOUBLE_TAP_MS &&
      Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
    lastTap = null;
    ignoreClicksUntil = now + 400;
    deleteAt(picked.box, e.clientX, e.clientY);
    return;
  }
  lastTap = picked ? { box: picked.box, t: now, x: e.clientX, y: e.clientY } : null;
}
function endDrag(e: PointerEvent) {
  pointers.delete(e.pointerId);
  lastPointerType = e.pointerType;
  if (!drag) return;
  const two = drag.twist || drag.pinch;
  if (two) {
    // ひねり・ピンチは、指のどちらかを離したら終わり (残った指はそのまま離すまで何もしない)
    if (!two.ids.includes(e.pointerId)) return;
    wasDragged = true;
  } else {
    if (e.pointerId !== drag.id) return;
    // 少し以上動いたらドラッグ扱いにして、クリックで選ばない (指はぶれやすいので広めに)
    // 長押しで掴んだあとは、動かさずに離してもタップ扱いにしない
    const slop = e.pointerType === 'touch' ? 10 : 4;
    wasDragged = !!drag.grabbed || Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > slop;
    if (!wasDragged && e.type === 'pointerup' && e.pointerType === 'touch') handleTap(e);
  }
  if (drag.pending) clearTimeout(drag.pending.timer);
  if (drag.box || drag.rot || drag.twist) settle();
  drag = null;
  requestDraw();
  gl.canvas.classList.remove('dragging');
}

export function attachInput(canvas: HTMLCanvasElement) {
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  // 「離した」が届かずに捕捉が外れたときも、ドラッグを終わらせる
  canvas.addEventListener('lostpointercapture', e => { if (drag && e.pointerId === drag.id) endDrag(e); });
  canvas.addEventListener('click', onClick);
  canvas.addEventListener('dblclick', onDblClick);
  canvas.addEventListener('contextmenu', e => e.preventDefault()); // 長押しでメニューを出さない
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    zoomBy(Math.exp(e.deltaY * 0.001));
  }, { passive: false });
  canvas.classList.toggle('pan', mode === 'pan');
}
