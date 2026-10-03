import { FPS, SHAPE_NAMES, TL_DEFAULT_END } from './constants';
import { applyAllKeys } from './keyframes';
import { requestDraw, startTicking } from './loop';
import { camMotion, hasMotion, seekMotions, updateMotions } from './mmd/motion';
import { music, musicWaiting, playMusic } from './music';
import { boxes } from './objects';
import { selModel, selObj } from './selection';
import { ui } from './ui';

// --- タイムライン (再生・フレーム) ---
// 時刻はタイムラインが持ち、モーション・カメラ・曲・キーフレームをそれに合わせる。
// 終了フレームまで行くと開始フレームに戻って繰り返す (Blender と同じ)
export const tl = { t: 0, playing: false, start: 0, end: TL_DEFAULT_END };
export const currentFrame = () => Math.floor(tl.t * FPS + 1e-6);
function publishTl() {
  ui.set({ frame: currentFrame(), playing: tl.playing, start: tl.start, end: tl.end });
}

// 時刻 t (秒) へ飛ぶ。warmup は物理演算をなじませる回数 (ドラッグで動かしている間は少なく)
export function seek(t: number, warmup = 30) {
  tl.t = Math.max(0, t);
  seekMotions(tl.t, warmup);
  if (music) {
    const dur = music.duration;
    music.currentTime = Number.isFinite(dur) ? Math.min(tl.t, dur) : tl.t;
    if (tl.playing && !(tl.t >= dur)) playMusic(); else music.pause();
  }
  applyAllKeys(true);
  publishTl();
  startTicking();
  requestDraw();
}
export const seekFrame = (f: number, warmup = 30) => seek(Math.round(f) / FPS, warmup);
export function setPlaying(on: boolean) {
  tl.playing = on;
  if (on && currentFrame() >= tl.end) seek(tl.start / FPS); // 最後まで行っていたら最初から
  if (music) {
    if (on && !(tl.t >= music.duration)) playMusic(); else music.pause();
  }
  publishTl();
  startTicking();
}
// 再生中なのに曲が自動再生を止められて待っているときは、止めずに曲を鳴らす (▶ を押すのはユーザーの操作なので鳴らせる)
export function togglePlay() {
  if (tl.playing && musicWaiting) playMusic();
  else setPlaying(!tl.playing);
}
export function setRange(start: number, end: number) {
  start = Math.max(0, Math.round(start));
  end = Math.max(start + 1, Math.round(end));
  Object.assign(tl, { start, end });
  publishTl();
}
// 最初の状態 (0〜250 フレーム、止めて 0 フレーム目) に戻す
export function resetTimeline() {
  tl.playing = false;
  Object.assign(tl, { start: 0, end: TL_DEFAULT_END });
  seek(0);
}
// モーション・曲・キーフレームのうち一番長いものに、終了フレームを合わせる
export function fitEndToContent() {
  let end = 0;
  for (const b of boxes) {
    if (b.motion) end = Math.max(end, b.motion.duration * FPS);
    if (b.keys) end = Math.max(end, ...b.keys.keys());
  }
  if (camMotion) end = Math.max(end, camMotion.motion.duration * FPS);
  if (music && Number.isFinite(music.duration)) end = Math.max(end, music.duration * FPS);
  if (end > 0) setRange(Math.min(tl.start, Math.ceil(end) - 1), Math.ceil(end));
}
// 毎フレーム、再生中なら時刻を進める。曲があるときは曲の再生位置に合わせる
export function advanceTimeline(dt: number) {
  if (!tl.playing || musicWaiting) return;
  let d = dt;
  if (music && !music.paused && !music.ended) {
    // 少しのずれはなめらかに寄せ、大きくずれたら一気に合わせる
    const drift = music.currentTime - tl.t;
    d = Math.abs(drift) > 0.5 ? drift : Math.max(dt + drift * 0.1, 0);
  }
  const nt = tl.t + d;
  if (nt * FPS >= tl.end + 1) { seek(tl.start / FPS); return; } // 最後まで行ったら最初に戻る
  if (d < 0) { seek(nt, 10); return; }
  tl.t = nt;
  updateMotions(d);
  applyAllKeys();
  if (currentFrame() !== ui.get().frame) publishTl();
}
export const isPlaying = () => tl.playing || hasMotion();

export function stepFrame(delta: number) { seekFrame(currentFrame() + delta, 10); }
export const jumpToStart = () => seekFrame(tl.start);
export const jumpToEnd = () => seekFrame(tl.end);
// 前後のキーフレーム (選んでいるモデルのキーフレームと、モーションのキーフレーム) へ
export function jumpKey(dir: 1 | -1) {
  const f = currentFrame();
  const all = getTimelineRows().flatMap(r => [...r.keys, ...(r.motion ?? [])]);
  const next = dir > 0 ? Math.min(...all.filter(k => k > f)) : Math.max(...all.filter(k => k < f));
  if (Number.isFinite(next)) seekFrame(next, 10);
}

// タイムラインに並べる行: 選んでいる物 (モデルならキーフレームとモーション) と、カメラモーション
export interface TlRow { label: string; keys: number[]; motion: Int32Array | null; editable: boolean }
export function getTimelineRows(): TlRow[] {
  const rows: TlRow[] = [];
  const obj = selModel();
  if (obj) {
    rows.push({ label: obj.model.name || 'モデル', keys: [...(obj.keys?.keys() ?? [])].sort((a, b) => a - b), motion: obj.motion?.frames ?? null, editable: true });
  } else if (selObj) {
    rows.push({ label: SHAPE_NAMES[selObj.s], keys: [], motion: null, editable: false });
  }
  if (camMotion) rows.push({ label: 'カメラ', keys: [], motion: camMotion.motion.frames, editable: false });
  return rows;
}
