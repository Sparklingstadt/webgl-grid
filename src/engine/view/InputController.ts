import { overlaps, topOf } from '../../core/stacking';
import type { Viewport } from '../render/Viewport';
import { isModel, type Obj } from '../types';
import type { ColorPicker } from '../world/ColorPicker';
import type { Selection } from '../world/Selection';
import type { World } from '../world/World';
import { rayPlane, type CameraController } from './CameraController';

// --- ビューポートのポインター操作 (マウスとタッチ) ---
//   物をドラッグ: 運ぶ (スマホは長押ししてから)。Shift+ドラッグ: 縦軸まわりに回す
//   2 本指: 物を押さえてひねると回す / 何もない所ではピンチでズーム
//   何もない所をドラッグ: カメラを回す・動かす。地面を長押し (スマホ): 形を置く
//   クリック: 選ぶ。ダブルクリック・ダブルタップ: 削除
type RotGroup = { obj: Obj; group: { o: Obj; dx: number; dz: number; r: number }[] };
type Carry = { obj: Obj; group: { o: Obj; dx: number; dy: number; dz: number }[]; held: number; h: number; ox: number; oz: number };
type Drag = {
  id: number; x: number; y: number; sx: number; sy: number;
  carry?: Carry | null;
  rot?: RotGroup | null;
  twist?: (RotGroup & { ids: number[]; last: number; total: number }) | null;
  pinch?: { ids: number[]; last: number } | null;
  pending?: { obj?: Obj; timer: ReturnType<typeof setTimeout> } | null;
  grabbed?: boolean; placed?: boolean;
  box?: boolean; // ボックス選択 (B のあとのドラッグ)
};
const LONG_PRESS_MS = 400; // スマホで形を掴む・置くまでの長押し時間
const DOUBLE_TAP_MS = 300;
// 長押しが成立したことを振動で知らせる (ブラウザは、まだ一度も操作されていないページからの振動を拒否する)
const buzz = () => { if (navigator.userActivation?.hasBeenActive ?? true) navigator.vibrate?.(15); };

export interface InputActions {
  placeShape(x: number, z: number): boolean; // 地面の長押しで形を置く
  remove(obj: Obj): void;
  userGesture(): void;                       // 画面を触った (自動再生を止められた曲を鳴らす)
  // ポーズモード: そのあいだは物を選ばず・運ばず・消さない。関節を押したらボーンを選ぶ。ギズモを触っているあいだはカメラも動かさない
  pose?: { active(): boolean; busy(): boolean; pick(x: number, y: number): boolean };
  // ボックス選択 (B): 次のドラッグで四角を描き、離したら中の物を選ぶ (Shift で足す)
  box?: { active(): boolean; show(rect: { x0: number; y0: number; x1: number; y1: number } | null): void; done(x0: number, y0: number, x1: number, y1: number, extend: boolean): void };
}

export class InputController {
  drag: Drag | null = null;
  readonly pointers = new Map<number, { x: number; y: number }>(); // 画面に触れている指 (マウス) の位置
  private hoverAt: { x: number; y: number } | null = null;
  private wasDragged = false;
  private colorTimer: ReturnType<typeof setTimeout> | undefined;
  private ignoreClicksUntil = 0; // ダブルタップで削除した直後のクリックは無視する
  private lastPointerType = 'mouse';
  private lastTap: { obj: Obj; t: number; x: number; y: number } | null = null;
  private abort = new AbortController();

  constructor(private canvas: HTMLCanvasElement, private viewport: Viewport, private world: World, private camera: CameraController,
              private selection: Selection, private picker: ColorPicker, private actions: InputActions) {
    const opt = { signal: this.abort.signal };
    canvas.addEventListener('pointerdown', this.onPointerDown, opt);
    canvas.addEventListener('pointermove', this.onPointerMove, opt);
    canvas.addEventListener('pointerup', this.endDrag, opt);
    canvas.addEventListener('pointercancel', this.endDrag, opt);
    // 「離した」が届かずに捕捉が外れたときも、ドラッグを終わらせる
    canvas.addEventListener('lostpointercapture', e => { if (this.drag && e.pointerId === this.drag.id) this.endDrag(e); }, opt);
    canvas.addEventListener('click', this.onClick, opt);
    canvas.addEventListener('dblclick', this.onDblClick, opt);
    canvas.addEventListener('contextmenu', e => e.preventDefault(), opt); // 長押しでメニューを出さない
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      camera.zoomBy(Math.exp(e.deltaY * 0.001));
    }, { passive: false, signal: this.abort.signal });
    canvas.classList.toggle('pan', camera.mode === 'pan');
  }
  dispose() { this.abort.abort(); }

  // 掴んでいる物 (明るく表示する)
  get held(): Obj | null {
    const d = this.drag;
    return d?.carry?.obj ?? d?.rot?.obj ?? d?.twist?.obj ?? null;
  }

  // b とその上に載っている物を、b を軸にまとめて回すための情報
  private rotationGroup(b: Obj): RotGroup {
    return { obj: b, group: this.world.stackFrom(b).map(o => ({ o, dx: o.x - b.x, dz: o.z - b.z, r: o.r })) };
  }
  // 回し始めからの角度 a (ラジアン) だけ回す
  private rotateGroup({ obj, group }: RotGroup, a: number) {
    const c = Math.cos(a), sn = Math.sin(a);
    for (const g of group) {
      g.o.x = obj.x + g.dx * c + g.dz * sn;
      g.o.z = obj.z - g.dx * sn + g.dz * c;
      g.o.r = g.r + a;
    }
    this.viewport.requestDraw();
  }
  private pointerAngle([a, b]: number[]) {
    const p = this.pointers.get(a)!, q = this.pointers.get(b)!;
    return Math.atan2(q.y - p.y, q.x - p.x);
  }
  private pointerDistance([a, b]: number[]) {
    const p = this.pointers.get(a)!, q = this.pointers.get(b)!;
    return Math.max(Math.hypot(q.x - p.x, q.y - p.y), 1);
  }

  private onPointerDown = (e: PointerEvent) => {
    const { camera, world } = this;
    this.actions.userGesture();
    this.picker.close(); // パレットの外を触ったら閉じる
    const pose = this.actions.pose;
    if (pose?.active() && !this.drag && (pose.busy() || pose.pick(e.clientX, e.clientY))) return;
    // 前のドラッグの「離した」が届いていなかったら (同じポインターがまた押された・マウスなのに 2 本目)、それは終わらせる
    if (this.drag && (this.drag.id === e.pointerId || e.pointerType === 'mouse')) {
      this.pointers.clear();
      this.endDrag(new PointerEvent('pointercancel', { pointerId: this.drag.id, pointerType: e.pointerType }));
    }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* 捕捉できなくても操作は続ける */ }
    if (this.drag) {
      // 形を押さえたままもう1本の指を置いたら、2本指をひねって回す (スマホ用)
      const drag = this.drag;
      const held = drag.carry?.obj ?? drag.rot?.obj ?? drag.pending?.obj;
      if (drag.twist || drag.pinch || this.pointers.size !== 2) return;
      const ids = [drag.id, e.pointerId];
      if (drag.pending) { clearTimeout(drag.pending.timer); drag.pending = null; }
      if (held) {
        drag.twist = { ...this.rotationGroup(held), ids, last: this.pointerAngle(ids), total: 0 };
        drag.carry = drag.rot = null;
      } else {
        // 形以外に置いた2本の指は、ピンチでズーム
        drag.pinch = { ids, last: this.pointerDistance(ids) };
        camera.releaseOverride(true);
      }
      return;
    }
    const d: Drag = this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY };
    if (this.actions.box?.active()) { d.box = true; this.canvas.classList.add('dragging'); return; }
    // 形を掴んだら、掴んだ点の高さの水平面に沿って動かす
    const ray = camera.screenRay(e.clientX, e.clientY);
    const picked = this.actions.pose?.active() ? null : camera.pick(ray);
    if (picked) {
      const { obj, t } = picked;
      const hy = ray.ro[1] + ray.rd[1] * t;
      const hit = [ray.ro[0] + ray.rd[0] * t, ray.ro[2] + ray.rd[2] * t];
      // 上に載っている物も一緒に運ぶ。運んでいる間は持ち上げた高さを保ち、離したときに落とす
      const grab = () => {
        const group = world.stackFrom(obj).map(o => ({ o, dx: o.x - obj.x, dy: o.y - obj.y, dz: o.z - obj.z }));
        d.carry = { obj, group, held: obj.py, h: hy, ox: obj.x - hit[0], oz: obj.z - hit[1] };
        // 掴んだ物を選ぶ (選んでいる物の 1 つなら、ほかの選択はそのままでアクティブに)
        if (this.selection.isSelected(obj)) this.selection.setActive(obj); else this.selection.select(obj);
        this.viewport.requestDraw();
      };
      if (e.shiftKey) {
        // Shift+ドラッグ: 縦軸まわりに回す (動かさずに離したら、Shift+クリックで選択に足す・外す)
        d.rot = this.rotationGroup(obj);
      } else if (e.pointerType === 'touch') {
        // スマホは長押しで掴む。その前に指を動かしたら、ふつうにカメラを動かす
        d.pending = {
          obj,
          timer: setTimeout(() => {
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
          timer: setTimeout(() => {
            d.pending = null;
            d.grabbed = true; // 離したときにタップ扱いにしない
            d.placed = true;  // 置いたあとは、その指を離すまで何もしない
            if (this.actions.placeShape(ground[0], ground[1])) buzz();
          }, LONG_PRESS_MS),
        };
      }
    }
    this.canvas.classList.add('dragging');
  };

  // マウスを乗せたときのカーソル変更。当たり判定は 1 フレームに 1 回まで
  private updateHover = () => {
    if (!this.hoverAt) return;
    const { x, y } = this.hoverAt;
    this.hoverAt = null;
    if (!this.drag) this.canvas.classList.toggle('over-box', !!this.camera.pick(this.camera.screenRay(x, y)));
  };
  private onPointerMove = (e: PointerEvent) => {
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const drag = this.drag;
    if (!drag) {
      if (!this.hoverAt) requestAnimationFrame(this.updateHover);
      this.hoverAt = { x: e.clientX, y: e.clientY };
      return;
    }
    if (drag.twist) {
      // 画面上で指を時計回りにひねると、上から見て時計回りに回る
      const t = drag.twist;
      const ang = this.pointerAngle(t.ids);
      let d = ang - t.last;
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      t.last = ang;
      t.total += d;
      this.rotateGroup(t, -t.total);
      return;
    }
    if (drag.pinch) {
      // 指を広げると近づき、狭めると離れる
      const d = this.pointerDistance(drag.pinch.ids);
      this.camera.zoomBy(drag.pinch.last / d);
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
    if (drag.box) {
      this.actions.box?.show({ x0: drag.sx, y0: drag.sy, x1: e.clientX, y1: e.clientY });
      return;
    }
    if (drag.rot) {
      if (!this.selection.isSelected(drag.rot.obj)) this.selection.select(drag.rot.obj);
      // 右へドラッグすると手前の面が右へ動く向きに回す
      this.rotateGroup(drag.rot, (e.clientX - drag.sx) * 0.01);
      return;
    }
    if (drag.carry) { this.carry(drag.carry, e); return; }
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (this.camera.mode === 'orbit') this.camera.orbit(dx, dy);
    else this.camera.pan(dx, dy);
    drag.x = e.clientX;
    drag.y = e.clientY;
  };
  // 掴んだ物 (と上に載っている物) を運ぶ。ほかの物の上まで来たらその上に載せる
  private carry(held: Carry, e: PointerEvent) {
    const hit = rayPlane(this.camera.screenRay(e.clientX, e.clientY), held.h);
    if (!hit) return;
    const { obj, group } = held;
    const members = group.map(g => g.o);
    obj.x = hit[0] + held.ox;
    obj.z = hit[1] + held.oz;
    if (obj.light) { this.viewport.requestDraw(); return; } // ライトは高さを変えずに運ぶ
    for (const g of group) { g.o.x = obj.x + g.dx; g.o.z = obj.z + g.dz; }
    // 運んでいない物を落とし、運んでいる山はその上に載せる
    this.world.settle(members);
    const others = this.world.objects.filter(o => !members.includes(o) && !o.light);
    const base = Math.max(held.held, ...group.map(g =>
      Math.max(0, ...others.filter(o => overlaps(o, g.o)).map(topOf)) - g.dy));
    held.held = base;
    for (const g of group) {
      if (g.o.py > base + g.dy) { g.o.py = base + g.dy; g.o.vy = 0; } // 下がる分は手で持っているので即座に
      g.o.y = base + g.dy;
    }
    this.world.startFall();
    this.viewport.requestDraw();
  }

  // クリックした物を選ぶ (Blender と同じく、何もない所をクリックすると選択を解除)。
  // スマホで形をタップしたときは、色のパレットも出す。
  // ダブルクリック・ダブルタップ (削除) と区別するため、パレットは少し待ってから出す
  private onClick = (e: MouseEvent) => {
    if (this.actions.pose?.active()) return;
    if (this.wasDragged || e.detail > 1 || performance.now() < this.ignoreClicksUntil) return;
    const picked = this.camera.pick(this.camera.screenRay(e.clientX, e.clientY));
    // Shift+クリック: 選択に足す・外す (Blender と同じ)。何もない所の Shift+クリックでは何もしない
    if (e.shiftKey) { if (picked) this.selection.toggle(picked.obj); return; }
    this.selection.select(picked?.obj ?? null);
    if (!picked || isModel(picked.obj) || this.lastPointerType !== 'touch') return;
    clearTimeout(this.colorTimer);
    const { clientX: x, clientY: y } = e;
    this.colorTimer = setTimeout(() => { if (this.world.has(picked.obj)) this.picker.open(picked.obj, x, y); }, DOUBLE_TAP_MS);
  };
  // 削除して、カーソルの形を下にある物に合わせ直す
  private removeAt(obj: Obj, x: number, y: number) {
    clearTimeout(this.colorTimer);
    this.actions.remove(obj);
    this.canvas.classList.toggle('over-box', !!this.camera.pick(this.camera.screenRay(x, y)));
  }
  // ダブルクリックした物を削除 (タッチはブラウザによって dblclick が来ないので、下のダブルタップで扱う)
  private onDblClick = (e: MouseEvent) => {
    if (this.lastPointerType === 'touch' || this.actions.pose?.active()) return;
    const picked = this.camera.pick(this.camera.screenRay(e.clientX, e.clientY));
    if (picked) this.removeAt(picked.obj, e.clientX, e.clientY);
  };
  // 同じ物を素早く2回タップしたら削除
  private handleTap(e: PointerEvent) {
    if (this.actions.pose?.active()) return;
    const picked = this.camera.pick(this.camera.screenRay(e.clientX, e.clientY));
    const now = performance.now();
    const last = this.lastTap;
    if (picked && last && last.obj === picked.obj && now - last.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 30) {
      this.lastTap = null;
      this.ignoreClicksUntil = now + 400;
      this.removeAt(picked.obj, e.clientX, e.clientY);
      return;
    }
    this.lastTap = picked ? { obj: picked.obj, t: now, x: e.clientX, y: e.clientY } : null;
  }
  private endDrag = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    this.lastPointerType = e.pointerType;
    const drag = this.drag;
    if (!drag) return;
    const two = drag.twist || drag.pinch;
    if (two) {
      // ひねり・ピンチは、指のどちらかを離したら終わり (残った指はそのまま離すまで何もしない)
      if (!two.ids.includes(e.pointerId)) return;
      this.wasDragged = true;
    } else {
      if (e.pointerId !== drag.id) return;
      // 少し以上動いたらドラッグ扱いにして、クリックで選ばない (指はぶれやすいので広めに)
      // 長押しで掴んだあとは、動かさずに離してもタップ扱いにしない
      const slop = e.pointerType === 'touch' ? 10 : 4;
      this.wasDragged = !!drag.grabbed || Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > slop;
      if (!this.wasDragged && e.type === 'pointerup' && e.pointerType === 'touch') this.handleTap(e);
    }
    if (drag.pending) clearTimeout(drag.pending.timer);
    if (drag.box) {
      this.actions.box?.show(null);
      if (e.type === 'pointerup') this.actions.box?.done(drag.sx, drag.sy, e.clientX, e.clientY, e.shiftKey);
      this.ignoreClicksUntil = performance.now() + 100; // (離したときのクリックで選び直さない)
    }
    if (drag.carry || drag.rot || drag.twist) this.world.settle();
    this.drag = null;
    this.viewport.requestDraw();
    this.canvas.classList.remove('dragging');
  };
}
