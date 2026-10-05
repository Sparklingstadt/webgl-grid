import type * as THREE from 'three';
import { errorText } from '../../core/errors';
import { t } from '../../core/i18n';
import type { Clock } from '../anim/Clock';
import type { MaterialLibrary } from '../materials/MaterialLibrary';
import type { RenderOutput } from '../output/RenderOutput';
import type { SceneGraph } from '../render/SceneGraph';
import type { Viewport } from '../render/Viewport';
import { MME_DEFAULTS, type MmeSettings } from '../../core/mme/settings.ts';
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
}

export class MmeEngine {
  readonly store: EffectStore;
  readonly settings: MmeSettings = { ...MME_DEFAULTS };
  readonly renderer: MmeRenderer;
  private reported = new Set<string>(); // お知らせに出した例外の文
  private shown = ''; // 画面に出した状態 (JSON。同じなら知らせない)

  constructor(private deps: MmeDeps) {
    this.store = new EffectStore(deps.ui);
    this.renderer = new MmeRenderer({ ...deps, store: this.store, settings: this.settings });
    // 前の描画 (効果の後処理) は、標準のエンジンのときに使う
    const prev = deps.viewport.drawOverride;
    deps.viewport.drawOverride = () => (this.settings.engine === 'mme' ? this.draw() || (prev?.() ?? false) : prev?.() ?? false);
    deps.output.waitReady = () => (this.settings.engine === 'mme' ? this.whenReady() : null);
    this.store.events.on('changed', () => {
      this.renderer.prune();
      this.publish();
      deps.viewport.requestDraw();
    });
    deps.world.events.on('removed', obj => this.store.forgetObject(obj.id));
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

  // 画面に設定・選んでいる物の .fx・ポストエフェクトの一覧を知らせる (変わったときだけ)
  publish(): void {
    const sel = this.deps.selection.current;
    const fx = sel ? this.store.objectEffect(sel.id) : null;
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

  // コンパイルの結果と警告 (コンパイラの警告のあとに、描いたときのそのエフェクトの警告)
  private effectUi(e: LoadedEffect): MmeEffectUi {
    const r = e.result;
    const errors = r.ok ? [] : r.errors.slice(0, MAX_ERRORS).map(d => ({ code: d.code, where: `${d.file}:${d.line}`, message: d.message }));
    const warnings = [...r.warnings.map(d => `${d.file}:${d.line} ${d.message}`), ...this.renderer.warningsOf(e)];
    return { name: e.name, ok: r.ok, errors, warnings };
  }

  // .fx が入っているフォルダのファイルを読んでコンパイルする (失敗したらお知らせを出す)
  loadEffect(files: File[], entry: string): Promise<LoadedEffect> {
    return this.store.load(files, entry);
  }

  // --- 画面の操作 (割り当ては保存せず、元に戻すの対象にもしない) ---
  // フォルダの中の .fx (フォルダからの相対パス)
  fxFilesIn(files: File[]): string[] {
    return EffectStore.fxFilesIn(files);
  }

  // 選んでいる物に .fx を読んで当てる (コンパイルできなくても当てる。描くのは default.fx で、画面にエラーを出す)
  async loadObjectEffect(files: File[], entry: string): Promise<void> {
    const obj = this.deps.selection.current;
    if (!obj) return;
    const e = await this.store.load(files, entry);
    if (this.deps.world.objects.includes(obj)) this.store.setObjectEffect(obj.id, e);
  }

  removeObjectEffect(): void {
    const obj = this.deps.selection.current;
    if (obj) this.store.setObjectEffect(obj.id, null);
  }

  // ポストエフェクトを一覧の最後 (いちばん外側) に足す
  async addPostEffect(files: File[], entry: string): Promise<void> {
    this.store.addPost(await this.store.load(files, entry));
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

  // MME 互換で描く。例外を出したら false (そのフレームは標準のエンジンと効果で描く。同じ例外のお知らせは 1 回)
  private draw(): boolean {
    try {
      const drawn = this.renderer.render();
      this.publish(); // (描いたときの警告)
      return drawn;
    } catch (err) {
      console.error(err);
      const error = errorText(err);
      if (!this.reported.has(error)) {
        this.reported.add(error);
        this.deps.ui.toast(t('MME 互換で描けなかったので、標準のエンジンで描きました: {error}', { error }), 8000);
      }
      return false;
    }
  }
}
