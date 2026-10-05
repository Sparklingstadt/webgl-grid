// --- レンダーエンジン (標準 / MME 互換) の設定 (プロジェクトの場面の値 'mme') ---
export interface MmeSettings { engine: 'standard' | 'mme'; selfShadow: boolean; shadowDistance: number; groundShadow: boolean }
// shadowDistance: セルフシャドウの範囲 (MMD の影の距離と同じく、大きいほど狭くくっきりする。8875 で標準のエンジンの太陽の影と同じ)
export const MME_DEFAULTS: MmeSettings = { engine: 'standard', selfShadow: true, shadowDistance: 8875, groundShadow: true };
export const SHADOW_DISTANCE_MAX = 9999;

// 保存されていた設定を、使える値にそろえる (知らない値は既定、影の距離は 0〜9999)
export function normalizeMme(raw: unknown): MmeSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
  const d = o.shadowDistance;
  return {
    engine: o.engine === 'mme' || o.engine === 'standard' ? o.engine : MME_DEFAULTS.engine,
    selfShadow: bool(o.selfShadow, MME_DEFAULTS.selfShadow),
    shadowDistance: typeof d === 'number' && Number.isFinite(d) ? Math.min(Math.max(d, 0), SHADOW_DISTANCE_MAX) : MME_DEFAULTS.shadowDistance,
    groundShadow: bool(o.groundShadow, MME_DEFAULTS.groundShadow),
  };
}
