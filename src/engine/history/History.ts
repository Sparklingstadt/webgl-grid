import { Emitter } from '../../core/events';
import { animationFromJson, animationToJson, isEmpty, PROPS } from '../../core/animation';
import { describeChange, type ObjState, type SceneState } from '../../core/history';
import { msg, t } from '../../core/i18n';
import type { Clock } from '../anim/Clock';
import type { Addons } from '../addons/Addons';
import { applyObjectData, same } from '../addons/registry';
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

interface Step { state: SceneState; sig: string; label: string; motionFiles: Map<number, File[]> }
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
  readonly events = new Emitter<{ changed: []; restored: [] }>(); // 手が増えた・戻した (自動保存のきっかけ)・写しのとおりにした

  constructor(private world: World, private library: MaterialLibrary, private physics: Physics, private motion: Motion,
              private posing: Posing, private keyframes: Keyframes, private clock: Clock, private selection: Selection,
              private viewport: Viewport, private ui: UiChannel, private addons: Addons) {
    world.keepRemoved = true;
    world.events.on('removed', obj => { this.removed.set(obj.id, obj); this.soon(); });
    world.events.on('added', () => this.soon());
    library.events.on('changed', () => this.soon());
    // アドオンの値の登録が増減したら、いまの写しを取り直す (増えた値を、変化と数えない)
    for (const r of [addons.objectData, addons.sceneData]) r.events.on('changed', () => this.rebase());
    this.reset();
  }

  get canUndo() { return this.index > 0; }
  get canRedo() { return this.index < this.steps.length - 1; }

  // 写しを 1 つだけにする (最初の状態に戻した・プロジェクトを開いた)。持っていた消した物は片付ける
  reset() {
    clearTimeout(this.timer);
    this.pending = false;
    this.steps = [this.capture(msg('最初'))];
    this.index = 0;
    this.collect();
    this.publish();
  }

  // 本体の、物でない場面の値 (ステージ・カメラモーションが付いているか)。プロジェクトには入れず、元に戻すだけに使う
  private extras: { key: string; label: string; save(): unknown; load(v: unknown): void }[] = [];
  addExtra(def: { key: string; label: string; save(): unknown; load(v: unknown): void }) {
    this.extras.push(def);
    this.rebase();
  }

  private rebase() {
    const cur = this.steps[this.index];
    if (cur && !this.restoring) this.steps[this.index] = this.capture(cur.label);
  }

  // ひと区切りついたら写しを取る (少し待って、続けて起きた変化をまとめる)。押さえているあいだは待つ
  soon() {
    if (this.restoring) return;
    this.pending = true;
    clearTimeout(this.timer);
    if (!this.waiting) this.timer = setTimeout(() => this.checkpoint(), 60);
  }
  private get waiting() { return this.holds > 0 || this.pressed; }
  // マウスのボタン (指) を押しているあいだは写しを取らない (ドラッグを 1 手にまとめる)。離したら取る。
  // 押し始めたときに、前の操作の変化がまだ手になっていなければ、先に 1 手にする (すぐ続けたドラッグと混ぜない)
  setPressed(on: boolean) {
    if (this.pressed === on) return;
    if (on && this.pending) this.checkpoint();
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
    const pairs = <T extends { key: string; label: string }>(l: T[]) => l.map(x => [x.key, x.label] as [string, string]);
    next.label = describeChange(cur.state, next.state, { objectData: pairs(this.addons.objectData.list()), sceneData: [...pairs(this.historySceneData), ...this.extras.map(x => [`@${x.key}`, x.label] as [string, string])] });
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
      this.ui.toast(delta < 0 ? t('元に戻す: {label}', { label: t(label) }) : t('やり直す: {label}', { label: t(label) }), 1500);
      this.events.emit('changed');
    });
    return this.queue;
  }

  // --- 写し ---
  private capture(label: string): Step {
    const motionFiles = new Map<number, File[]>();
    const objects: ObjState[] = this.world.objects.map(o => {
      const data: Record<string, unknown> = {};
      for (const d of this.addons.objectData.list()) { const v = d.get(o); if (v !== undefined && v !== null) data[d.key] = structuredClone(v); }
      // キーのある位置・回転・大きさは、いまのフレームで決まるので入れない (再生しただけで手にならないように)
      const anim = o.anim;
      const keyed = (k: string) => !!anim?.props.has(PROPS.findIndex(p => p.key === k));
      if (keyed('scale')) delete data.scale;
      // (ライトの強さ・色・高さ、カメラの視野角・高さも同じ)
      const light = data.light as { type: string; power: number; strength: number; color: string; height: number } | undefined;
      if (light && keyed('power')) light[light.type === 'sun' ? 'strength' : 'power'] = 0;
      if (light && (keyed('colorR') || keyed('colorG') || keyed('colorB'))) light.color = '#000000';
      const camera = data.camera as { fov: number; height: number } | undefined;
      if (camera && keyed('fov')) camera.fov = 0;
      if (keyed('height')) { if (light) light.height = 0; if (camera) camera.height = 0; }
      const st: ObjState = { id: o.id, parent: o.parent ?? null, s: o.s, x: keyed('x') ? 0 : o.x, y: keyed('x') || keyed('z') || keyed('height') ? 0 : o.y, z: keyed('z') ? 0 : o.z, r: keyed('r') ? 0 : o.r, c: o.c, slots: [...o.slots], data };
      if (!isModel(o)) { st.anim = isEmpty(anim) ? null : animationToJson(anim!); return st; }
      // キーのあるボーン・表情の値も、同じく入れない
      st.pose = [...(o.pose ?? [])].filter(([i]) => !anim?.bones.has(i)).map(([i, v]) => [i, { ...v }]);
      const inf: number[] | undefined = o.model.morphTargetInfluences;
      if (!o.animated && inf) st.morphs = Array.from(inf).map((v, m) => (anim?.morphs.has(m) ? 0 : v));
      st.anim = isEmpty(anim) ? null : animationToJson(anim!);
      st.hairHang = this.physics.hairHang(o);
      st.ikOff = [...(o.ikOff ?? [])].sort((a, b) => a - b);
      st.motion = o.motionFiles?.map(f => f.name).join('\0') || null;
      if (o.motionFiles?.length) motionFiles.set(o.id, o.motionFiles);
      return st;
    });
    const data = Object.fromEntries([...this.historySceneData.map(d => [d.key, structuredClone(d.save())]), ...this.extras.map(x => [`@${x.key}`, x.save()])]);
    const state: SceneState = { objects, materials: this.library.snapshot(), range: [this.clock.start, this.clock.end], data };
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
        Object.assign(obj, { x: st.x, y: st.y, py: st.y, vy: 0, z: st.z, r: st.r, c: st.c, parent: st.parent ?? undefined });
        st.slots.forEach((id, k) => { if (obj.slots[k] !== id) world.setSlot(obj, k, id); });
        for (const d of this.addons.objectData.list()) applyObjectData(d, obj, st.data[d.key]);
        obj.anim = st.anim ? animationFromJson(st.anim) : null; // (キーのある値は、下の applyAll でいまのフレームの値にする)
        if (!isModel(obj)) continue;
        if (st.pose) obj.pose = new Map(st.pose.map(([b, v]) => [b, { ...v }]));
        const inf: number[] | undefined = obj.model.morphTargetInfluences;
        if (st.morphs && inf) st.morphs.forEach((v, k) => { if (!obj.anim?.morphs.has(k)) inf[k] = v; });
      }
      library.prune(new Set(state.materials.map(m => (m as MaterialData).id)));
      this.clock.setRange(state.range[0], state.range[1]);
      for (const d of this.historySceneData) if (d.key in state.data && !same(d.save(), state.data[d.key])) d.load(structuredClone(state.data[d.key]));
      for (const x of this.extras) if (`@${x.key}` in state.data && !same(x.save(), state.data[`@${x.key}`])) x.load(state.data[`@${x.key}`]);
      // 置き直したモデルは、物理演算とモーションを付け直す
      for (const obj of back) {
        await this.physics.start(obj);
        const files = step.motionFiles.get(obj.id);
        if (files && !obj.animated) await this.motion.load(files, [obj]);
      }
      for (const st of state.objects) {
        const obj = world.find(st.id);
        if (!obj || !isModel(obj)) continue;
        if (st.hairHang !== undefined && st.hairHang !== null) this.physics.setHairHang(obj, st.hairHang);
        obj.ikOff = new Set(st.ikOff ?? []);
        this.posing.applyIkSwitch(obj);
        void this.posing.solve(obj);
      }
      this.keyframes.applyAll(this.clock.t, true);
      world.settle();
      if (this.selection.current && !world.has(this.selection.current)) this.selection.select(null);
      this.selection.publish();
      for (const k of ['modelVersion', 'keysVersion', 'materialsVersion', 'values', 'sceneVersion'] as const) this.ui.bump(k);
      this.events.emit('restored'); // (コレクションの表示・親の位置を合わせ直す)
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

  private get historySceneData() { return this.addons.sceneData.list().filter(p => p.history); }

  private publish() {
    this.ui.set({ history: { labels: this.steps.map(s => s.label), index: this.index } });
  }
}
