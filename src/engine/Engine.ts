import { animationFromJson, animationToJson, channelKeys, isEmpty, keyFrames, type Channel, type Curve } from '../core/animation';
import { radiusOf } from '../core/stacking';
import { applyObjectData } from './addons/registry';
import type { LightSettings, LightType } from '../core/light';
import { FPS } from '../core/constants';
import { SONG_FILE } from '../core/models';
import { errorText } from '../core/errors';
import { langEvents, t } from '../core/i18n';
import { patchPmxMaterials } from '../core/pmxMaterials';
import type { BoneValue } from '../core/types';
import * as THREE from 'three';
import { Clock } from './anim/Clock';
import { Keyframes } from './anim/Keyframes';
import { Music } from './anim/Music';
import { History } from './history/History';
import { download } from './io/download';
import { MaterialEditor } from './materials/MaterialEditor';
import { MaterialLibrary } from './materials/MaterialLibrary';
import { toPmxValues } from './materials/toPmx';
import { MmdLoader } from './mmd/MmdLoader';
import { Motion } from './mmd/Motion';
import { Physics } from './mmd/Physics';
import { PoseEditor } from './mmd/PoseEditor';
import { Posing } from './mmd/Posing';
import { Stage } from './mmd/Stage';
import { VpdIO } from './mmd/VpdIO';
import { RenderOutput } from './output/RenderOutput';
import { Autosave } from './project/Autosave';
import { ProjectIO } from './project/ProjectIO';
import { RemoteLink } from './remote/RemoteLink';
import { Addons } from './addons/Addons';
import { registerBuiltins } from './addons/builtins';
import { Effects } from './render/Effects';
import { Environment } from './render/Environment';
import { SceneGraph } from './render/SceneGraph';
import { Viewport } from './render/Viewport';
import { isModel, isShape, type ModelObj, type Obj } from './types';
import { UiChannel } from './UiChannel';
import { CameraController } from './view/CameraController';
import { InputController } from './view/InputController';
import { TransformTool } from './view/TransformTool';
import { Lights } from './world/Lights';
import { nameOf } from './world/Selection';
import { ColorPicker } from './world/ColorPicker';
import { Selection } from './world/Selection';
import { World } from './world/World';

// タイムラインに並べる行: 選んでいる物 (モデルならキーフレームとモーション)・そのチャンネル (広げたとき) と、カメラモーション
export interface TlRow { label: string; keys: number[]; motion: Int32Array | null; editable: boolean; channel?: Channel }

const MAX_NAME = 64;
// ビューポート (rendering: レンダリング) に写すか
const shownIn = (o: Obj, rendering: boolean) => !(rendering ? o.hideRender : o.hidden);

const isAudio = (f: File) => f.type.startsWith('audio/') || SONG_FILE.test(f.name);

// --- エンジン: 各部を組み立ててつなぎ、画面 (React) に操作の窓口を出す ---
// 各部は、使う相手をコンストラクタで受け取り、知らせたいことはイベントで出す。
// 複数の部分にまたがる操作 (ファイルの読み込み・選んでいるモデルの編集など) は、ここに書く。
// 1 つの部分で済む操作は、画面から直接その部分を呼んでよい (engine.clock.togglePlay() など)
export class Engine {
  readonly ui = new UiChannel();
  // アドオン: 一覧・有効にする・登録したもの (物ごとの値・場面の値・命令・メニュー・パネル。本体の機能も同じ形で登録する)。
  // 始めるのは main.tsx の addons.start
  readonly addons = new Addons(this);
  readonly graph = new SceneGraph();
  readonly viewport = new Viewport(this.graph);
  readonly library = new MaterialLibrary();
  readonly world = new World(this.graph, this.viewport, this.ui, this.library);
  readonly selection = new Selection(this.world, this.ui);
  readonly lights = new Lights(this.world, this.viewport);
  readonly materials = new MaterialEditor(this.library, this.world, this.selection, this.ui);
  readonly picker = new ColorPicker(this.world, this.viewport, this.ui);
  readonly camera = new CameraController(this.graph, this.viewport, this.ui, this.world);
  readonly physics = new Physics(this.world, this.viewport, this.ui);
  readonly stage = new Stage(this.graph, this.viewport, this.library);
  readonly motion = new Motion(this.world, this.physics, this.stage, this.camera, this.ui);
  readonly posing = new Posing(this.world, this.physics, this.motion, this.viewport, this.ui);
  readonly pose = new PoseEditor(this.graph, this.viewport, this.selection, this.posing, this.physics, this.ui); // ポーズモード (ボーンをビューポートで動かす)
  readonly clock = new Clock();
  readonly keyframes = new Keyframes(this.world, this.posing, this.viewport, this.ui);
  readonly music = new Music(this.ui, () => this.clock.playing);
  // 書き出すファイルの名前の元: プロジェクトの名前、なければ選んでいるモデルの名前
  readonly output = new RenderOutput(this.viewport, this.graph, this.clock, this.music, this.ui,
    () => this.ui.state.projectName ?? this.selection.model?.model.name ?? t('レンダー'));
  readonly environment = new Environment(this.graph, this.viewport, this.ui);
  readonly effects = new Effects(this.viewport, this.ui, () => this.camera.focusPoint());
  readonly loader = new MmdLoader(this.ui, this.library, () => this.viewport.requestDraw());
  readonly vpd = new VpdIO(this.posing, this.viewport, this.ui);
  readonly history = new History(this.world, this.library, this.physics, this.motion, this.posing, this.keyframes, this.clock, this.selection, this.viewport, this.ui, this.addons);
  readonly transform = new TransformTool(this.world, this.selection, this.camera, this.graph, this.viewport, this.history, this.ui); // G・R・S
  readonly project = new ProjectIO(this);
  readonly autosave = new Autosave(this.project, this.history, this.ui);
  readonly remote = new RemoteLink(this);
  input: InputController | null = null;

  constructor() {
    const { viewport, clock, motion, keyframes, music, world, selection, camera, graph, ui } = this;
    registerBuiltins(this);
    // 言語を変えたら、エンジンが作った文 (選んでいる物の名前・ビューポート左上の文字・タイムラインの行) を作り直す
    langEvents.on('changed', () => { selection.publish(); ui.bump('keysVersion'); viewport.requestDraw(); });
    // 毎フレームの計算の順番: 再生 → モーション → 手で動かしたボーン → 物理演算 → 落下
    for (const s of [clock, motion, this.posing, this.physics, world]) viewport.addSystem(s);
    motion.isPlaying = () => clock.playing;

    // タイムラインの時刻に、モーション・キーフレーム・曲を合わせる
    clock.source = music;
    clock.events.on('seek', (t, warmup) => {
      motion.seek(t, warmup);
      keyframes.applyAll(t, true);
      music.syncTo(t, clock.playing);
      viewport.startTicking();
      viewport.requestDraw();
    });
    clock.events.on('advance', d => {
      motion.advance(d);
      keyframes.applyAll(clock.t);
    });
    clock.events.on('play', on => {
      music.setPlaying(on, clock.t);
      viewport.startTicking();
    });
    clock.events.on('change', () => ui.set({ frame: clock.frame, playing: clock.playing, start: clock.start, end: clock.end }));
    music.events.on('loaded', () => this.fitEndToContent());
    music.events.on('playing', () => viewport.startTicking());
    // 置いた物が増えた・減った (アウトライナーを描き直す)
    for (const ev of ['added', 'removed'] as const) world.events.on(ev, () => ui.bump('sceneVersion'));
    selection.events.on('changed', () => { keyframes.clearSelection(); ui.bump('materialsVersion'); ui.set({ rigShown: this.physics.rigShown(selection.model) }); });
    this.library.events.on('changed', () => { ui.bump('materialsVersion'); viewport.requestDraw(); });

    // 描く前: カメラ・物の位置・掴んでいる物の明るさ・選択の輪郭線・影の範囲
    viewport.onBeforeRender(() => {
      camera.update();
      world.sync();
      // (レンダリング中は、掴んでいる物の明るさと選択の輪郭線を出さない)
      const rendering = this.output.active;
      const held = rendering ? null : this.input?.held ?? this.picker.target;
      for (const o of world.objects) {
        world.setHighlight(o, !!held && o === held);
        o.node.visible = shownIn(o, rendering);
      }
      selection.syncOutlines(world.objects, rendering);
      graph.aimShadows(camera.cam.tx, camera.cam.tz, camera.cam.dist);
    });
    // 描いたあと: 選んでいる物の情報と、ビューポート左上の文字 (Blender の「ユーザー・透視投影」と「(フレーム) 選んでいる物」)
    viewport.onRender(() => {
      selection.publish();
      const what = camera.override ? t('カメラ') : camera.viewName ? t(camera.viewName) : t('ユーザー');
      ui.set({
        viewInfo: `${t('{view}・透視投影', { view: what })}\n(${clock.frame}) ${ui.state.sel?.name ?? ''}`,
        hairHang: selection.model ? this.physics.hairHang(selection.model) : null,
      });
    });

    clock.reset(); // (最初は何も置かない)
    this.history.reset();
  }

  // --- 描画先 (React の部品が canvas を用意したとき・片付けるとき) ---
  mount(canvas: HTMLCanvasElement, container: HTMLElement) {
    if (!this.viewport.mount(canvas, container)) { this.ui.toast(t('WebGL2 に対応していません'), 0); return; }
    this.pose.mount(canvas); // (ギズモは、ほかの操作より先にポインターを受け取る)
    this.unmountTransform = this.transform.mount();
    this.input = new InputController(canvas, this.viewport, this.world, this.camera, this.selection, this.picker, {
      placeShape: (x, z) => this.placeShape(x, z),
      pose: {
        active: () => this.pose.active,
        busy: () => this.pose.busy,
        pick: (x, y) => { const b = this.pose.pickBone(x, y); if (b === null) return false; this.pose.selectBone(b); return true; },
      },
      remove: obj => this.world.remove(obj),
      contextMenu: (x, y) => this.openContextMenu(x, y),
      box: {
        active: () => this.ui.state.boxSelect,
        show: box => this.ui.set({ box }),
        done: (x0, y0, x1, y1, extend) => { this.ui.set({ boxSelect: false }); this.boxSelect(x0, y0, x1, y1, extend); },
      },
      userGesture: () => this.music.resume(), // 自動再生を止められていた曲は、画面を触ったときに再生する
    });
    this.effects.restore();
  }
  private unmountTransform: (() => void) | null = null;
  unmount() {
    this.unmountTransform?.();
    this.unmountTransform = null;
    this.pose.unmount();
    this.input?.dispose();
    this.input = null;
    this.effects.reset();
    this.viewport.unmount();
  }

  // --- 置いた物 ---
  // 追加 > 立方体など: 画面中央 (注視点) の近くに置いて、それを選ぶ
  private lastShape = 0;
  addShape(s: number) {
    this.lastShape = s;
    if (this.world.full) return;
    const [x, z] = this.world.findFreeSpot(Math.SQRT1_2, this.camera.cam.tx, this.camera.cam.tz);
    this.selection.select(this.world.addShape(s, x, z));
    this.viewport.requestDraw();
  }
  // スマホで地面を長押しした所に、最後に追加した形を置く (ほかの物と重なればその上に積む)
  placeShape(x: number, z: number) {
    if (this.world.full) return false;
    const obj = this.world.addShape(this.lastShape, x, z);
    this.world.dropIn(obj);
    this.selection.select(obj);
    return true;
  }
  select(obj: Obj | null) { this.selection.select(obj); this.viewport.requestDraw(); }
  selectById(id: number | null) { this.select(this.world.find(id)); }
  // X: 選んでいる物を全部消す
  deleteSelected() { for (const o of this.selection.list) this.world.remove(o); }
  // --- 選択 (Blender の「選択」のメニュー): すべて (A)・なし (Alt+A)・反転 (Ctrl+I)・ボックス選択 (B) ---
  // (隠している物は選ばない)
  selectAll() { const all = this.world.objects.filter(o => !o.hidden); this.selection.setMany(all, this.selection.current && all.includes(this.selection.current) ? this.selection.current : all.at(-1) ?? null); this.viewport.requestDraw(); }
  invertSelection() {
    const next = this.world.objects.filter(o => !o.hidden && !this.selection.isSelected(o));
    this.selection.setMany(next, next.at(-1) ?? null);
    this.viewport.requestDraw();
  }
  // Alt+G・Alt+R・Alt+S: 選んでいる物の位置 (原点へ)・回転・大きさを元に戻す (Blender の「クリア」)
  clearTransform(what: 'location' | 'rotation' | 'scale') {
    const list = this.selection.list;
    if (!list.length) return;
    for (const o of list) {
      if (what === 'location') { o.x = 0; o.z = 0; }
      else if (what === 'rotation') o.r = 0;
      else if (isShape(o)) o.scale = undefined;
    }
    this.world.settle();
    this.selection.publish();
    this.history.soon();
    this.viewport.requestDraw();
  }

  // ビューポートの右クリック: 押した物を (選んでいなければ) 選んで、メニューを出す
  openContextMenu(x: number, y: number) {
    if (this.pose.active || this.transform.active) return;
    const picked = this.camera.pick(this.camera.screenRay(x, y))?.obj;
    if (picked && !this.selection.isSelected(picked)) this.select(picked);
    else if (picked) this.selection.setActive(picked);
    this.ui.set({ contextMenu: { x, y } });
  }
  closeContextMenu() { if (!this.ui.state.contextMenu) return false; this.ui.set({ contextMenu: null }); return true; }

  // B: 次のドラッグで四角を描いて選ぶ。Esc でやめる
  startBoxSelect() { this.ui.set({ boxSelect: true }); }
  cancelBoxSelect() { if (!this.ui.state.boxSelect) return false; this.ui.set({ boxSelect: false, box: null }); return true; }
  // 画面の四角 (クライアント座標) の中に、中心が見えている物を選ぶ (extend: いまの選択に足す)
  boxSelect(x0: number, y0: number, x1: number, y1: number, extend = false) {
    const canvas = this.viewport.canvas;
    if (!canvas) return;
    const r = canvas.getBoundingClientRect(), cam = this.graph.camera, v = new THREE.Vector3();
    const [l, rr, top, bottom] = [Math.min(x0, x1), Math.max(x0, x1), Math.min(y0, y1), Math.max(y0, y1)];
    const hits = this.world.objects.filter(o => {
      if (o.hidden) return false;
      v.set(o.x, o.py + o.h * (o.scale ?? 1) / 2, o.z).project(cam);
      if (v.z > 1) return false; // (カメラの後ろ)
      const sx = r.left + (v.x + 1) / 2 * r.width, sy = r.top + (1 - v.y) / 2 * r.height;
      return sx >= l && sx <= rr && sy >= top && sy <= bottom;
    });
    this.selection.setMany(hits, hits.at(-1) ?? (extend ? this.selection.current : null), extend);
    this.viewport.requestDraw();
  }
  // サイドバーの「オブジェクト」から位置・向き・色を変える
  setObjProp(key: 'x' | 'z' | 'r', v: number) {
    const o = this.selection.current;
    if (!o || !Number.isFinite(v)) return;
    if (key === 'r') o.r = v * Math.PI / 180;
    else o[key] = v;
    this.world.settle();
    this.viewport.requestDraw();
  }
  // --- ライト (Blender のライト) ---
  // 画面中央の近くに置いて選ぶ
  addLight(type: LightType, settings: Partial<LightSettings> = {}) {
    if (this.world.full) return null;
    const [x, z] = this.world.findFreeSpot(0.3, this.camera.cam.tx, this.camera.cam.tz);
    const obj = this.lights.add({ ...settings, type }, x, z);
    this.selection.select(obj);
    this.viewport.requestDraw();
    return obj;
  }
  setLight(patch: Partial<LightSettings>) {
    const o = this.selection.current;
    if (!o?.light) return;
    this.lights.set(o, patch);
    this.selection.publish();
  }

  // --- 複製 (Shift+D。Blender と同じく、マテリアルは元と共有し、名前に番号を付ける) ---
  // 隣の空いている場所に置いて、新しい方を選ぶ。向き・表示・物ごとの値 (ライト・アドオン) も写す。
  // MMD モデルは同じファイルから読み直し、ポーズ・表情・キーフレーム・モーション・IK・髪も写す。元に戻すでは 1 手
  // (選んでいる物が いくつかなら全部。新しい方を選び、アクティブの複製をアクティブに)
  duplicateSelected(): Promise<Obj | null> {
    const list = this.selection.list, active = this.selection.current;
    if (!list.length) return Promise.resolve(null);
    if (this.world.full) { this.ui.toast(t('これ以上置けません')); return Promise.resolve(null); }
    return this.history.batch(async () => {
      const made = new Map<Obj, Obj>();
      for (const src of list) {
        if (this.world.full) break;
        const obj = await this.duplicateOne(src);
        if (obj) made.set(src, obj);
      }
      if (!made.size) return null;
      const copies = [...made.values()];
      this.selection.setMany(copies, (active && made.get(active)) ?? copies.at(-1)!);
      this.objChanged();
      return (active && made.get(active)) ?? copies.at(-1)!;
    });
  }
  private async duplicateOne(src: Obj): Promise<Obj | null> {
    {
      const [x, z] = this.world.findFreeSpot(radiusOf(src), src.x + 1, src.z);
      let obj: Obj;
      if (isModel(src)) {
        const files: File[] = [...(src.model.userData.usedFiles ?? [src.model.userData.sourceFile])].filter(Boolean);
        const loaded = files.length ? await this.loader.load(files, { ask: false }) : null;
        if (!loaded || !this.world.has(src)) return null;
        const m = this.world.addModel(loaded.mesh, x, z, loaded.slots);
        src.slots.forEach((id, i) => { if (m.slots[i] !== id) this.world.setSlot(m, i, id); });
        await this.physics.start(m);
        m.pose = new Map([...(src.pose ?? [])].map(([b, v]) => [b, { ...v }]));
        const from: number[] | undefined = src.model.morphTargetInfluences, to: number[] | undefined = m.model.morphTargetInfluences;
        if (from && to) from.forEach((v, i) => { to[i] = v; });
        m.anim = isEmpty(src.anim) ? null : animationFromJson(animationToJson(src.anim!));
        m.ikOff = src.ikOff ? new Set(src.ikOff) : undefined;
        if (src.motionFiles?.length) { await this.motion.load(src.motionFiles, [m]); this.motion.seek(this.clock.t, 0); }
        this.posing.applyIkSwitch(m);
        const hang = this.physics.hairHang(src);
        if (hang) this.physics.setHairHang(m, true);
        void this.posing.solve(m);
        obj = m;
      } else if (src.light) {
        obj = this.lights.add({ ...src.light }, x, z);
      } else {
        obj = this.world.addShape(src.s, x, z, src.c);
        src.slots.forEach((id, i) => this.world.setSlot(obj, i, id));
      }
      obj.r = src.r;
      // 物ごとの値 (表示・アドオンの値。名前は下で番号を付ける)
      for (const d of this.addons.objectData.list()) {
        if (d.key === 'name' || d.key === 'light') continue;
        const v = d.get(src);
        if (v !== undefined && v !== null) applyObjectData(d, obj, structuredClone(v));
      }
      obj.name = this.nextName(nameOf(src));
      this.world.settle();
      return obj;
    }
  }
  // 「名前.001」から始めて、使われていない番号の名前 (Blender と同じ)
  private nextName(name: string) {
    const base = name.replace(/\.\d{3,}$/, '');
    const used = new Set(this.world.objects.map(nameOf));
    for (let n = 1; ; n++) {
      const next = `${base}.${String(n).padStart(3, '0')}`;
      if (!used.has(next)) return next;
    }
  }

  // 大きさ (拡大率。形だけ: MMD モデルは物理演算の剛体が合わなくなり、ライトは目印だけなので変えない)
  setScale(obj: Obj, k: number) {
    if (!isShape(obj) || !Number.isFinite(k)) return;
    const v = Math.min(Math.max(k, 0.05), 20);
    if ((obj.scale ?? 1) === v) return;
    obj.scale = v === 1 ? undefined : v;
    this.world.settle();
    this.selection.publish();
    this.history.soon();
    this.viewport.requestDraw();
  }

  // --- 名前・表示 (アウトライナー・サイドバー・H / Alt+H) ---
  // 名前を付ける (空・null で種類の名前に戻す)
  renameObj(obj: Obj, name: string | null) {
    const n = name?.trim().slice(0, MAX_NAME) || undefined;
    if (obj.name === n) return;
    obj.name = n;
    this.objChanged();
  }
  // ビューポートで隠す・レンダリングに写さない (Blender の目とカメラのアイコン)。隠した物は選択を外す
  setVisibility(obj: Obj, patch: { hidden?: boolean; hideRender?: boolean }) {
    let changed = false;
    for (const k of ['hidden', 'hideRender'] as const) {
      if (patch[k] === undefined || !!obj[k] === patch[k]) continue;
      obj[k] = patch[k] || undefined;
      changed = true;
    }
    if (!changed) return;
    obj.node.visible = shownIn(obj, false); // (すぐにクリックで選べなくなるよう、描く前にも合わせる)
    if (obj.hidden) this.selection.deselect(obj);
    this.objChanged();
  }
  // H: 選んでいる物を隠す、Shift+H: ほかを隠す、Alt+H: 全部見せる
  hideSelected(others = false) {
    if (!this.selection.selected.size) return;
    for (const o of [...this.world.objects]) if (this.selection.isSelected(o) !== others) this.setVisibility(o, { hidden: true });
  }
  revealAll() { for (const o of this.world.objects) this.setVisibility(o, { hidden: false }); }
  // 並べ替え (アウトライナーでドラッグ): obj を target の前 (後) に。並びは一覧の順で、積み重ねは変えない
  moveObject(obj: Obj, target: Obj, where: 'before' | 'after') {
    if (obj === target) return;
    const ids = this.world.objects.filter(o => o !== obj).map(o => o.id);
    const at = ids.indexOf(target.id);
    if (at < 0) return;
    ids.splice(where === 'before' ? at : at + 1, 0, obj.id);
    this.setOrder(ids);
  }
  // ids の順に並べる (ない物は後ろに、元の順で)
  setOrder(ids: number[]) {
    const before = this.world.objects.map(o => o.id).join();
    this.world.reorder(ids);
    if (this.world.objects.map(o => o.id).join() !== before) this.objChanged();
  }
  private objChanged() {
    this.ui.bump('sceneVersion');
    this.selection.publish();
    this.history.soon();
    this.viewport.requestDraw();
  }

  setObjColor(c: number) {
    const o = this.selection.current;
    if (!isShape(o)) return;
    this.world.setShapeColor(o, c);
    this.viewport.requestDraw();
  }

  // --- ファイルの読み込み ---
  // .pmx (とテクスチャ)・.vmd (いくつでも)・.vpd・曲をまとめて受け取る。
  // .vmd だけ・曲だけのときは、置いてあるモデル全員に付ける
  // (読み込み終わってから 1 手にする)
  // askTextures: .pmx のテクスチャが見つからなければ、置く前に探してもらう (画面から読むとき。MCP では聞かない)
  // toSelected: .vmd・.vpd・曲だけのとき、選んでいるモデルがあればそれだけに付ける (なければ全員)
  loadFiles(files: File[], opts: { askTextures?: boolean; toSelected?: boolean } = {}) {
    return this.history.batch(() => this.loadFilesNow(files, opts.askTextures ?? true, opts.toSelected ?? false));
  }
  private async loadFilesNow(files: File[], askTextures: boolean, toSelected: boolean) {
    const { world, ui } = this;
    this.project.remember(files); // 参照だけのプロジェクトを開くときに使う
    const vmds = files.filter(f => /\.vmd$/i.test(f.name));
    const vpd = files.find(f => /\.vpd$/i.test(f.name));
    const song = files.find(isAudio);
    const pmx = files.find(f => /\.pmx$/i.test(f.name));
    let targets: ModelObj[];
    if (pmx) {
      if (world.full) return;
      // (フォルダごと選ばれて .pmx がいくつもあるときは、最初のもの)
      const loaded = await this.loader.load(files, { ask: askTextures });
      if (!loaded) return;
      const missing = (loaded.mesh.userData.missingTextureNames ?? []).length;
      const { mesh, slots } = loaded;
      if (loaded.isStage) {
        this.stage.set(mesh);
        ui.bump('sceneVersion');
        ui.toast(t('{name} をステージとして置きました', { name: pmx.name }));
        targets = world.models; // ステージを読んだときは、モーションは置いてある人物全員に付ける
      } else {
        // ステージがあるときは、ステージの中心 (MMD で人物が立つ原点) の近くに置く
        const atStage = !!this.stage.model;
        const obj = world.addModel(mesh, atStage ? 0 : this.camera.cam.tx, atStage ? 0 : this.camera.cam.tz, slots);
        this.selection.select(obj);
        await this.physics.start(obj);
        ui.toast(missing ? t('{name} を置きました (見つからないテクスチャが {n} 個あります。テクスチャの画像も一緒に選ぶと表示されます)', { name: pmx.name, n: missing }) : t('{name} を置きました', { name: pmx.name }), missing ? 8000 : 4000);
        targets = [obj];
      }
    } else if (vmds.length || song || vpd) {
      targets = toSelected && this.selection.model ? [this.selection.model] : world.models;
    } else {
      ui.toast(t('.pmx・.vmd・.vpd・曲のどれも選ばれていません。モデルの .pmx とテクスチャ画像、モーションの .vmd、ポーズの .vpd、曲のファイルを選んでください。'));
      return;
    }
    // ポーズ (.vpd) は、モデルを選んでいるならそのモデルに、そうでなければ対象のモデル全員に当てる
    if (vpd) await this.vpd.load(vpd, this.selection.model && !pmx ? [this.selection.model] : targets);
    let motionOk = true;
    if (vmds.length) {
      motionOk = await this.motion.load(vmds, targets);
      for (const m of targets) this.posing.applyIkSwitch(m); // (切った IK は、モーションの再生でも切っておく)
      if (motionOk) {
        // 終了フレームをモーション (と曲) の長さに合わせ、ダンス・カメラ・曲を最初からそろえて再生する
        this.fitEndToContent();
        this.restartPlayback();
        this.selection.publish();
        ui.bump('keysVersion');
        ui.bump('modelVersion');
      }
    }
    if (song) {
      this.music.load(song);
      this.restartPlayback();
      // モーションの読み込みに失敗したときは、そのお知らせを曲のお知らせで消さない
      if (motionOk) ui.toast(t('{name} を再生しています', { name: song.name }));
    }
  }
  private restartPlayback() {
    this.clock.seek(this.clock.start / FPS);
    this.clock.setPlaying(true);
  }
  // モーション・曲・キーフレームのうち一番長いものに、終了フレームを合わせる
  fitEndToContent() {
    this.clock.fitEnd(Math.max(this.motion.duration * FPS, this.keyframes.lastFrame(), (this.music.duration ?? 0) * FPS));
  }

  // ファイル > 最初の状態に戻す: 置いた物・読み込んだモデル・モーション・曲を消し、何もない場面と最初の視点に戻す
  resetAll() {
    this.music.stop();
    this.selection.select(null);
    this.picker.close();
    this.camera.resetView();
    this.world.clear();
    this.stage.clear();
    this.ui.bump('sceneVersion');
    this.clock.reset();
    for (const p of this.addons.sceneData.list()) p.reset?.();
    this.history.reset(); // 新しく始めるので、元に戻す履歴も消す
    this.viewport.requestDraw();
  }

  // --- 選んでいるモデルの表情・ボーン・ポーズファイル ---
  private get model() { return this.selection.model; }
  morphs() { return this.model ? this.posing.morphs(this.model) : []; }
  morphValue(i: number) { return this.model ? this.posing.morphValue(this.model, i) : 0; }
  setMorph(i: number, v: number) { if (this.model) this.posing.setMorph(this.model, i, v); }
  resetMorphs() { if (this.model) this.posing.resetMorphs(this.model); }
  boneGroups() { return this.model ? this.posing.boneGroups(this.model) : []; }
  boneSel() { return this.model ? this.posing.boneSel(this.model) : undefined; }
  setBoneSel(i: number) { if (this.model) this.posing.setBoneSel(this.model, i); }
  boneFlags(i: number) { return this.model ? this.posing.boneFlags(this.model, i) : 0; }
  boneValue(i: number) { return this.model ? this.posing.boneValue(this.model, i) : null; }
  boneNote(i: number) { return this.model ? this.posing.boneNote(this.model, i) : ''; }
  setBone(i: number, key: keyof BoneValue, v: number) { if (this.model) this.posing.setBone(this.model, i, key, v); }
  resetPose() { if (this.model) this.posing.resetPose(this.model); }
  // マテリアルを変えた .pmx を書き出す (MMD で表せる範囲。ほかの部分は元の .pmx のまま)
  async exportPmx() {
    const o = this.model;
    const file: File | undefined = o?.model.userData.sourceFile;
    if (!o || !file) { this.ui.toast(t('書き出す MMD モデルをクリックして選んでください。')); return; }
    try {
      const sources = o.model.userData.slotSources;
      const patches = new Map(o.slots.map((id, i) => [i, toPmxValues(id ? this.library.materials.get(id) ?? null : null, sources[i])]));
      const bytes = patchPmxMaterials(await file.arrayBuffer(), patches);
      const name = `${file.name.replace(/\.pmx$/i, '')}_edited.pmx`;
      download(bytes, name);
      this.ui.toast(t('{name} を書き出しました。テクスチャを読めるよう、元の .pmx と同じフォルダに置いてください', { name }), 6000);
    } catch (err) {
      console.error(err);
      this.ui.toast(t('書き出せませんでした: {error}', { error: errorText(err) }), 8000);
    }
  }
  // 髪の形を保つ錘を外して、髪を重力で垂らす (MMD とは見た目が変わる)
  // --- ポーズモード・IK・剛体と関節 ---
  togglePoseMode() { this.pose.setActive(!this.pose.active); }
  iks() { return this.model ? this.posing.iks(this.model) : []; }
  setIkEnabled(target: number, on: boolean) { if (this.model) this.posing.setIkEnabled(this.model, target, on); }
  showRig(on: boolean) { if (this.model) this.physics.showRig(this.model, on); }
  // ポーズモードの I: 選んでいるボーンにキーを打つ
  insertSelectedBoneKey() {
    const m = this.model, b = m ? this.posing.boneSel(m) : undefined;
    if (b === undefined) { this.insertKey(); return; }
    this.insertBoneKey(b);
  }

  setHairHang(on: boolean) {
    if (!this.model) return;
    this.physics.setHairHang(this.model, on);
    this.ui.set({ hairHang: this.physics.hairHang(this.model) });
    this.viewport.requestDraw();
  }
  savePose() {
    if (this.model) this.vpd.save(this.model);
    else this.ui.toast(t('ポーズを保存するモデルをクリックして選んでください。'));
  }
  // 選んでいるモデルに当てる (選んでいなければ、置いてあるモデル全員に)
  loadPoseFile(file: File) { return this.history.batch(() => this.vpd.load(file, this.model ? [this.model] : this.world.models)); }

  // --- キーフレーム ---
  // 選んでいるモデルの、いまのポーズと表情を、いまのフレームに記録する (I)
  insertKey() {
    const obj = this.model;
    if (!obj) { this.ui.toast(t('キーフレームを打つ MMD モデルをクリックして選んでください。')); return; }
    const f = this.clock.frame;
    // まだ何も動かしていない (キーもない) ときは、サイドバーで選んでいるボーンに打つ
    const inf: number[] | undefined = obj.model.morphTargetInfluences;
    const nothing = !obj.pose?.size && !keyFrames(obj.anim).length && !inf?.some(v => v !== 0);
    if (nothing) {
      const sel = this.posing.boneSel(obj);
      if (sel === undefined) { this.ui.toast(t('キーを打つボーンがありません。ボーンか表情を動かしてから打ってください')); return; }
      this.keyframes.insert(obj, f, [sel]);
    } else this.keyframes.insert(obj, f);
    if (f > this.clock.end) this.clock.setRange(this.clock.start, f);
  }
  // 選んでいるボーンだけに、いまのフレームのキーを打つ
  insertBoneKey(bone: number) {
    const obj = this.model;
    if (!obj) return;
    const f = this.clock.frame;
    this.keyframes.insert(obj, f, [bone]);
    if (f > this.clock.end) this.clock.setRange(this.clock.start, f);
  }
  deleteKeyHere(channel?: Channel) { if (this.model) this.keyframes.deleteAt(this.model, this.clock.frame, this.clock.t, channel); }
  // 選んでいるモデルの、チャンネルのいまのフレームのキーの補間曲線 (キーがなければ null)
  keyCurve(channel: Channel) { return this.model ? this.keyframes.curve(this.model, channel, this.clock.frame) : null; }
  setKeyCurve(channel: Channel, curve: Curve) { if (this.model) this.keyframes.setCurve(this.model, channel, this.clock.frame, curve, this.clock.t); }
  deleteSelectedKeys() { return this.model ? this.keyframes.deleteSelected(this.model, this.clock.t) : false; }
  moveSelectedKeys(delta: number) { if (this.model) this.keyframes.moveSelected(this.model, delta, this.clock.t); }
  selectKeys(frames: number[], add: boolean) { this.keyframes.select(frames, add); }

  // --- タイムライン ---
  timelineRows(): TlRow[] {
    const rows: TlRow[] = [];
    const obj = this.selection.current;
    if (this.model) {
      const m = this.model, anim = m.anim;
      rows.push({ label: nameOf(m), keys: keyFrames(anim), motion: m.motion?.frames ?? null, editable: true });
      if (anim && this.keyframes.expanded) {
        const sorted = (ch: Channel) => [...channelKeys(anim, ch)!.keys()].sort((a, b) => a - b);
        const morphName = new Map(this.posing.morphs(m).map(x => [x.index, x.name]));
        for (const b of [...anim.bones.keys()].sort((a, b) => a - b)) {
          const ch: Channel = { kind: 'bone', index: b };
          rows.push({ label: m.model.skeleton.bones[b]?.name ?? t('ボーン {n}', { n: b }), keys: sorted(ch), motion: null, editable: true, channel: ch });
        }
        for (const i of [...anim.morphs.keys()].sort((a, b) => a - b)) {
          const ch: Channel = { kind: 'morph', index: i };
          rows.push({ label: t('表情: {name}', { name: morphName.get(i) ?? i }), keys: sorted(ch), motion: null, editable: true, channel: ch });
        }
      }
    } else if (obj) {
      rows.push({ label: nameOf(obj), keys: [], motion: null, editable: false });
    }
    const cam = this.motion.camera;
    if (cam) rows.push({ label: t('カメラ'), keys: [], motion: cam.motion.frames, editable: false });
    return rows;
  }
  // 前後のキーフレーム (選んでいるモデルのキーフレームと、モーションのキーフレーム) へ
  jumpKey(dir: 1 | -1) {
    const f = this.clock.frame;
    const all = this.timelineRows().flatMap(r => [...r.keys, ...(r.motion ?? [])]);
    const next = dir > 0 ? Math.min(...all.filter(k => k > f)) : Math.max(...all.filter(k => k < f));
    if (Number.isFinite(next)) this.clock.seekFrame(next, 10);
  }
}
