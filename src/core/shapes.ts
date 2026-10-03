import { msg, t } from './i18n';

// --- 置ける形 (Cinema 4D のプリミティブ) ---
// s は物の種類の番号 (保存にも使う)。3 は MMD モデルなので、形には使わない
//   h: 高さ (積み重ねの足場)、hx / hz: 上から見た足場の半分の幅、flat: 面ごとに平らな陰影
export interface ShapeDef { s: number; key: string; name: string; h: number; hx: number; hz: number; flat?: boolean }
export const MODEL_KIND = 3;
export const SHAPES: ShapeDef[] = [
  { s: 0, key: 'cube', name: msg('立方体'), h: 1, hx: 0.5, hz: 0.5 },
  { s: 4, key: 'sphere', name: msg('球'), h: 1, hx: 0.5, hz: 0.5 },
  { s: 5, key: 'cylinder', name: msg('円柱'), h: 1, hx: 0.5, hz: 0.5 },
  { s: 6, key: 'cone', name: msg('円錐'), h: 1, hx: 0.5, hz: 0.5 },
  { s: 7, key: 'capsule', name: msg('カプセル'), h: 1.2, hx: 0.3, hz: 0.3 },
  { s: 1, key: 'torus', name: msg('トーラス'), h: 0.3, hx: 0.5, hz: 0.5 },
  { s: 8, key: 'tube', name: msg('チューブ'), h: 1, hx: 0.5, hz: 0.5 },
  { s: 9, key: 'disc', name: msg('円盤'), h: 0.1, hx: 0.5, hz: 0.5 },
  { s: 10, key: 'plane', name: msg('平面'), h: 0.02, hx: 1, hz: 1 },
  { s: 2, key: 'pyramid', name: msg('三角錐'), h: 0.8, hx: 0.5, hz: 0.5, flat: true },
  { s: 11, key: 'icosahedron', name: msg('正二十面体'), h: 0.85, hx: 0.5, hz: 0.5, flat: true },
];
const bySs = new Map(SHAPES.map(d => [d.s, d]));
export const shapeDef = (s: number) => bySs.get(s) ?? SHAPES[0];
export const shapeName = (s: number) => (s === MODEL_KIND ? t('MMD モデル') : t(shapeDef(s).name));
// 名前・キー・番号から形の番号を探す (見つからなければ null)
export function findShape(v: unknown): number | null {
  if (typeof v === 'number') return bySs.has(v) ? v : null;
  const d = SHAPES.find(x => x.key === v || x.name === v);
  return d ? d.s : null;
}
