import { FPS } from '../../core/constants';
import { Emitter } from '../../core/events';
import { t } from '../../core/i18n';
import type { UiChannel } from '../UiChannel';
import type { TimeSource } from './Clock';

const tapToPlay = () => t('画面をタップ (クリック) するか ▶ を押すと曲を再生します');

// --- 曲 ---
// タイムラインの再生と一緒に鳴らす。鳴っているあいだは、タイムラインがこの再生位置に合わせて進む (TimeSource)。
// 読み込んだら、フレームごとの音の大きさ (波形) を求めて、タイムラインに描く
export class Music implements TimeSource {
  audio: HTMLAudioElement | null = null;
  file: File | null = null; // 曲のファイル (プロジェクトに入れる)
  waveform: Float32Array | null = null; // フレームごとの音の大きさ (0〜1。いちばん大きい振れ幅)
  private isWaiting = false; // ブラウザに自動再生を止められ、画面を触るのを待っている
  readonly events = new Emitter<{ loaded: [duration: number]; playing: []; waveform: [] }>();
  // 再生中か (タイムラインの状態)。自動再生を止められたときに、待つかどうかを決める
  constructor(private ui: UiChannel, private isPlaying: () => boolean) {}

  get duration() { return this.audio && Number.isFinite(this.audio.duration) ? this.audio.duration : null; }

  load(file: File) {
    this.stop();
    this.file = file;
    const audio = this.audio = new Audio(URL.createObjectURL(file));
    // 長さが分かったら知らせる (終了フレームを曲の長さまで延ばす)
    audio.addEventListener('loadedmetadata', () => { if (this.audio === audio && this.duration) this.events.emit('loaded', this.duration); });
    audio.addEventListener('play', () => this.events.emit('playing'));
    void this.analyze(file);
  }
  private async analyze(file: File) {
    if (typeof OfflineAudioContext === 'undefined') return;
    try {
      const buf = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(await file.arrayBuffer());
      if (this.file !== file) return; // (読んでいるあいだに替わった)
      const per = buf.sampleRate / FPS, out = new Float32Array(Math.ceil(buf.length / per));
      for (let ch = 0; ch < buf.numberOfChannels; ch++) {
        const data = buf.getChannelData(ch);
        for (let i = 0; i < data.length; i++) {
          const a = Math.abs(data[i]), f = (i / per) | 0;
          if (a > out[f]) out[f] = a;
        }
      }
      this.waveform = out;
      this.events.emit('waveform');
    } catch { /* 波形が描けなくても鳴らせる */ }
  }
  stop() {
    if (!this.audio) return;
    this.audio.pause();
    URL.revokeObjectURL(this.audio.src);
    this.audio = null;
    this.file = null;
    this.isWaiting = false;
    if (this.waveform) { this.waveform = null; this.events.emit('waveform'); }
  }

  // タイムラインが時刻 t へ飛んだ・再生/停止したときに、位置と鳴らすかどうかを合わせる
  syncTo(t: number, playing: boolean) {
    const { audio } = this;
    if (!audio) return;
    const dur = this.duration;
    audio.currentTime = dur ? Math.min(t, dur) : t;
    if (playing && !(dur && t >= dur)) this.play(); else audio.pause();
  }
  setPlaying(playing: boolean, t: number) {
    if (!this.audio) return;
    if (playing && !(this.duration && t >= this.duration)) this.play(); else this.audio.pause();
  }
  private play() {
    const { audio } = this;
    if (!audio) return;
    this.isWaiting = false;
    audio.play().then(() => {
      if (this.ui.state.toast?.text === tapToPlay()) this.ui.hideToast(); // 「画面をタップ…」のお知らせを消す
    }, () => {
      if (!this.isPlaying()) return;
      this.isWaiting = true;
      this.ui.toast(tapToPlay(), 0);
    });
  }

  // --- TimeSource ---
  current() {
    const { audio } = this;
    return audio && !audio.paused && !audio.ended ? audio.currentTime : null;
  }
  waiting() { return this.isWaiting; }
  resume() { if (this.isWaiting) this.play(); }
}
