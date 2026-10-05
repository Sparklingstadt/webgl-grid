import type * as THREE from 'three';
import { errorText } from '../../core/errors';
import { t } from '../../core/i18n';
import type { Clock } from '../anim/Clock';
import type { MaterialLibrary } from '../materials/MaterialLibrary';
import type { RenderOutput } from '../output/RenderOutput';
import type { SceneGraph } from '../render/SceneGraph';
import type { Viewport } from '../render/Viewport';
import type { UiChannel } from '../UiChannel';
import type { Selection } from '../world/Selection';
import type { World } from '../world/World';
import { EffectStore, type LoadedEffect } from './EffectStore';
import { MmeRenderer } from './MmeRenderer';

// --- レンダーエンジン (標準 / MME 互換) の切り替えと設定。MME 互換のあいだは Viewport.drawOverride に描画を差し込む ---
export interface MmeSettings { engine: 'standard' | 'mme'; selfShadow: boolean; shadowDistance: number; groundShadow: boolean }
// shadowDistance: セルフシャドウの範囲 (8875 で標準のエンジンの太陽の影と同じ。大きいほど広い)
export const MME_DEFAULTS: MmeSettings = { engine: 'standard', selfShadow: true, shadowDistance: 8875, groundShadow: true };

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

  constructor(private deps: MmeDeps) {
    this.store = new EffectStore(deps.ui);
    this.renderer = new MmeRenderer({ ...deps, store: this.store, settings: this.settings });
    // 前の描画 (効果の後処理) は、標準のエンジンのときに使う
    const prev = deps.viewport.drawOverride;
    deps.viewport.drawOverride = () => (this.settings.engine === 'mme' ? this.draw() || (prev?.() ?? false) : prev?.() ?? false);
    deps.output.waitReady = () => (this.settings.engine === 'mme' ? this.whenReady() : null);
    this.store.events.on('changed', () => {
      this.renderer.prune();
      deps.viewport.requestDraw();
    });
    deps.world.events.on('removed', obj => this.store.forgetObject(obj.id));
  }

  // 変えたら描き直す。標準に戻したら、MME の資源 (GPU のものと変形した形) を片付ける
  set(patch: Partial<MmeSettings>): void {
    const was = this.settings.engine;
    Object.assign(this.settings, patch);
    if (was === 'mme' && this.settings.engine !== 'mme') this.renderer.dispose();
    this.deps.viewport.requestDraw();
  }

  // .fx が入っているフォルダのファイルを読んでコンパイルする (失敗したらお知らせを出す)
  loadEffect(files: File[], entry: string): Promise<LoadedEffect> {
    return this.store.load(files, entry);
  }

  // 書き出しの前に: 使う .fx のテクスチャと、MMD モデルの .pmx を読み終える (失敗しても) まで待つ
  whenReady(): Promise<void> {
    return this.renderer.whenReady();
  }

  // 描画先を作り直すとき (描画先の資源は使えなくなる)
  reset(): void {
    this.renderer.dispose();
  }

  // MME 互換で描く。例外を出したら false (そのフレームは標準のエンジンと効果で描く。同じ例外のお知らせは 1 回)
  private draw(): boolean {
    try {
      return this.renderer.render();
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
