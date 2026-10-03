import type * as THREE from 'three';
import { VIEWPORT_BG } from '../../core/constants';
import { errorText } from '../../core/errors';
import type { UiChannel } from '../UiChannel';
import { FX_KEYS, FX_LEVEL_DEFAULT, applyFxLevels, createPostFx, type FxKey, type FxLevel, type FxState, type PostFx } from './postfx';
import type { Viewport } from './Viewport';

const FX_KEY = 'webgl-grid-fx';
const FX_LEVEL_KEY = 'webgl-grid-fx-level';
const load = <T extends object>(key: string, base: T): T => {
  try { return { ...base, ...JSON.parse(localStorage.getItem(key) ?? '{}') }; } catch { return base; } // 保存されていない・使えない
};
const save = (key: string, value: object) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 保存できなくても使える */ }
};

// --- 効果 (MME 風の後処理) のオン・オフと強さ。設定はブラウザに保存する ---
// 効果を 1 つでも使うときは、Viewport の描画を後処理 (EffectComposer) に差し替える
export class Effects {
  private state: FxState = load(FX_KEY, { ao: false, dof: false, bloom: false, diffusion: false, color: false });
  private level: FxLevel = load(FX_LEVEL_KEY, { ...FX_LEVEL_DEFAULT });
  fx: PostFx | null = null;
  private loading: Promise<void> | null = null;

  constructor(private viewport: Viewport, private ui: UiChannel, private focusPoint: () => THREE.Vector3) {
    ui.set({ fxState: { ...this.state }, fxLevel: { ...this.level } });
    viewport.drawOverride = () => this.render();
    viewport.onResize(() => {
      if (!this.fx) return;
      this.fx.composer.setPixelRatio(viewport.renderer!.getPixelRatio());
      this.fx.composer.setSize(viewport.width, viewport.height);
    });
  }

  private any() { return FX_KEYS.some(k => this.state[k]); }
  private ensure() {
    const { renderer, outline, graph, width, height } = this.viewport;
    if (!renderer || !outline) return Promise.resolve();
    this.loading ??= createPostFx(renderer, graph.scene, graph.camera, outline, width, height, VIEWPORT_BG).then(p => {
      this.fx = p;
      applyFxLevels(p, this.level);
    });
    return this.loading;
  }
  // 描き始めたとき: 前回オンにしていた効果を準備する
  restore() {
    if (this.any()) this.ensure().then(() => this.viewport.requestDraw(), err => console.error(err));
  }
  // 描画先を作り直すときは、後処理も作り直す
  reset() {
    this.fx = null;
    this.loading = null;
  }

  async set(k: FxKey, on: boolean) {
    this.state[k] = on;
    this.ui.set({ fxState: { ...this.state } });
    save(FX_KEY, this.state);
    if (this.any() && !this.fx && this.viewport.mounted) {
      this.ui.toast('効果を準備中…', 0);
      try {
        await this.ensure();
        this.ui.hideToast();
      } catch (err) {
        console.error(err);
        this.ui.toast(`効果を読み込めませんでした: ${errorText(err)}`, 8000);
      }
    }
    this.viewport.requestDraw();
  }
  // 強さのスライダー。オフの効果を動かしたら、その効果をオンにする (色調の 3 本は「色調」のオン・オフに付く)
  setLevel(k: keyof FxLevel, v: number) {
    this.level[k] = v;
    this.ui.set({ fxLevel: { ...this.level } });
    save(FX_LEVEL_KEY, this.level);
    if (this.fx) applyFxLevels(this.fx, this.level);
    const target: FxKey = k === 'temp' || k === 'sat' || k === 'bright' ? 'color' : k;
    if (!this.state[target]) this.set(target, true);
    else this.viewport.requestDraw();
  }

  // 効果を使うときは後処理を通して描く。描いたら true
  private render() {
    const { fx } = this;
    if (!fx || !this.any()) return false;
    for (const k of FX_KEYS) fx.passes[k].enabled = this.state[k];
    if (this.state.dof) fx.passes.dof.uniforms.focus.value = this.viewport.graph.camera.position.distanceTo(this.focusPoint());
    fx.composer.render();
    return true;
  }
}
