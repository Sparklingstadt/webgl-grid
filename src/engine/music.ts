import { FPS } from './constants';
import { startTicking } from './loop';
import { fitEndToContent, seek, setPlaying, tl } from './timeline';
import { hideToast, toast, ui } from './ui';

// --- 曲 ---
// 曲のファイルを一緒に選ぶと、タイムラインの再生と一緒に再生する。再生位置は曲に合わせる (timeline.ts)
export let music: HTMLAudioElement | null = null;
export let musicWaiting = false; // ブラウザに自動再生を止められ、画面を触るのを待っている

export function startMusic(file: File, announce = true) {
  stopMusic();
  const m = music = new Audio(URL.createObjectURL(file));
  // 長さが分かったら、終了フレームを曲の長さまで延ばす
  m.addEventListener('loadedmetadata', () => { if (music === m) fitEndToContent(); });
  m.addEventListener('play', () => startTicking());
  // ダンスとカメラも最初から合わせて再生する (自動再生を止められたら、そのお知らせがあとから出る)
  seek(tl.start / FPS);
  setPlaying(true);
  if (announce) toast(`${file.name} を再生しています`);
}
export function playMusic() {
  if (!music) return;
  musicWaiting = false;
  music.play().then(() => {
    if (ui.get().toast?.text.startsWith('画面をタップ')) hideToast(); // 「画面をタップ…」のお知らせを消す
  }, () => {
    if (!tl.playing) return;
    musicWaiting = true;
    toast('画面をタップ (クリック) するか ▶ を押すと曲を再生します', 0);
  });
}
export function stopMusic() {
  if (!music) return;
  music.pause();
  URL.revokeObjectURL(music.src);
  music = null;
  musicWaiting = false;
}
