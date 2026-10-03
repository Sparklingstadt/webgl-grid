import { FPS, TL_DEFAULT_END } from '../../core/constants';
import { Emitter } from '../../core/events';
import type { System } from '../render/Viewport';

// 再生位置を決める外の時計 (曲)。曲が鳴っているあいだは、その再生位置に合わせて進める
export interface TimeSource {
  current(): number | null; // 鳴っていれば再生位置 (秒)、鳴っていなければ null
  waiting(): boolean;       // ブラウザに自動再生を止められ、ユーザーの操作を待っている
  resume(): void;           // ユーザーの操作で鳴らし直す
}

type ClockEvents = {
  seek: [t: number, warmup: number]; // 時刻が飛んだ (warmup: 物理演算をなじませる回数)
  advance: [dt: number];             // 再生で dt 秒進んだ
  play: [on: boolean];               // 再生・停止
  change: [];                        // フレーム・範囲・再生中かが変わった (画面に知らせる)
};

// --- タイムライン (再生・フレーム・範囲) ---
// 時刻はここが持ち、モーション・カメラ・曲・キーフレームはイベントを受けてそれに合わせる。
// 終了フレームまで行くと開始フレームに戻って繰り返す (Blender と同じ)。three.js にも画面にも依存しない
export class Clock implements System {
  t = 0;
  playing = false;
  start = 0;
  end = TL_DEFAULT_END;
  source: TimeSource | null = null;
  readonly events = new Emitter<ClockEvents>();
  private lastFrame = 0;

  get frame() { return Math.floor(this.t * FPS + 1e-6); }

  // 時刻 t (秒) へ飛ぶ
  seek(t: number, warmup = 30) {
    this.t = Math.max(0, t);
    this.events.emit('seek', this.t, warmup);
    this.changed();
  }
  seekFrame(f: number, warmup = 30) { this.seek(Math.round(f) / FPS, warmup); }
  stepFrame(delta: number) { this.seekFrame(this.frame + delta, 10); }
  jumpToStart() { this.seekFrame(this.start); }
  jumpToEnd() { this.seekFrame(this.end); }

  setPlaying(on: boolean) {
    this.playing = on;
    if (on && this.frame >= this.end) this.seek(this.start / FPS); // 最後まで行っていたら最初から
    this.events.emit('play', on);
    this.changed();
  }
  // 再生中なのに曲が自動再生を止められて待っているときは、止めずに曲を鳴らす (▶ を押すのはユーザーの操作なので鳴らせる)
  togglePlay() {
    if (this.playing && this.source?.waiting()) this.source.resume();
    else this.setPlaying(!this.playing);
  }
  setRange(start: number, end: number) {
    this.start = Math.max(0, Math.round(start));
    this.end = Math.max(this.start + 1, Math.round(end));
    this.changed();
  }
  // 中身の長さ (フレーム) に終了フレームを合わせる
  fitEnd(contentFrames: number) {
    if (contentFrames <= 0) return;
    const end = Math.ceil(contentFrames);
    this.setRange(Math.min(this.start, end - 1), end);
  }
  // 最初の状態 (0〜250 フレーム、止めて 0 フレーム目) に戻す
  reset() {
    this.playing = false;
    this.events.emit('play', false);
    this.setRange(0, TL_DEFAULT_END);
    this.seek(0);
  }

  // 毎フレーム、再生中なら時刻を進める。曲があるときは曲の再生位置に合わせる
  active() { return this.playing; }
  update(dt: number) {
    if (!this.playing || this.source?.waiting()) return;
    let d = dt;
    const st = this.source?.current();
    if (st != null) {
      // 少しのずれはなめらかに寄せ、大きくずれたら一気に合わせる
      const drift = st - this.t;
      d = Math.abs(drift) > 0.5 ? drift : Math.max(dt + drift * 0.1, 0);
    }
    const nt = this.t + d;
    if (nt * FPS >= this.end + 1) { this.seek(this.start / FPS); return; } // 最後まで行ったら最初に戻る
    if (d < 0) { this.seek(nt, 10); return; }
    this.t = nt;
    this.events.emit('advance', d);
    if (this.frame !== this.lastFrame) this.changed();
  }

  // 再生と同じように (飛ばずに) 時刻 t まで進める。レンダリングで 1 フレームずつ進めるときに使う (曲には合わせない)
  advanceTo(t: number) {
    const d = t - this.t;
    if (d <= 0) return;
    this.t = t;
    this.events.emit('advance', d);
    this.changed();
  }

  private changed() {
    this.lastFrame = this.frame;
    this.events.emit('change');
  }
}
