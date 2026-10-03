import { hexToRgb, rgbToHex } from './hsv';

// --- 保存されていた・外から渡された値を、使える値にそろえる (設定の normalize で使う) ---
// 数 (でなければ d)。lo・hi を渡すと、その範囲に収める
export const num = (v: unknown, d: number, lo = -Infinity, hi = Infinity) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : d;
// 整数 (丸めて lo〜hi に収める。数でなければ d)
export const int = (v: unknown, d: number, lo: number, hi: number) => Math.round(num(v, d, lo, hi));
export const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
// "#rrggbb" (小文字にそろえる。色でなければ d)
export const hex = (v: unknown, d: string) => (typeof v === 'string' && hexToRgb(v) ? rgbToHex(hexToRgb(v)!) : d);
// 一覧 ({ key }) のどれか
export const oneOf = <K>(v: unknown, list: readonly { key: K }[], d: K): K => (list.some(x => x.key === v) ? v as K : d);
// 3 つの数 (足りない・数でないところは d のまま)
export const vec3 = (v: unknown, d: [number, number, number]): [number, number, number] =>
  Array.isArray(v) ? d.map((x, i) => num(v[i], x)) as [number, number, number] : [...d];
