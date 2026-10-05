import type * as THREE from 'three';
import { errorText } from '../../core/errors';
import { t } from '../../core/i18n';
import { MME_DEFAULTS, normalizeObjectEffects, type MmeSettings, type ObjectEffects, type SavedSlot } from '../../core/mme/settings.ts';
import { same } from '../addons/registry';
import type { Clock } from '../anim/Clock';
import type { MaterialLibrary } from '../materials/MaterialLibrary';
import type { RenderOutput } from '../output/RenderOutput';
import type { SceneGraph } from '../render/SceneGraph';
import type { Viewport } from '../render/Viewport';
import type { Obj } from '../types';
import type { MmeEffectUi, MmeUiState, UiChannel } from '../UiChannel';
import type { Selection } from '../world/Selection';
import type { World } from '../world/World';
import { EffectStore, type LoadedEffect } from './EffectStore';
import { MmeRenderer } from './MmeRenderer';

// --- レンダーエンジン (標準 / MME 互換) の切り替えと設定。MME 互換のあいだは Viewport.drawOverride に描画を差し込む ---
export { MME_DEFAULTS, normalizeMme, type MmeSettings } from '../../core/mme/settings.ts';
const MAX_ERRORS = 20; // 画面に出すエラーの数

export interface MmeDeps {
  viewport: Viewport; graph: SceneGraph; world: World; selection: Selection; clock: Clock; library: MaterialLibrary; ui: UiChannel;
  output: RenderOutput;
  stage: () => THREE.Object3D | null; // ステージ (MMD モデル。default.fx で描く)
  edited: () => void; // 画面から割り当てを変えた (元に戻すの手にする)
}

export class MmeEngine {
  readonly store: EffectStore;
  readonly settings: MmeSettings = { ...MME_DEFAULTS };
  readonly renderer: MmeRenderer;
  private reported = new Set<string>(); // お知らせに出した例外の文
  private logged: string | null = null; // 続けて出ている例外の文 (コンソールに 1 回だけ書く。描けたら忘れる)
  private shown = ''; // 画面に出した状態 (JSON。同じなら知らせない)

  constructor(private deps: MmeDeps) {
    this.store = new EffectStore(deps.ui);
    this.renderer = new MmeRenderer({ ...deps, store: this.store, settings: this.settings });
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
    Object.assign(this.settings, patch);
    if (was === 'mme' && this.settings.engine !== 'mme') this.renderer.dispose();
    this.publish();
    this.deps.viewport.requestDraw();
  }

  // 割り当て・ポストエフェクトが変わった: 使わなくなった資源を捨てて、画面に知らせて描き直す
  private changed(): void {
    this.renderer.prune();
    this.publish();
    this.deps.viewport.requestDraw();
  }

  // 画面に設定・選んでいる物の .fx (Main の物の割り当て)・ポストエフェクトの一覧を知らせる (変わったときだけ)
  publish(): void {
    const saved = this.deps.selection.current?.mme?.Main?.object;
    const ref = saved && saved !== 'hide' ? saved : null;
    const folder = ref && this.store.folder(ref.folder);
    const fx = ref && folder ? this.store.effect(folder, ref.path) : null;
    const state: MmeUiState = {
      settings: { ...this.settings },
      object: fx ? this.effectUi(fx) : null,
      posts: this.store.posts.map(p => ({ ...this.effectUi(p.effect), enabled: p.enabled })),
      warnings: [...this.renderer.warnings],
    };
    const json = JSON.stringify(state);
    if (json === this.shown) return;
    this.shown = json;
    this.deps.ui.set({ mme: state });
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
    return this.store.effect(await this.store.addFolder(files), entry);
  }

  // 物の割り当てを置き換える (物の値 'mme' を開いた・元に戻した・複製したとき。null はなし)
  setObjectEffects(obj: Obj, v: ObjectEffects | null): void {
    obj.mme = v ?? undefined;
    this.changed();
  }

  // 物のタブの、物全体 (materialIndex が null) か材質の割り当てを変える (slot が null なら外して既定に戻す)。元に戻すの手になる
  assign(obj: Obj, tab: string, materialIndex: number | null, slot: SavedSlot | null): void {
    const all: ObjectEffects = structuredClone(obj.mme ?? {});
    const effects = (all[tab] ??= {});
    if (materialIndex === null) {
      if (slot) effects.object = slot;
      else delete effects.object;
    } else {
      const materials = (effects.materials ??= {});
      if (slot) materials[materialIndex] = slot;
      else delete materials[materialIndex];
    }
    const next = normalizeObjectEffects(all);
    if (same(obj.mme ?? null, next)) return;
    this.setObjectEffects(obj, next);
    this.deps.edited();
  }

  // --- 画面の操作 (ポストエフェクトの一覧は保存せず、元に戻すの対象にもしない) ---
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

  // エフェクトの割り当て (場面にある物の割り当てとポストエフェクトの一覧) を全部外す (最初の状態に戻すとき・プロジェクトを開くとき)
  clearEffects(): void {
    const assigned = this.deps.world.objects.filter(o => o.mme);
    for (const obj of assigned) obj.mme = undefined;
    this.store.clear();
    if (assigned.length > 0) this.changed();
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
