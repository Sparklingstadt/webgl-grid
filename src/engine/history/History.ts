import { Emitter } from '../../core/events';
import { animationFromJson, animationToJson, isEmpty } from '../../core/animation';
import { describeChange, type ObjState, type SceneState } from '../../core/history';
import type { Clock } from '../anim/Clock';
import type { Cloners } from '../world/Cloners';
import type { Deformers } from '../world/Deformers';
import type { Lights } from '../world/Lights';
import type { Environment } from '../render/Environment';
import type { SceneSettings } from '../../core/scene';
import type { Keyframes } from '../anim/Keyframes';
import type { MaterialData, MaterialLibrary } from '../materials/MaterialLibrary';
import type { Motion } from '../mmd/Motion';
import type { Physics } from '../mmd/Physics';
import type { Posing } from '../mmd/Posing';
import type { Viewport } from '../render/Viewport';
import { isModel, type ModelObj, type Obj } from '../types';
import type { UiChannel } from '../UiChannel';
import type { Selection } from '../world/Selection';
import type { World } from '../world/World';

interface Step { state: SceneState; sig: string; label: string; motionFiles: Map<number, File> }
const MAX_STEPS = 64;

// --- 元に戻す・やり直し (Blender の Ctrl+Z / Ctrl+Shift+Z) ---
// 編集のひと区切り (マウスやキーを離した・読み込みが終わった) ごとに、場面の編集できる部分の写しを取り、
// 前の写しと違えば 1 手として積む (スライダーを動かし続けても 1 手)。戻すときは、写しとの違いだけを直す。
// 消した物は捨てずに持っておき (World.keepRemoved)、戻したときにそのまま置き直す (モデルを読み直さない)。
// 視点・いまのフレーム・選択は手に数えない (Blender と同じ)
export class History {
  private steps: Step[] = [];
  private index = -1;
  private removed = new Map<number, Obj>(); // 消したが、写しが覚えている物
  private holds = 0;
  private pressed = false; // マウスのボタン (指) を押している
  private pending = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private restoring = false;
  private queue: Promise<unknown> = Promise.resolve();
  readonly events = new Emitter<{ changed: [] }>(); // 手が増えた・戻した (自動保存のきっかけ)

  constructor(private world: World, private library: MaterialLibrary, private physics: Physics, private motion: Motion,
              private posing: Posing, private keyframes: Keyframes, private clock: Clock, private selection: Selection,
              private viewport: Viewport, private ui: UiChannel, private cloners: Cloners, private deformers: Deformers, private environment: Environment, private lights: Lights) {
    world.keepRemoved = true;
    world.events.on('removed', obj => { this.removed.set(obj.id, obj); this.soon(); });
    world.events.on('added', () => this.soon());
    library.events.on('changed', () => this.soon());
    this.reset();
  }

  get canUndo() { return this.index > 0; }
  get canRedo() { return this.index < this.steps.length - 1; }

  // 写しを 1 つだけにする (最初の状態に戻した・プロジェクトを開いた)。持っていた消した物は片付ける
  reset() {
    clearTimeout(this.timer);
    this.pending = false;
    this.steps = [this.capture('最初')];
    this.index = 0;
    this.collect();
    this.publish();
  }

  // ひと区切りついたら写しを取る (少し待って、続けて起きた変化をまとめる)。押さえているあいだは待つ
  soon() {
    if (this.restoring) return;
    this.pending = true;
    clearTimeout(this.timer);
    if (!this.waiting) this.timer = setTimeout(() => this.checkpoint(), 60);
  }
  private get waiting() { return this.holds > 0 || this.pressed; }
  // マウスのボタン (指) を押しているあいだは写しを取らない (ドラッグを 1 手にまとめる)。離したら取る
  setPressed(on: boolean) {
    if (this.pressed === on) return;
    this.pressed = on;
    if (on) clearTimeout(this.timer); else this.soon();
  }
  // 読み込みなどのあいだは、写しを取らない
  hold() { this.holds++; clearTimeout(this.timer); }
  release() {
    this.holds = Math.max(this.holds - 1, 0);
    if (!this.waiting && this.pending) this.soon();
  }
  // 時間のかかる操作 (ファイルの読み込みなど) を、終わってから 1 手にする
  async batch<T>(fn: () => Promise<T>): Promise<T> {
    this.hold();
    try { return await fn(); } finally { this.release(); this.soon(); }
  }

  // いまの場面が前の写しと違えば、1 手として積む
  checkpoint() {
    clearTimeout(this.timer);
    this.pending = false;
    if (this.restoring || this.waiting) return;
    const cur = this.steps[this.index];
    const next = this.capture('');
    if (next.sig === cur.sig) return;
    next.label = describeChange(cur.state, next.state);
    this.steps.splice(this.index + 1, Infinity, next);
    if (this.steps.length > MAX_STEPS) this.steps.splice(0, this.steps.length - MAX_STEPS);
    this.index = this.steps.length - 1;
    this.collect();
    this.publish();
    this.events.emit('changed');
  }

  undo() { return this.go(-1); }
  redo() { return this.go(1); }
  // 履歴の i 番目の状態にする
  jump(i: number) { return this.go(i - this.index); }
  private go(delta: number) {
    this.queue = this.queue.then(async () => {
      this.checkpoint(); // まだ積んでいない変化があれば、先に 1 手にする
      const to = Math.min(Math.max(this.index + delta, 0), this.steps.length - 1);
      if (to === this.index) return;
      const label = delta < 0 ? this.steps[this.index].label : this.steps[to].label;
      this.index = to;
      await this.restore(this.steps[to]);
      this.publish();
      this.ui.toast(`${delta < 0 ? '元に戻す' : 'やり直す'}: ${label}`, 1500);
      this.events.emit('changed');
    });
    return this.queue;
  }

  // --- 写し ---
  private capture(label: string): Step {
    const motionFiles = new Map<number, File>();
    const objects: ObjState[] = this.world.objects.map(o => {
      const st: ObjState = { id: o.id, s: o.s, x: o.x, y: o.y, z: o.z, r: o.r, c: o.c, slots: [...o.slots], cloner: o.cloner ? structuredClone(o.cloner) : null, deformers: o.deformers ? structuredClone(o.deformers) : null, light: o.light ? { ...o.light } : null };
      if (!isModel(o)) return st;
      // キーのあるボーン・表情の値は、いまのフレームで決まるので入れない
      const anim = o.anim;
      st.pose = [...(o.pose ?? [])].filter(([i]) => !anim?.bones.has(i)).map(([i, v]) => [i, { ...v }]);
      const inf: number[] | undefined = o.model.morphTargetInfluences;
      if (!o.animated && inf) st.morphs = Array.from(inf).map((v, m) => (anim?.morphs.has(m) ? 0 : v));
      st.anim = isEmpty(anim) ? null : animationToJson(anim!);
      st.hairHang = this.physics.hairHang(o);
      st.motion = o.motionFile?.name ?? null;
      if (o.motionFile) motionFiles.set(o.id, o.motionFile);
      return st;
    });
    const state: SceneState = { objects, materials: this.library.snapshot(), range: [this.clock.start, this.clock.end], scene: structuredClone(this.environment.settings) };
    return { state, sig: JSON.stringify(state), label, motionFiles };
  }

  // 写しのとおりにする
  private async restore(step: Step) {
    const { world, library } = this;
    const { state } = step;
    this.restoring = true;
    try {
      library.restore(state.materials as MaterialData[]);
      const ids = new Set(state.objects.map(o => o.id));
      for (const o of [...world.objects]) if (!ids.has(o.id)) world.remove(o);
      const back: ModelObj[] = [];
      state.objects.forEach((st, i) => {
        const obj = world.find(st.id) ?? this.removed.get(st.id);
        if (!obj || world.has(obj)) return;
        Object.assign(obj, { slots: [...st.slots] });
        world.restore(obj, i);
        this.removed.delete(obj.id);
        if (isModel(obj)) back.push(obj);
      });
      world.reorder(state.objects.map(o => o.id));
      for (const st of state.objects) {
        const obj = world.find(st.id);
        if (!obj) continue;
        Object.assign(obj, { x: st.x, y: st.y, py: st.y, vy: 0, z: st.z, r: st.r, c: st.c });
        st.slots.forEach((id, k) => { if (obj.slots[k] !== id) world.setSlot(obj, k, id); });
        if (st.light && JSON.stringify(obj.light) !== JSON.stringify(st.light)) this.lights.set(obj, st.light);
        if (JSON.stringify(obj.deformers ?? null) !== JSON.stringify(st.deformers ?? null)) this.deformers.set(obj, st.deformers ? structuredClone(st.deformers) : []);
        if (JSON.stringify(obj.cloner ?? null) !== JSON.stringify(st.cloner ?? null)) this.cloners.set(obj, st.cloner ? structuredClone(st.cloner) : null);
        if (!isModel(obj)) continue;
        obj.anim = st.anim ? animationFromJson(st.anim) : null;
        if (st.pose) obj.pose = new Map(st.pose.map(([b, v]) => [b, { ...v }]));
        const inf: number[] | undefined = obj.model.morphTargetInfluences;
        if (st.morphs && inf) st.morphs.forEach((v, k) => { if (!obj.anim?.morphs.has(k)) inf[k] = v; });
      }
      library.prune(new Set(state.materials.map(m => (m as MaterialData).id)));
      this.clock.setRange(state.range[0], state.range[1]);
      if (state.scene && JSON.stringify(state.scene) !== JSON.stringify(this.environment.settings)) this.environment.replace(state.scene as SceneSettings);
      // 置き直したモデルは、物理演算とモーションを付け直す
      for (const obj of back) {
        await this.physics.start(obj);
        const file = step.motionFiles.get(obj.id);
        if (file && !obj.animated) await this.motion.load([file], [obj]);
      }
      for (const st of state.objects) {
        const obj = world.find(st.id);
        if (!obj || !isModel(obj)) continue;
        if (st.hairHang !== undefined && st.hairHang !== null) this.physics.setHairHang(obj, st.hairHang);
        void this.posing.solve(obj);
      }
      this.keyframes.applyAll(this.clock.t, true);
      world.settle();
      if (this.selection.current && !world.has(this.selection.current)) this.selection.select(null);
      this.selection.publish();
      for (const k of ['modelVersion', 'keysVersion', 'materialsVersion', 'values'] as const) this.ui.bump(k);
      this.viewport.requestDraw();
    } finally {
      this.restoring = false;
      clearTimeout(this.timer);
      this.pending = false;
    }
  }

  // どの写しにも出てこない、消した物を片付ける
  private collect() {
    const used = new Set(this.steps.flatMap(s => s.state.objects.map(o => o.id)));
    for (const [id, obj] of this.removed) {
      if (used.has(id) || this.world.has(obj)) continue;
      this.world.dispose(obj);
      this.removed.delete(id);
    }
  }

  private publish() {
    this.ui.set({ history: { labels: this.steps.map(s => s.label), index: this.index } });
  }
}
