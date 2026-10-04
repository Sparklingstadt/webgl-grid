import type * as THREE from 'three';
import { FPS, VIEWPORT_BG } from '../../core/constants';
import { errorText } from '../../core/errors';
import { t } from '../../core/i18n';
import { VIDEO_FORMATS, blurTimes, frameSpan, normalizeOutput, outputFileName, regionPixels, type OutputSettings } from '../../core/output';
import { download, downloadUrl } from '../io/download';
import type { Clock } from '../anim/Clock';
import type { Music } from '../anim/Music';
import type { SceneGraph } from '../render/SceneGraph';
import type { Viewport } from '../render/Viewport';
import type { UiChannel } from '../UiChannel';

export class RenderCancelled extends Error {
  constructor() { super(t('キャンセルしました')); }
}

// --- レンダリング (Blender の F12 / Ctrl+F12): いまの視点から、出力の大きさで画像・動画を作る ---
// 描くときは、編集用の表示 (地面のグリッド・選択の輪郭線) を隠す。
// 動画は、再生と同じようにタイムラインを 1 フレーム (1/30 秒) ずつ進めて描き (物理演算も同じ間隔で進む)、
// WebCodecs で圧縮して MP4 / WebM にまとめる (mediabunny)。処理の速さに関係なく、コマ落ちしない。
// renderPng / renderVideo はデータを返すだけ (MCP からも使う)。renderImage / renderAnimation は画面の操作 (結果を見せる・保存する)。
// モーションブラーでは、シャッターが開いてからフレームの時刻までを何回かに分けて描き、重ねて平均する (時刻は前へだけ進める)。
// レンダー範囲 (Ctrl+B) があれば、その部分だけを切り出して書き出す
export class RenderOutput {
  settings: OutputSettings = normalizeOutput(undefined);
  active = false; // 描いている最中 (編集用の表示を隠す)
  hooks: { begin?: () => void; end?: () => void } = {}; // 描く前・描いたあと (場面のカメラに切り替える・戻す)
  private cancelled = false;

  // baseName: 書き出すファイルの名前の元
  constructor(private viewport: Viewport, private graph: SceneGraph, private clock: Clock, private music: Music, private ui: UiChannel,
              private baseName: () => string) {
    ui.set({ output: { ...this.settings } });
  }

  set(patch: Partial<OutputSettings>) {
    this.settings = normalizeOutput({ ...this.settings, ...patch });
    this.ui.set({ output: { ...this.settings } });
  }
  get busy() { return !!this.ui.state.rendering; }
  cancel() { this.cancelled = true; }

  // --- 画面の操作 (F12 / Ctrl+F12) ---
  private canRender() {
    if (this.busy) return false;
    if (!this.viewport.mounted) { this.ui.toast(t('描画先がないのでレンダリングできません')); return false; }
    return true;
  }
  // いまのフレームを画像にして、保存する前に見せる (レンダー結果)
  async renderImage() {
    if (!this.canRender()) return;
    try {
      const blob = await this.renderPng();
      this.closeResult();
      const { w: width, h: height } = regionPixels(this.settings);
      this.ui.set({ renderResult: { url: URL.createObjectURL(blob), name: outputFileName(this.baseName(), 'png', this.clock.frame), width, height } });
    } catch (err) {
      console.error(err);
      this.ui.toast(t('レンダリングできませんでした: {error}', { error: errorText(err) }), 8000);
    }
  }
  saveResult() {
    const r = this.ui.state.renderResult;
    if (r) downloadUrl(r.url, r.name);
  }
  closeResult() {
    const r = this.ui.state.renderResult;
    if (!r) return;
    URL.revokeObjectURL(r.url);
    this.ui.set({ renderResult: null });
  }
  // 開始〜終了フレームを動画にして保存する
  async renderAnimation() {
    if (!this.canRender()) return;
    this.closeResult();
    const t0 = performance.now();
    try {
      const r = await this.renderVideo();
      const name = outputFileName(this.baseName(), r.ext);
      download(r.bytes, name, r.mime);
      this.ui.toast(t('{name} を書き出しました ({frames} フレーム・{mb} MB・{sec} 秒)', { name, frames: r.frames, mb: (r.bytes.length / 1024 / 1024).toFixed(1), sec: ((performance.now() - t0) / 1000).toFixed(1) }), 8000);
    } catch (err) {
      if (err instanceof RenderCancelled) { this.ui.toast(t('レンダリングをキャンセルしました')); return; }
      console.error(err);
      this.ui.toast(t('動画を作れませんでした: {error}', { error: errorText(err) }), 10000);
    }
  }

  // --- データを作る ---
  // いまのフレームを 1 枚描いて、PNG にする
  async renderPng(): Promise<Blob> {
    const copy = this.flatCanvas(), { clock } = this, t0 = clock.t, blur = this.settings.motionBlur;
    try {
      this.begin();
      if (blur) clock.seek(Math.max(t0 - this.settings.shutter / FPS, 0)); // (シャッターが開くところから)
      this.shoot(copy, t0); // WebGL の描画結果は、すぐ (次に画面へ出す前に) 写し取る
    } finally {
      this.end();
      if (blur) clock.seek(t0);
    }
    return new Promise((ok, ng) => copy.toBlob(b => (b ? ok(b) : ng(new Error(t('PNG を作れませんでした')))), 'image/png'));
  }

  // 開始〜終了フレームを描いて、動画にする。曲があれば (設定でオンなら) 同じ範囲を入れる
  async renderVideo(): Promise<{ bytes: Uint8Array; ext: string; mime: string; codec: string; frames: number }> {
    const mb = await import('mediabunny');
    const s = this.settings, { clock } = this;
    const { start, end } = clock;
    const { count } = frameSpan(start, end);
    const fmt = VIDEO_FORMATS.find(f => f.key === s.format)!;
    const format = s.format === 'mp4' ? new mb.Mp4OutputFormat({ fastStart: 'in-memory' }) : new mb.WebMOutputFormat();
    const quality = { medium: mb.QUALITY_MEDIUM, high: mb.QUALITY_HIGH, veryHigh: mb.QUALITY_VERY_HIGH }[s.quality];
    const supported = format.getSupportedVideoCodecs();
    const prefer = (s.format === 'mp4' ? ['avc', 'hevc', 'vp9', 'av1'] : ['vp9', 'av1', 'vp8']) as typeof supported;
    const size = regionPixels(s);
    const codec = await mb.getFirstEncodableVideoCodec(prefer.filter(c => supported.includes(c)), { width: size.w, height: size.h, quality, frameRate: FPS });
    if (!codec) throw new Error(t('このブラウザでは {format} の動画を作れません。出力の形式か大きさを変えてください', { format: t(fmt.name) }));

    const output = new mb.Output({ format, target: new mb.BufferTarget() });
    const video = new mb.VideoSampleSource({ codec, quality, keyFrameInterval: 2 });
    output.addVideoTrack(video, { frameRate: FPS });
    // 曲: タイムラインの範囲だけを切り出す
    const audio = s.audio ? await this.musicClip(start / FPS, count / FPS) : null;
    let audioSource: InstanceType<typeof mb.AudioBufferSource> | null = null;
    if (audio) {
      const audioCodec = await mb.getFirstEncodableAudioCodec(format.getSupportedAudioCodecs(), { numberOfChannels: audio.numberOfChannels, sampleRate: audio.sampleRate });
      if (audioCodec) {
        audioSource = new mb.AudioBufferSource({ codec: audioCodec, quality: mb.QUALITY_HIGH });
        output.addAudioTrack(audioSource);
      }
    }
    await output.start();

    // 再生を止め、いまの位置を覚えておく (終わったら戻す)
    const wasPlaying = clock.playing, t0 = clock.t;
    if (wasPlaying) clock.setPlaying(false);
    this.cancelled = false;
    this.ui.set({ rendering: { done: 0, total: count } });
    try {
      this.begin();
      // 飛んだ先の姿勢に、物理演算をなじませる (再生を始めるときと同じ)。モーションブラーなら、シャッターが開くところから
      if (s.motionBlur) clock.seek(Math.max(start / FPS - s.shutter / FPS, 0)); else clock.seekFrame(start);
      const flat = this.flatCanvas();
      let yielded = performance.now();
      for (let i = 0; i < count; i++) {
        if (this.cancelled) throw new RenderCancelled();
        if (i > 0 && !s.motionBlur) {
          clock.advanceTo((start + i) / FPS);
          this.viewport.stepSystems(1 / FPS);
        }
        this.shoot(flat, (start + i) / FPS);
        const frame = new VideoFrame(flat, { timestamp: Math.round(i * 1e6 / FPS), duration: Math.round(1e6 / FPS) });
        const sample = new mb.VideoSample(frame, { timestamp: i / FPS, duration: 1 / FPS });
        try {
          await video.add(sample);
        } finally {
          sample.close();
        }
        // ときどき画面に戻して、進み具合を見せ、キャンセルを受け付ける
        if (performance.now() - yielded > 60 || i === count - 1) {
          this.ui.set({ rendering: { done: i + 1, total: count } });
          await new Promise(r => setTimeout(r, 0));
          yielded = performance.now();
        }
      }
      if (audioSource && audio) await audioSource.add(audio);
      await output.finalize();
    } catch (err) {
      await output.cancel().catch(() => {});
      throw err;
    } finally {
      this.end();
      this.ui.set({ rendering: null });
      clock.seek(t0);
      if (wasPlaying) clock.setPlaying(true);
    }
    return { bytes: new Uint8Array((output.target as InstanceType<typeof mb.BufferTarget>).buffer!), ext: fmt.ext, mime: format.mimeType, codec, frames: count };
  }

  // 書き出す大きさ (レンダー範囲があればその大きさ) の 2D の canvas (背景を塗ってから 3D の絵を重ね、透けない絵にする)
  private flatCanvas() {
    const { w, h } = regionPixels(this.settings);
    return Object.assign(document.createElement('canvas'), { width: w, height: h });
  }
  // 時刻 t の絵を to に描く。モーションブラーなら、シャッターが開いてから t までの時刻を順に描いて重ねる (平均)
  private shoot(to: HTMLCanvasElement, t: number) {
    const s = this.settings;
    if (!s.motionBlur) { this.viewport.render(); this.flatten(to); return; }
    const tmp = Object.assign(document.createElement('canvas'), { width: to.width, height: to.height });
    const g = to.getContext('2d')!;
    blurTimes(t, s.shutter, s.blurSamples, FPS).forEach((tk, k) => {
      const d = tk - this.clock.t;
      if (d > 0) { this.clock.advanceTo(tk); this.viewport.stepSystems(d); }
      this.viewport.render();
      this.flatten(tmp);
      g.globalAlpha = 1 / (k + 1); // (それまでの平均に、1 / 枚数 の重みで重ねる)
      g.drawImage(tmp, 0, 0);
    });
    g.globalAlpha = 1;
  }
  // 地面の影や半透明の物は、描いた所の透明度をそのまま残すので (画面では CSS の背景色が透けて見える)、
  // 書き出すときは背景色の上に重ねる
  private flatten(to: HTMLCanvasElement) {
    const g = to.getContext('2d')!;
    const r = regionPixels(this.settings);
    g.fillStyle = VIEWPORT_BG;
    g.fillRect(0, 0, to.width, to.height);
    g.drawImage(this.viewport.canvas!, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  }

  // 描く準備: 出力の大きさ・背景を塗る・編集用の表示を隠す
  private begin() {
    const { width, height } = this.settings;
    this.active = true;
    this.hooks.begin?.();
    this.gridWas = this.graph.grid.visible;
    this.graph.grid.visible = false;
    // ライトの目印など、ビューポートだけの物も描かない
    this.hidden = [];
    this.graph.scene.traverse(o => { if (o.userData.editorOnly && o.visible) this.hidden.push(o); });
    for (const o of this.hidden) o.visible = false;
    this.viewport.beginOutput(width, height, VIEWPORT_BG);
  }
  private gridWas = true;
  private hidden: THREE.Object3D[] = [];
  private end() {
    this.active = false;
    this.hooks.end?.();
    this.graph.grid.visible = this.gridWas;
    for (const o of this.hidden) o.visible = true;
    this.hidden = [];
    this.viewport.endOutput();
  }

  // 曲の from 秒から seconds 秒ぶん。曲が短ければ残りは無音、範囲に曲がなければ null
  private async musicClip(from: number, seconds: number): Promise<AudioBuffer | null> {
    const file = this.music.file;
    if (!file) return null;
    const decoded = await new OfflineAudioContext(2, 1, 48000).decodeAudioData(await file.arrayBuffer());
    const rate = decoded.sampleRate, offset = Math.round(from * rate);
    if (offset >= decoded.length) return null;
    const clip = new AudioBuffer({ numberOfChannels: decoded.numberOfChannels, sampleRate: rate, length: Math.max(Math.round(seconds * rate), 1) });
    for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
      clip.copyToChannel(decoded.getChannelData(ch).subarray(offset, offset + clip.length), ch);
    }
    return clip;
  }
}
