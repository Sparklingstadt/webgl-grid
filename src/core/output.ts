import { FPS } from './constants';
import { msg, t } from './i18n';

// --- 出力 (Blender の出力プロパティ): レンダリングする画像・動画の大きさと形式 ---
export type VideoFormat = 'mp4' | 'webm';
export type VideoQuality = 'medium' | 'high' | 'veryHigh';
// レンダー範囲 (Blender の Ctrl+B): 出力の枠の中の四角 (0〜1。左上から)。その部分だけを切り出して書き出す
export interface RenderRegion { x: number; y: number; w: number; h: number }
export interface OutputSettings {
  width: number;
  height: number;
  format: VideoFormat;
  quality: VideoQuality;
  audio: boolean;        // 曲を動画に入れる
  motionBlur: boolean;   // モーションブラー (Blender のレンダーのモーションブラー)
  shutter: number;       // シャッター (フレームの長さに対する割合。0.5 で半フレームぶん写す)
  blurSamples: number;   // 1 フレームを何回に分けて描いて重ねるか
  region: RenderRegion | null;
}
export const OUTPUT_DEFAULT: OutputSettings = { width: 1920, height: 1080, format: 'mp4', quality: 'high', audio: true, motionBlur: false, shutter: 0.5, blurSamples: 8, region: null };

export const RESOLUTION_PRESETS: { name: string; width: number; height: number }[] = [
  { name: msg('フル HD (1920×1080)'), width: 1920, height: 1080 },
  { name: 'HD (1280×720)', width: 1280, height: 720 },
  { name: '4K (3840×2160)', width: 3840, height: 2160 },
  { name: msg('縦長 フル HD (1080×1920)'), width: 1080, height: 1920 },
  { name: msg('正方形 (1080×1080)'), width: 1080, height: 1080 },
];
// 出力のプリセット (大きさ・形式・画質をまとめて。Blender の出力のプリセット)
export interface OutputPreset { name: string; width: number; height: number; format: VideoFormat; quality: VideoQuality }
export const OUTPUT_PRESETS: OutputPreset[] = [
  { name: msg('YouTube (1920×1080・MP4・高)'), width: 1920, height: 1080, format: 'mp4', quality: 'high' },
  { name: msg('YouTube 4K (3840×2160・MP4・最高)'), width: 3840, height: 2160, format: 'mp4', quality: 'veryHigh' },
  { name: msg('ショート動画 (1080×1920・MP4・高)'), width: 1080, height: 1920, format: 'mp4', quality: 'high' },
  { name: msg('SNS 用 (1280×720・MP4・標準)'), width: 1280, height: 720, format: 'mp4', quality: 'medium' },
  { name: msg('正方形 (1080×1080・MP4・高)'), width: 1080, height: 1080, format: 'mp4', quality: 'high' },
  { name: msg('WebM (1920×1080・VP9・高)'), width: 1920, height: 1080, format: 'webm', quality: 'high' },
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
    motionBlur: !!s.motionBlur,
    shutter: Number.isFinite(s.shutter) ? Math.min(Math.max(s.shutter, 0.05), 1) : OUTPUT_DEFAULT.shutter,
    blurSamples: Number.isFinite(s.blurSamples) ? Math.min(Math.max(Math.round(s.blurSamples), 2), 32) : OUTPUT_DEFAULT.blurSamples,
    region: normalizeRegion(s.region),
  };
}
export function normalizeRegion(r: Partial<RenderRegion> | null | undefined): RenderRegion | null {
  if (!r) return null;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : NaN);
  const x = n(r.x), y = n(r.y), w = Math.min(n(r.w), 1 - x), h = Math.min(n(r.h), 1 - y);
  if (![x, y, w, h].every(Number.isFinite) || w < 0.01 || h < 0.01) return null;
  return { x, y, w, h };
}
// 書き出す範囲 (ピクセル)。範囲がなければ全体。動画にできるよう、大きさは偶数で 16 以上
export function regionPixels(s: Pick<OutputSettings, 'width' | 'height' | 'region'>) {
  const r = s.region;
  if (!r) return { x: 0, y: 0, w: s.width, h: s.height };
  const w = Math.min(clampOutputSize(r.w * s.width), s.width), h = Math.min(clampOutputSize(r.h * s.height), s.height);
  return { x: Math.min(Math.round(r.x * s.width), s.width - w), y: Math.min(Math.round(r.y * s.height), s.height - h), w, h };
}
// モーションブラーで重ねる時刻 (秒): フレームの時刻 t の、シャッターが開いてから t までを samples 回に分けた時刻
export function blurTimes(t: number, shutter: number, samples: number, fps: number) {
  return Array.from({ length: samples }, (_, k) => t - shutter / fps * (1 - (k + 1) / samples));
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
