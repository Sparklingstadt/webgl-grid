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

// --- 物ごと・材質ごとのエフェクトの割り当て (物の値 'mme'。Obj.mme) ---
// EffectRef: 読み込んだフォルダ (EffectStore のフォルダの id) の中の .fx (フォルダからの相対パス)
export interface EffectRef { folder: string; path: string }
// エフェクトか、描かない (hide)
export type SavedSlot = EffectRef | 'hide';
// 1 つのタブ ('Main' かオフスクリーン) の割り当て: 物全体と、材質ごと (キーは材質の番号)。材質の割り当てが先
export interface TabEffects { object?: SavedSlot; materials?: Record<string /* 材質の番号 */, SavedSlot> }
export type ObjectEffects = Record<string /* 'Main' かオフスクリーンの名前 */, TabEffects>;

function normalizeSlot(raw: unknown): SavedSlot | null {
  if (raw === 'hide') return 'hide';
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { folder, path } = raw as Record<string, unknown>;
  return typeof folder === 'string' && folder !== '' && typeof path === 'string' && path !== '' ? { folder, path } : null;
}

// 保存されていた割り当てを、使える値にそろえる (壊れた項・材質の番号でないキーは捨てる)。何も残らなければ null
export function normalizeObjectEffects(raw: unknown): ObjectEffects | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: ObjectEffects = {};
  for (const [tab, value] of Object.entries(raw as Record<string, unknown>)) {
    if (tab === '' || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const v = value as Record<string, unknown>;
    const effects: TabEffects = {};
    const object = normalizeSlot(v.object);
    if (object) effects.object = object;
    if (v.materials && typeof v.materials === 'object' && !Array.isArray(v.materials)) {
      const materials: Record<string, SavedSlot> = {};
      for (const [k, m] of Object.entries(v.materials as Record<string, unknown>)) {
        const slot = /^(0|[1-9]\d*)$/.test(k) ? normalizeSlot(m) : null;
        if (slot) materials[k] = slot;
      }
      if (Object.keys(materials).length > 0) effects.materials = materials;
    }
    if (effects.object || effects.materials) out[tab] = effects;
  }
  return Object.keys(out).length > 0 ? out : null;
}
