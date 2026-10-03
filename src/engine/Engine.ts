import * as THREE from 'three';
import { FPS, SHAPE_NAMES } from '../core/constants';
import type { BoneValue } from '../core/types';
import { Clock } from './anim/Clock';
import { Keyframes } from './anim/Keyframes';
import { Music } from './anim/Music';
import type { NodeType, SocketValue } from '../core/materials/nodes';
import { addNode, connect, disconnect, findNode, removeNode, surfaceShader, whyNotConnect, type SocketRef } from '../core/materials/tree';
import { patchPmxMaterials } from '../core/pmxMaterials';
import { convertMmdMesh } from './materials/fromMmd';
import { MaterialLibrary, type MaterialData, type MaterialOutline, type MaterialSettings } from './materials/MaterialLibrary';
import { ProjectIO } from './project/ProjectIO';
import { toPmxValues } from './materials/toPmx';
import { MmdLoader } from './mmd/MmdLoader';
import { Motion } from './mmd/Motion';
import { Physics } from './mmd/Physics';
import { Posing } from './mmd/Posing';
import { Stage } from './mmd/Stage';
import { VpdIO } from './mmd/VpdIO';
import { Effects } from './render/Effects';
import { SceneGraph } from './render/SceneGraph';
import { Viewport } from './render/Viewport';
import type { ModelObj, Obj } from './types';
import { UiChannel } from './UiChannel';
import { CameraController } from './view/CameraController';
import { InputController } from './view/InputController';
import { ColorPicker } from './world/ColorPicker';
import { Selection } from './world/Selection';
import { World } from './world/World';

// タイムラインに並べる行: 選んでいる物 (モデルならキーフレームとモーション) と、カメラモーション
export interface TlRow { label: string; keys: number[]; motion: Int32Array | null; editable: boolean }

const isAudio = (f: File) => f.type.startsWith('audio/') || /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus)$/i.test(f.name);

// --- エンジン: 各部を組み立ててつなぎ、画面 (React) に操作の窓口を出す ---
// 各部は、使う相手をコンストラクタで受け取り、知らせたいことはイベントで出す。
// 複数の部分にまたがる操作 (ファイルの読み込み・選んでいるモデルの編集など) は、ここに書く。
// 1 つの部分で済む操作は、画面から直接その部分を呼んでよい (engine.clock.togglePlay() など)
export class Engine {
  readonly ui = new UiChannel();
  readonly graph = new SceneGraph();
  readonly viewport = new Viewport(this.graph);
  readonly library = new MaterialLibrary();
  readonly world = new World(this.graph, this.viewport, this.ui, this.library);
  readonly selection = new Selection(this.world, this.ui);
  readonly picker = new ColorPicker(this.world, this.viewport, this.ui);
  readonly camera = new CameraController(this.graph, this.viewport, this.ui, this.world);
  readonly physics = new Physics(this.world, this.viewport, this.ui);
  readonly stage = new Stage(this.graph, this.viewport, this.library);
  readonly motion = new Motion(this.world, this.physics, this.stage, this.camera, this.ui);
  readonly posing = new Posing(this.world, this.physics, this.motion, this.viewport, this.ui);
  readonly clock = new Clock();
  readonly keyframes = new Keyframes(this.world, this.posing, this.viewport, this.ui);
  readonly music = new Music(this.ui, () => this.clock.playing);
  readonly effects = new Effects(this.viewport, this.ui, () => this.camera.focusPoint());
  readonly loader = new MmdLoader(this.ui, () => this.viewport.requestDraw());
  readonly vpd = new VpdIO(this.posing, this.viewport, this.ui);
  readonly project = new ProjectIO(this);
  input: InputController | null = null;

  constructor() {
    const { viewport, clock, motion, keyframes, music, world, selection, camera, graph, ui } = this;
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
    selection.events.on('changed', () => { keyframes.clearSelection(); ui.bump('materialsVersion'); });
    this.library.events.on('changed', () => { ui.bump('materialsVersion'); viewport.requestDraw(); });

    // 描く前: カメラ・物の位置・掴んでいる物の明るさ・選択の輪郭線・影の範囲
    viewport.onBeforeRender(() => {
      camera.update();
      world.sync();
      const held = this.input?.held ?? this.picker.target;
      for (const o of world.objects) world.setHighlight(o, o === held);
      selection.syncOutlines(world.objects);
      graph.aimShadows(camera.cam.tx, camera.cam.tz, camera.cam.dist);
    });
    // 描いたあと: 選んでいる物の情報と、ビューポート左上の文字 (Blender の「ユーザー・透視投影」と「(フレーム) 選んでいる物」)
    viewport.onRender(() => {
      selection.publish();
      const what = camera.override ? 'カメラ' : camera.viewName || 'ユーザー';
      ui.set({
        viewInfo: `${what}・透視投影\n(${clock.frame}) ${ui.state.sel?.name ?? ''}`,
        hairHang: selection.model ? this.physics.hairHang(selection.model) : null,
      });
    });

    world.addShape(0, 0, 0, 0); // 原点に立方体を 1 つ
    clock.reset();
  }

  // --- 描画先 (React の部品が canvas を用意したとき・片付けるとき) ---
  mount(canvas: HTMLCanvasElement, container: HTMLElement) {
    if (!this.viewport.mount(canvas, container)) { this.ui.toast('WebGL2 に対応していません', 0); return; }
    this.input = new InputController(canvas, this.viewport, this.world, this.camera, this.selection, this.picker, {
      placeShape: (x, z) => this.placeShape(x, z),
      remove: obj => this.world.remove(obj),
      userGesture: () => this.music.resume(), // 自動再生を止められていた曲は、画面を触ったときに再生する
    });
    this.effects.restore();
  }
  unmount() {
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
  deleteSelected() { if (this.selection.current) this.world.remove(this.selection.current); }
  // サイドバーの「オブジェクト」から位置・向き・色を変える
  setObjProp(key: 'x' | 'z' | 'r', v: number) {
    const o = this.selection.current;
    if (!o || !Number.isFinite(v)) return;
    if (key === 'r') o.r = v * Math.PI / 180;
    else o[key] = v;
    this.world.settle();
    this.viewport.requestDraw();
  }
  setObjColor(c: number) {
    const o = this.selection.current;
    if (!o || o.s === 3) return;
    this.world.setShapeColor(o, c);
    this.viewport.requestDraw();
  }

  // --- ファイルの読み込み ---
  // .pmx (とテクスチャ)・.vmd (いくつでも)・.vpd・曲をまとめて受け取る。
  // .vmd だけ・曲だけのときは、置いてあるモデル全員に付ける
  async loadFiles(files: File[]) {
    const { world, ui } = this;
    const vmds = files.filter(f => /\.vmd$/i.test(f.name));
    const vpd = files.find(f => /\.vpd$/i.test(f.name));
    const song = files.find(isAudio);
    const pmx = files.find(f => /\.pmx$/i.test(f.name));
    let targets: ModelObj[];
    if (pmx) {
      if (world.full) return;
      const mesh = await this.loader.loadPmx(files);
      if (!mesh) return;
      const slots = convertMmdMesh(mesh, this.library); // 材質はプリンシプル BSDF のマテリアルに変換する
      if (Stage.isStage(mesh, pmx.name)) {
        this.stage.set(mesh);
        ui.toast(`${pmx.name} をステージとして置きました`);
        targets = world.models; // ステージを読んだときは、モーションは置いてある人物全員に付ける
      } else {
        // ステージがあるときは、ステージの中心 (MMD で人物が立つ原点) の近くに置く
        const atStage = !!this.stage.model;
        const obj = world.addModel(mesh, atStage ? 0 : this.camera.cam.tx, atStage ? 0 : this.camera.cam.tz, slots);
        this.selection.select(obj);
        await this.physics.start(obj);
        ui.toast(`${pmx.name} を置きました`);
        targets = [obj];
      }
    } else if (vmds.length || song || vpd) {
      targets = world.models;
    } else {
      ui.toast('.pmx・.vmd・.vpd・曲のどれも選ばれていません。モデルの .pmx とテクスチャ画像、モーションの .vmd、ポーズの .vpd、曲のファイルを選んでください。');
      return;
    }
    // ポーズ (.vpd) は、モデルを選んでいるならそのモデルに、そうでなければ対象のモデル全員に当てる
    if (vpd) await this.vpd.load(vpd, this.selection.model && !pmx ? [this.selection.model] : targets);
    let motionOk = true;
    if (vmds.length) {
      motionOk = await this.motion.load(vmds, targets);
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
      if (motionOk) ui.toast(`${song.name} を再生しています`);
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

  // ファイル > 最初の状態に戻す: 読み込んだモデル・モーション・曲を消し、原点の立方体 1 個と最初の視点に戻す
  resetAll() {
    this.music.stop();
    this.selection.select(null);
    this.picker.close();
    this.camera.resetView();
    this.world.clear();
    this.stage.clear();
    this.world.addShape(0, 0, 0, 0);
    this.clock.reset();
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
  // --- マテリアル (選んでいる物のマテリアルスロット。Blender の「マテリアル」プロパティとシェーダーエディター) ---
  slots(): { index: number; id: string | null; name: string }[] {
    const o = this.selection.current;
    return o ? o.slots.map((id, index) => ({ index, id, name: (id && this.library.materials.get(id)?.name) || '' })) : [];
  }
  activeSlot() {
    const o = this.selection.current;
    return o ? Math.min(o.activeSlot ?? 0, Math.max(o.slots.length - 1, 0)) : 0;
  }
  setActiveSlot(i: number) {
    const o = this.selection.current;
    if (!o) return;
    o.activeSlot = i;
    this.ui.bump('materialsVersion');
  }
  // 選んでいるスロットのマテリアル
  activeMaterial(): MaterialData | null {
    const id = this.selection.current?.slots[this.activeSlot()];
    return (id && this.library.materials.get(id)) || null;
  }
  materialList() { return this.library.list(); }
  // 選んでいるスロットに、マテリアル id を入れる (null で外す)
  assignMaterial(id: string | null) {
    const o = this.selection.current;
    if (!o) return;
    this.world.setSlot(o, this.activeSlot(), id);
    this.ui.bump('materialsVersion');
  }
  newMaterial() { this.assignMaterial(this.library.create().id); }
  // 選んでいるスロットのマテリアルを複製して、そのスロットに入れる (Blender の「新規マテリアル」ボタン)
  duplicateMaterial() {
    const cur = this.activeMaterial();
    if (!cur) { this.newMaterial(); return; }
    const copy = this.library.duplicate(cur.id);
    if (copy) this.assignMaterial(copy.id);
  }
  renameMaterial(name: string) { const cur = this.activeMaterial(); if (cur) this.library.rename(cur.id, name); }
  private editMaterial(fn: (data: MaterialData) => void) { const cur = this.activeMaterial(); if (cur) this.library.edit(cur.id, fn); }
  setMaterialSettings(patch: Partial<MaterialSettings>) { this.editMaterial(d => Object.assign(d.settings, patch)); }
  setMaterialOutline(patch: Partial<MaterialOutline>) { this.editMaterial(d => Object.assign(d.outline, patch)); }
  // ノード (選んでいるスロットのマテリアルの)
  setNodeValue(node: string, socket: string, value: SocketValue) {
    this.editMaterial(d => { const n = findNode(d.tree, node); if (n) n.values[socket] = value; });
  }
  setNodeProp(node: string, prop: string, value: string) {
    this.editMaterial(d => { const n = findNode(d.tree, node); if (n) n.props[prop] = value; });
  }
  addShaderNode(type: NodeType, x: number, y: number) {
    let id: string | null = null;
    this.editMaterial(d => { id = addNode(d.tree, type, x, y).id; });
    return id;
  }
  removeShaderNode(node: string) { this.editMaterial(d => { removeNode(d.tree, node); }); }
  moveShaderNode(node: string, x: number, y: number) {
    this.editMaterial(d => { const n = findNode(d.tree, node); if (n) Object.assign(n, { x, y }); });
  }
  // つなぐ。つなげなければ、その理由を返す
  connectNodes(from: SocketRef, to: SocketRef): string | null {
    const cur = this.activeMaterial();
    if (!cur) return 'マテリアルがありません';
    const why = whyNotConnect(cur.tree, from, to);
    if (why) return why;
    this.editMaterial(d => { connect(d.tree, from, to); });
    return null;
  }
  disconnectNode(to: SocketRef) { this.editMaterial(d => { disconnect(d.tree, to); }); }
  // プリンシプル BSDF (サーフェス) の、つながっている入力の相手
  surfaceShader() { const cur = this.activeMaterial(); return cur ? surfaceShader(cur.tree) : null; }
  images() { return [...this.library.images.values()].map(i => ({ id: i.id, name: i.name })); }
  // 画像ファイルを読み込んで、画像として登録する (MMD のモデルに使うときは、MMD と同じく上下を反転しない)
  async openImage(file: File, flipY = !this.selection.model): Promise<string> {
    const url = URL.createObjectURL(file);
    try {
      const texture = await new THREE.TextureLoader().loadAsync(url);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.flipY = flipY;
      texture.name = file.name;
      return this.library.addImage(file.name, texture, file).id;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  // --- プロジェクト (.wgp) ---
  // いまの場面 (モデル・配置・マテリアル・ポーズ・キーフレーム・モーション・曲・視点・タイムライン) を保存する
  async saveProject() {
    this.ui.toast('プロジェクトを保存中…', 0);
    try {
      const bytes = await this.project.save();
      const name = `${this.ui.state.projectName ?? 'プロジェクト'}.wgp`;
      download(bytes, name);
      this.ui.set({ projectName: name.replace(/\.wgp$/i, '') });
      this.ui.toast(`${name} を保存しました (${(bytes.length / 1024 / 1024).toFixed(1)} MB)`);
    } catch (err) {
      console.error(err);
      this.ui.toast(`プロジェクトを保存できませんでした: ${(err as Error)?.message ?? err}`, 8000);
    }
  }
  async openProject(file: File) {
    this.ui.toast(`${file.name} を開いています…`, 0);
    try {
      await this.project.open(new Uint8Array(await file.arrayBuffer()));
      this.ui.set({ projectName: file.name.replace(/\.wgp$/i, '') });
      this.ui.toast(`${file.name} を開きました`);
    } catch (err) {
      console.error(err);
      this.ui.toast(`${file.name} を開けませんでした: ${(err as Error)?.message ?? err}`, 8000);
    }
  }

  // マテリアルを変えた .pmx を書き出す (MMD で表せる範囲。ほかの部分は元の .pmx のまま)
  async exportPmx() {
    const o = this.model;
    const file: File | undefined = o?.model.userData.sourceFile;
    if (!o || !file) { this.ui.toast('書き出す MMD モデルをクリックして選んでください。'); return; }
    try {
      const sources = o.model.userData.slotSources;
      const patches = new Map(o.slots.map((id, i) => [i, toPmxValues(id ? this.library.materials.get(id) ?? null : null, sources[i])]));
      const bytes = patchPmxMaterials(await file.arrayBuffer(), patches);
      const name = `${file.name.replace(/\.pmx$/i, '')}_edited.pmx`;
      download(bytes, name);
      this.ui.toast(`${name} を書き出しました。テクスチャを読めるよう、元の .pmx と同じフォルダに置いてください`, 6000);
    } catch (err) {
      console.error(err);
      this.ui.toast(`書き出せませんでした: ${(err as Error)?.message ?? err}`, 8000);
    }
  }
  // 髪の形を保つ錘を外して、髪を重力で垂らす (MMD とは見た目が変わる)
  setHairHang(on: boolean) {
    if (!this.model) return;
    this.physics.setHairHang(this.model, on);
    this.ui.set({ hairHang: this.physics.hairHang(this.model) });
    this.viewport.requestDraw();
  }
  savePose() {
    if (this.model) this.vpd.save(this.model);
    else this.ui.toast('ポーズを保存するモデルをクリックして選んでください。');
  }
  // 選んでいるモデルに当てる (選んでいなければ、置いてあるモデル全員に)
  loadPoseFile(file: File) { return this.vpd.load(file, this.model ? [this.model] : this.world.models); }

  // --- キーフレーム ---
  // 選んでいるモデルの、いまのポーズと表情を、いまのフレームに記録する (I)
  insertKey() {
    const obj = this.model;
    if (!obj) { this.ui.toast('キーフレームを打つ MMD モデルをクリックして選んでください。'); return; }
    const f = this.clock.frame;
    this.keyframes.insert(obj, f);
    if (f > this.clock.end) this.clock.setRange(this.clock.start, f);
  }
  deleteKeyHere() { if (this.model) this.keyframes.deleteAt(this.model, this.clock.frame, this.clock.t); }
  deleteSelectedKeys() { return this.model ? this.keyframes.deleteSelected(this.model, this.clock.t) : false; }
  moveSelectedKeys(delta: number) { if (this.model) this.keyframes.moveSelected(this.model, delta, this.clock.t); }
  selectKeys(frames: number[], add: boolean) { this.keyframes.select(frames, add); }

  // --- タイムライン ---
  timelineRows(): TlRow[] {
    const rows: TlRow[] = [];
    const obj = this.selection.current;
    if (this.model) {
      const m = this.model;
      rows.push({ label: m.model.name || 'モデル', keys: [...(m.keys?.keys() ?? [])].sort((a, b) => a - b), motion: m.motion?.frames ?? null, editable: true });
    } else if (obj) {
      rows.push({ label: SHAPE_NAMES[obj.s], keys: [], motion: null, editable: false });
    }
    const cam = this.motion.camera;
    if (cam) rows.push({ label: 'カメラ', keys: [], motion: cam.motion.frames, editable: false });
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

// バイト列をファイルとしてダウンロードさせる
function download(bytes: Uint8Array, name: string) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([bytes as BlobPart])), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
