import type * as THREE from 'three';
import { errorText } from '../../core/errors';
import { getLang, t } from '../../core/i18n';
import { MME_DEFAULTS, normalizeObjectEffects, type MmeScene, type MmeSettings, type ObjectEffects, type SavedSlot, type TabEffects } from '../../core/mme/settings.ts';
import { same } from '../addons/registry';
import type { Clock } from '../anim/Clock';
import type { MaterialLibrary } from '../materials/MaterialLibrary';
import type { RenderOutput } from '../output/RenderOutput';
import type { SceneGraph } from '../render/SceneGraph';
import type { Viewport } from '../render/Viewport';
import { isModel, type Obj } from '../types';
import { STAGE_ROW_ID, type MmeEffectUi, type MmeRowUi, type MmeUiState, type UiChannel } from '../UiChannel';
import { nameOf } from '../world/Selection';
import type { Selection } from '../world/Selection';
import type { World } from '../world/World';
import { pmxName, STAGE, type DefaultsOf, type Owner } from './Assignments';
import { Controllers } from './Controllers';
import { EffectStore, findFile, type EffectFolder, type LoadedEffect } from './EffectStore';
import { MmeRenderer } from './MmeRenderer';
import type { Slot } from './ScenePass';

// --- レンダーエンジン (標準 / MME 互換) の切り替えと設定。MME 互換のあいだは Viewport.drawOverride に描画を差し込む ---
export { MME_DEFAULTS, normalizeMme, type MmeSettings } from '../../core/mme/settings.ts';
const MAX_ERRORS = 20; // 画面に出すエラーの数

type AssignUi = Pick<MmeUiState, 'folders' | 'tabs' | 'rows'>;

// エフェクト割当に載せる物 (ライト・カメラは描く形がないので除く)
const assignable = (o: Obj) => !o.light && !o.camera;
// フォルダの中の .fx (フォルダからの相対パス)
const fxIn = (f: EffectFolder) => [...f.text.keys()].filter(p => p.toLowerCase().endsWith('.fx')).sort();
const slotName = (s: Slot) => (s.kind === 'hide' ? 'hide' : s.effect.name);
const sameList = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((x, i) => x === b[i]);

// 割り当て all (写して変える) のタブの、物全体 (materialIndex が null) か材質を slot にする (null なら外す)
function withSlot(all: ObjectEffects, tab: string, materialIndex: number | null, slot: SavedSlot | null): ObjectEffects {
  const out: ObjectEffects = structuredClone(all);
  const effects = (out[tab] ??= {});
  if (materialIndex === null) {
    if (slot) effects.object = slot;
    else delete effects.object;
  } else {
    const materials = (effects.materials ??= {});
    if (slot) materials[materialIndex] = slot;
    else delete materials[materialIndex];
  }
  return out;
}

export interface MmeDeps {
  viewport: Viewport; graph: SceneGraph; world: World; selection: Selection; clock: Clock; library: MaterialLibrary; ui: UiChannel;
  output: RenderOutput;
  stage: () => THREE.Object3D | null; // ステージ (MMD モデル。割り当ては場面の値 stageEffects)
  edited: () => void; // 画面から割り当てを変えた (元に戻すの手にする)
  // 元に戻すの対象にしない場面の値 (ステージの割り当て・ポストエフェクト・フォルダ・仮のコントローラーの値・設定) を変えた (自動保存する)。
  // 毎フレームの publish では呼ばない
  sceneEdited: () => void;
}

export class MmeEngine {
  readonly store: EffectStore;
  readonly settings: MmeSettings = { ...MME_DEFAULTS };
  readonly renderer: MmeRenderer;
  readonly controllers: Controllers; // CONTROLOBJECT の値 (仮のコントローラーの値は場面の値)
  // ステージの割り当て (場面の値。ポストエフェクトと同じく元に戻すの対象にしない。ステージを差し替えても残る)
  private stageEffects: ObjectEffects | null = null;
  private reported = new Set<string>(); // お知らせに出した例外の文
  private logged: string | null = null; // 続けて出ている例外の文 (コンソールに 1 回だけ書く。描けたら忘れる)
  private shown = ''; // 画面に出した状態 (JSON。同じなら知らせない)
  private changes = 0; // 割り当て・ポストエフェクトを変えた回数 (changed)
  // エフェクト割当のタブ・行と JSON、仮のコントローラーの項目。作ったときの元 (inputs) が変わったときだけ作り直す
  private assignInputs: unknown[] = [];
  private assignUi: AssignUi = { folders: [], tabs: [], rows: {} };
  private assignJson = '';
  private catalog = new Map<string, string[]>();
  // 仮のコントローラーの項目と値と JSON (項目を作り直したか、値を変えたときだけ並べ直す)
  private controlVersion = -1;
  private controlUi: MmeUiState['controllers'] = [];
  private controlJson = '';

  constructor(private deps: MmeDeps) {
    this.store = new EffectStore(deps.ui);
    this.controllers = new Controllers({
      world: deps.world, stage: deps.stage, warn: m => this.renderer.warn(m), outputting: () => deps.viewport.outputting,
    });
    this.renderer = new MmeRenderer({
      ...deps, store: this.store, settings: this.settings, controllers: this.controllers, stageEffects: () => this.stageEffects,
    });
    // 前の描画 (効果の後処理) は、標準のエンジンのときに使う
    const prev = deps.viewport.drawOverride;
    deps.viewport.drawOverride = () => (this.settings.engine === 'mme' ? this.draw() || (prev?.() ?? false) : prev?.() ?? false);
    deps.output.waitReady = () => (this.settings.engine === 'mme' ? this.whenReady() : null);
    this.store.events.on('changed', () => this.changed());
    // (物の割り当ては物に残す (元に戻すと戻る)。その物だけが使っていた .fx の資源と、そのモデルのトゥーンの画像を捨てる)
    deps.world.events.on('removed', () => this.renderer.prune());
    deps.selection.events.on('changed', () => this.publish());
    this.publish();
  }

  // 変えたら描き直す。標準に戻したら、MME の資源 (GPU のものと変形した形) を片付ける
  set(patch: Partial<MmeSettings>): void {
    const was = this.settings.engine;
    const before = JSON.stringify(this.settings);
    Object.assign(this.settings, patch);
    if (JSON.stringify(this.settings) !== before) this.deps.sceneEdited();
    if (was === 'mme' && this.settings.engine !== 'mme') this.renderer.dispose();
    this.publish();
    this.deps.viewport.requestDraw();
  }

  // 仮のコントローラー (場面にない CONTROLOBJECT の名前) の項目の値 (0〜1) を変えて描き直す。場面の値なので、元に戻すの対象にしない
  setControl(name: string, item: string, v: number): void {
    this.controllers.set(name, item, v);
    this.deps.sceneEdited();
    this.publish();
    this.deps.viewport.requestDraw();
  }

  // 割り当て・ポストエフェクト・フォルダが変わった: 使わなくなった資源を捨てて、画面に知らせて描き直す (自動保存もする)
  private changed(): void {
    this.changes++;
    this.deps.sceneEdited();
    this.renderer.prune();
    this.publish();
    this.deps.viewport.requestDraw();
  }

  // 画面に設定・選んでいる物の .fx (Main の物の割り当て)・ポストエフェクトの一覧・エフェクト割当のタブと行・仮のコントローラーを知らせる
  // (変わったときだけ)。毎フレーム呼ばれるので、割り当ての行と仮のコントローラーの項目は元 (inputs) が変わったときだけ作り、
  // 仮のコントローラーの値は値を変えたときだけ並べ直す。どちらも JSON を使い回す
  publish(): void {
    const saved = this.deps.selection.current?.mme?.Main?.object;
    // (見つからない .fx はコンパイルしない: コンパイルできないお知らせを出さない。見つからないことは描くときに警告する)
    const fx = saved && saved !== 'hide' ? this.renderer.assignments.effectOf(saved) : null;
    const rest: Omit<MmeUiState, keyof AssignUi | 'controllers'> = {
      settings: { ...this.settings },
      object: fx ? this.effectUi(fx) : null,
      posts: this.store.posts.map(p => ({ ...this.effectUi(p.effect), enabled: p.enabled })),
      warnings: [...this.renderer.warnings],
    };
    const tabs = [{ name: 'Main', description: '' }, ...this.renderer.offscreenTabs().filter(x => x.name !== 'Main')];
    const inputs = this.inputs(tabs);
    const rebuilt = !sameList(inputs, this.assignInputs);
    if (rebuilt) {
      this.assignInputs = inputs;
      this.rebuild(tabs);
    }
    if (rebuilt || this.controllers.version !== this.controlVersion) {
      this.controlVersion = this.controllers.version;
      this.controlUi = [...this.catalog].map(([name, items]) => ({ name, items: items.map(item => ({ item, value: this.controllers.get(name, item) })) }));
      this.controlJson = JSON.stringify(this.controlUi);
    }
    const json = `${JSON.stringify(rest)}\n${this.assignJson}\n${this.controlJson}`;
    if (json === this.shown) return;
    this.shown = json;
    this.deps.ui.set({ mme: { ...rest, ...this.assignUi, controllers: this.controlUi } });
  }

  // 割り当ての行と仮のコントローラーの項目の元。物の数によらず、版の数 (言語・フォルダ・割り当てとポストエフェクト・場面の物 (足す・消す・
  // 名前・ステージ)・マテリアル) と、前のフレームのオフスクリーンのタブ (名前・説明・DefaultEffect の規則 (宣言ごとに同じ配列)・持ち主) と、
  // GPU で止めたエフェクト。中身は参照で比べる
  private inputs(tabs: { name: string; description: string }[]): unknown[] {
    const ui = this.deps.ui.state;
    const out: unknown[] = [getLang(), this.store.version, this.changes, ui.sceneVersion, ui.materialsVersion];
    for (const tab of tabs) {
      const d = tab.name === 'Main' ? null : this.renderer.offscreenDefaults(tab.name);
      out.push(tab.name, tab.description, d?.defaults.rules ?? null, d?.defaults.base ?? null, d?.defaults.folder ?? null, ...(d?.owners ?? []), '|');
    }
    out.push(...this.renderer.stoppedEffects());
    return out;
  }

  // エフェクト割当 (タブ・タブごとのステージと物と材質の行・フォルダの .fx) と、仮のコントローラーの項目 (描いているエフェクトの、場面にない名前のもの) を作る
  private rebuild(tabs: { name: string; description: string }[]): void {
    const objects = this.deps.world.objects.filter(assignable);
    const stage = this.stageMesh();
    const rows: Record<string, MmeRowUi[]> = {};
    for (const tab of tabs) {
      const d = tab.name === 'Main' ? { defaults: null, owners: new Set<Owner>() } : this.renderer.offscreenDefaults(tab.name);
      if (!d) continue;
      rows[tab.name] = [
        ...(stage ? this.stageRows(stage, tab.name, d.defaults, d.owners.has(STAGE)) : []),
        ...objects.flatMap(o => this.rowsOf(o, tab.name, d.defaults, d.owners.has(o))),
      ];
    }
    this.assignUi = { folders: this.store.folders().map(f => ({ id: f.id, name: f.name, fx: fxIn(f) })), tabs, rows };
    this.assignJson = JSON.stringify(this.assignUi);
    this.catalog = this.controllers.catalog(this.renderer.drawnEffects());
  }

  // 物の行と、MMD モデルなら材質の行
  private rowsOf(obj: Obj, tab: string, defaults: DefaultsOf | null, isOwner: boolean): MmeRowUi[] {
    const { assignments } = this.renderer;
    const fallback = (material: number | null) => assignments.fallbackFor(tab, defaults, obj, material, isOwner);
    return this.rows(obj.id, nameOf(obj), isModel(obj) ? this.materialNames(obj.model) : [], obj.mme?.[tab], defaults, fallback);
  }

  // ステージの行と材質の行 (名前は「ステージ: .pmx のファイル名」)
  private stageRows(mesh: THREE.SkinnedMesh, tab: string, defaults: DefaultsOf | null, isOwner: boolean): MmeRowUi[] {
    const name = pmxName(mesh) ?? '';
    const fallback = (material: number | null) => this.renderer.assignments.stageFallbackFor(tab, defaults, name, material, isOwner);
    const label = t('ステージ: {name}', { name: name || t('ステージ') });
    return this.rows(STAGE_ROW_ID, label, this.materialNames(mesh), this.stageEffects?.[tab], defaults, fallback);
  }

  // 1 つの物の行と材質の行。既定の欄は Assignments の決め方 (割り当てがないときに描くもの)。
  // GPU で止めたエフェクトは、描くときと同じく Main では default.fx、オフスクリーンでは描かない (hide) にして、止めたことを行に書く
  private rows(
    objId: number, label: string, materials: string[], effects: TabEffects | undefined, defaults: DefaultsOf | null, fallbackFor: (material: number | null) => Slot,
  ): MmeRowUi[] {
    const { assignments } = this.renderer;
    const stoppedIn = (e: LoadedEffect | null) => (e && e.result.ok && this.renderer.stopped(e) ? e.name : null);
    const row = (label: string, material: number | null, saved: SavedSlot | undefined): MmeRowUi => {
      const slot = fallbackFor(material);
      const fallbackStopped = slot.kind === 'effect' ? stoppedIn(slot.effect) : null;
      const fallback = fallbackStopped ? (defaults ? 'hide' : this.store.defaultEffect.name) : slotName(slot);
      const stopped = saved === undefined ? fallbackStopped : saved === 'hide' ? null : stoppedIn(assignments.effectOf(saved));
      return { objId, label, material, assigned: this.savedName(saved), fallback, stopped };
    };
    return [
      row(label, null, effects?.object),
      ...materials.map((name, i) => row(name || t('材質 {n}', { n: i }), i, effects?.materials?.[i])),
    ];
  }

  // ステージのモデル (最初の SkinnedMesh。ステージがない・読み込み中なら null)
  private stageMesh(): THREE.SkinnedMesh | null {
    let mesh: THREE.SkinnedMesh | null = null;
    this.deps.stage()?.traverse(o => { if (!mesh && (o as THREE.SkinnedMesh).isSkinnedMesh) mesh = o as THREE.SkinnedMesh; });
    return mesh;
  }

  // MMD モデルの材質の名前 (材質の番号の順。マテリアルの名前、なければ three.js の材質の名前)
  private materialNames(mesh: THREE.Mesh): string[] {
    const m = mesh.material as THREE.Material | THREE.Material[] | undefined;
    return (Array.isArray(m) ? m : m ? [m] : []).map(x => this.deps.library.materials.get(x.userData.materialId)?.name || x.name);
  }

  // 割り当ての名前 ("フォルダ名/パス"・'hide'。パスはフォルダの中で見つかればその書き方)
  private savedName(saved: SavedSlot | undefined): string | null {
    if (saved === undefined) return null;
    if (saved === 'hide') return 'hide';
    const folder = this.store.folder(saved.folder);
    const path = (folder && findFile(folder, saved.path)) ?? saved.path;
    return folder?.name ? `${folder.name}/${path}` : path;
  }

  // コンパイルの結果と警告 (コンパイラの警告のあとに、描いたときのそのエフェクトの警告。GPU で止めたらそのことも)
  private effectUi(e: LoadedEffect): MmeEffectUi {
    const r = e.result;
    const errors = r.ok ? [] : r.errors.slice(0, MAX_ERRORS).map(d => ({ code: d.code, where: `${d.file}:${d.line}`, message: d.message }));
    const warnings = [...r.warnings.map(d => `${d.file}:${d.line} ${d.message}`), ...this.renderer.warningsOf(e)];
    if (this.renderer.stopped(e)) warnings.push(t('GPU で使えないので止めました'));
    return { id: e.id, name: e.name, ok: r.ok, errors, errorCount: r.ok ? 0 : r.errors.length, warnings };
  }

  // .fx が入っているフォルダを読み込んで (同じ名前のフォルダにはまとめて)、その .fx をコンパイルする (失敗したらお知らせを出す)
  async loadEffect(files: File[], entry: string): Promise<LoadedEffect> {
    const folder = await this.store.addFolder(files);
    const e = this.store.effect(folder, entry);
    this.publish(); // (フォルダの .fx の一覧)
    return e;
  }

  // 物の割り当てを置き換える (物の値 'mme' を開いた・元に戻した・複製したとき。null はなし)
  setObjectEffects(obj: Obj, v: ObjectEffects | null): void {
    obj.mme = v ?? undefined;
    this.changed();
  }

  // 物のタブの、物全体 (materialIndex が null) か材質の割り当てを変える (slot が null なら外して既定に戻す)。元に戻すの手になる
  assign(obj: Obj, tab: string, materialIndex: number | null, slot: SavedSlot | null): void {
    const next = normalizeObjectEffects(withSlot(obj.mme ?? {}, tab, materialIndex, slot));
    if (same(obj.mme ?? null, next)) return;
    this.setObjectEffects(obj, next);
    this.deps.edited();
  }

  // ステージのタブの、物全体 (materialIndex が null) か材質の割り当てを変える (slot が null なら外して既定に戻す)。
  // 場面の値なので、元に戻すの対象にしない (ポストエフェクトと同じ)
  assignStage(tab: string, materialIndex: number | null, slot: SavedSlot | null): void {
    const next = normalizeObjectEffects(withSlot(this.stageEffects ?? {}, tab, materialIndex, slot));
    if (same(this.stageEffects, next)) return;
    this.stageEffects = next;
    this.changed();
  }

  // --- 画面の操作 (ポストエフェクトの一覧は場面の値で、元に戻すの対象にしない) ---
  // フォルダの中の .fx (フォルダからの相対パス)
  fxFilesIn(files: File[]): string[] {
    return EffectStore.fxFilesIn(files);
  }

  // 選んでいる物の Main に .fx を読んで当てる (コンパイルできなくても当てる。描くのは default.fx で、画面にエラーを出す)
  async loadObjectEffect(files: File[], entry: string): Promise<void> {
    const obj = this.deps.selection.current;
    if (!obj) return;
    const e = await this.read(files, entry);
    if (e && this.deps.world.objects.includes(obj)) this.assign(obj, 'Main', null, { folder: e.folder.id, path: e.entry });
  }

  removeObjectEffect(): void {
    const obj = this.deps.selection.current;
    if (obj) this.assign(obj, 'Main', null, null);
  }

  // ポストエフェクトを一覧の最後 (いちばん外側) に足す
  async addPostEffect(files: File[], entry: string): Promise<void> {
    const e = await this.read(files, entry);
    if (e) this.store.addPost(e);
  }

  // エフェクトの割り当て (場面にある物とステージの割り当てと、ポストエフェクトの一覧) を全部外す (最初の状態に戻すとき・プロジェクトを開くとき)
  clearEffects(): void {
    const assigned = this.deps.world.objects.filter(o => o.mme);
    for (const obj of assigned) obj.mme = undefined;
    const stage = this.stageEffects !== null;
    this.stageEffects = null;
    this.store.clear();
    if (assigned.length > 0 || stage) this.changed();
  }

  // ファイルを読めなければ (File.arrayBuffer の失敗など) お知らせを出して null
  private async read(files: File[], entry: string): Promise<LoadedEffect | null> {
    try {
      return await this.loadEffect(files, entry);
    } catch (err) {
      this.deps.ui.toast(t('.fx を読めませんでした: {error}', { error: errorText(err) }), 8000);
      return null;
    }
  }

  // --- プロジェクトの場面の値 'mme' (フォルダの中のファイルは ProjectIO が mmeFiles として持ち、開くときに EffectStore.restore で先に戻す) ---
  saveScene(): MmeScene {
    return {
      settings: { ...this.settings },
      folders: this.store.folders().map(f => ({ id: f.id, name: f.name })),
      posts: this.store.posts.map(p => ({ effect: { folder: p.effect.folder.id, path: p.effect.entry }, enabled: p.enabled })),
      controls: Object.fromEntries([...this.controllers.values].map(([name, items]) => [name, Object.fromEntries(items)])),
      ...(this.stageEffects ? { stage: structuredClone(this.stageEffects) } : {}),
    };
  }

  // 開いたプロジェクトの設定・ポストエフェクトの並び・仮のコントローラーの値・ステージの割り当てにする (フォルダは戻してある)。
  // フォルダがないポストエフェクトは捨てる。ファイルがないものは、一覧に残して描かない (コンパイルできない)
  loadScene(scene: MmeScene): void {
    const posts = scene.posts.flatMap(({ effect: ref, enabled }) => {
      const folder = this.store.folder(ref.folder);
      return folder ? [{ effect: this.store.effect(folder, ref.path), enabled }] : [];
    });
    this.stageEffects = scene.stage ? structuredClone(scene.stage) : null;
    this.controllers.clear();
    for (const [name, items] of Object.entries(scene.controls)) for (const [item, v] of Object.entries(items)) this.controllers.set(name, item, v);
    this.store.setPosts(posts);
    this.set(scene.settings);
  }

  // 最初の状態に戻す: 割り当て (ステージのものも)・ポストエフェクト・読み込んだフォルダ・仮のコントローラーの値を消し、既定の設定にする
  resetScene(): void {
    this.clearEffects();
    this.store.clearFolders();
    this.controllers.clear();
    this.set({ ...MME_DEFAULTS });
  }

  // 保存の前に: 割り当てた .fx (全部のタブ)・ポストエフェクト・それらのオフスクリーンの DefaultEffect で描く .fx と、その画像を、
  // 描いていなくても読んだファイル (EffectStore のフォルダの used) にする (保存するファイル)
  whenFilesRead(): Promise<void> {
    return this.renderer.whenFilesRead();
  }

  // 書き出しの前に:使う .fx のテクスチャと、MMD モデルの .pmx を読み終える (失敗しても) まで待つ
  whenReady(): Promise<void> {
    return this.renderer.whenReady();
  }

  // 描画先を作り直すとき (描画先の資源は使えなくなる)
  reset(): void {
    this.renderer.dispose();
    this.publish();
  }

  // MME 互換で描く。例外を出したら false (そのフレームは標準のエンジンと効果で描く。同じ例外のお知らせは 1 回。
  // 毎フレーム同じ例外が出るあいだは、コンソールにも 1 回だけ書く)
  private draw(): boolean {
    try {
      const drawn = this.renderer.render();
      this.logged = null;
      this.publish(); // (描いたときの警告)
      return drawn;
    } catch (err) {
      const error = errorText(err);
      if (error !== this.logged) {
        this.logged = error;
        console.error(err);
      }
      if (!this.reported.has(error)) {
        this.reported.add(error);
        this.deps.ui.toast(t('MME 互換で描けなかったので、標準のエンジンで描きました: {error}', { error }), 8000);
      }
      return false;
    }
  }
}
