import { FPS } from './constants';
import { msg, t } from './i18n';

// --- 出力 (Blender の出力プロパティ): レンダリングする画像・動画の大きさと形式 ---
export type VideoFormat = 'mp4' | 'webm';
export type VideoQuality = 'medium' | 'high' | 'veryHigh';
export interface OutputSettings {
  width: number;
  height: number;
  format: VideoFormat;
  quality: VideoQuality;
  audio: boolean; // 曲を動画に入れる
}
export const OUTPUT_DEFAULT: OutputSettings = { width: 1920, height: 1080, format: 'mp4', quality: 'high', audio: true };

export const RESOLUTION_PRESETS: { name: string; width: number; height: number }[] = [
  { name: msg('フル HD (1920×1080)'), width: 1920, height: 1080 },
  { name: 'HD (1280×720)', width: 1280, height: 720 },
  { name: '4K (3840×2160)', width: 3840, height: 2160 },
  { name: msg('縦長 フル HD (1080×1920)'), width: 1080, height: 1920 },
  { name: msg('正方形 (1080×1080)'), width: 1080, height: 1080 },
];
export const VIDEO_FORMATS: { key: VideoFormat; name: string; ext: string }[] = [
  { key: 'mp4', name: 'MPEG-4 (H.264)', ext: 'mp4' },
  { key: 'webm', name: 'WebM (VP9)', ext: 'webm' },
];
export const VIDEO_QUALITIES: { key: VideoQuality; name: string }[] = [
  { key: 'medium', name: msg('標準') }, { key: 'high', name: msg('高') }, { key: 'veryHigh', name: msg('最高') },
];

export const OUTPUT_MIN = 16;
export const OUTPUT_MAX = 4096; // WebGL で確実に描ける大きさ
// 動画の圧縮 (YUV 4:2:0) は縦横とも偶数でないと作れないので、偶数にそろえる
export function clampOutputSize(v: number) {
  if (!Number.isFinite(v)) return OUTPUT_MIN;
  return Math.min(Math.max(Math.round(v / 2) * 2, OUTPUT_MIN), OUTPUT_MAX);
}
export const presetIndex = (w: number, h: number) => RESOLUTION_PRESETS.findIndex(p => p.width === w && p.height === h);

// 開始〜終了フレーム (両端を含む。Blender と同じ) のフレーム数と長さ (秒)
export function frameSpan(start: number, end: number) {
  const count = Math.max(end - start + 1, 1);
  return { count, seconds: count / FPS };
}

// 保存するファイルの名前。画像は Blender と同じく 4 桁のフレーム番号を付ける
export function outputFileName(base: string, ext: string, frame?: number) {
  const safe = base.replace(/[\\/:*?"<>|]/g, '_').trim() || t('レンダー');
  return frame === undefined ? `${safe}.${ext}` : `${safe}_${String(frame).padStart(4, '0')}.${ext}`;
}

// 保存されていた設定を、使える値にそろえる (プロジェクトを開くとき)
export function normalizeOutput(o: Partial<OutputSettings> | undefined): OutputSettings {
  const s = { ...OUTPUT_DEFAULT, ...o };
  return {
    width: clampOutputSize(s.width), height: clampOutputSize(s.height),
    format: VIDEO_FORMATS.some(f => f.key === s.format) ? s.format : OUTPUT_DEFAULT.format,
    quality: VIDEO_QUALITIES.some(q => q.key === s.quality) ? s.quality : OUTPUT_DEFAULT.quality,
    audio: !!s.audio,
  };
}

// ビューポート (viewW × viewH) の中で、出力 (outW × outH) として描かれる範囲 (Blender のカメラの枠)。
// 枠はビューポートに収まる一番大きな同じ縦横比の四角で、真ん中に置く。
// fovScale: 書き出すときの縦の画角の tan を何倍にするか (枠の高さ ÷ ビューポートの高さ)。
// これで、枠の中に見えているものがそのまま書き出される
export function outputFrame(viewW: number, viewH: number, outW: number, outH: number) {
  const a = outW / outH;
  const w = Math.min(viewW, viewH * a), h = w / a;
  return { x: (viewW - w) / 2, y: (viewH - h) / 2, w, h, fovScale: h / viewH };
}
// 縦の画角 fov (度) を、tan で k 倍にした画角
export const scaleFov = (fov: number, k: number) => (2 * Math.atan(Math.tan((fov * Math.PI) / 360) * k) * 180) / Math.PI;
