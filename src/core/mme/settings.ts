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

// --- MME の物 (物の値 'mmeObj'。Obj.mmeObj): 形のない物。仮のコントローラー (ray_controller.pmx の代わり) と仮のアクセサリ (ray.x の代わり) ---
// name は物の名前と同じ (CONTROLOBJECT・DefaultEffect はこの名前で照らす。アウトライナーで名前を変えると変わる)
export interface MmeObjData { kind: 'controller' | 'accessory'; name: string }
export const MME_OBJ_KIND = 14; // 物の種類の番号 (形・モデル・ライト・カメラと重ならない)
const MME_NAME_MAX = 64; // (物の名前と同じ長さまで)

// 保存されていた値を、使える値にそろえる (種類が分からない・名前が空なら null。名前は前後の空白を除く)
export function normalizeMmeObj(raw: unknown): MmeObjData | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { kind, name } = raw as Record<string, unknown>;
  const n = typeof name === 'string' ? name.trim().slice(0, MME_NAME_MAX) : '';
  return (kind === 'controller' || kind === 'accessory') && n !== '' ? { kind, name: n } : null;
}

// --- プロジェクトの場面の値 'mme': 設定・読み込んだフォルダ (id と名前。中のファイルはプロジェクトの mmeFiles)・ポストエフェクトの並び・
// 仮のコントローラーの値 (名前 → 項目 → 0〜1)・ステージの割り当て (なければ項がない)。物ごとの割り当ては物の値 'mme' ---
export interface MmeScene {
  settings: MmeSettings;
  folders: { id: string; name: string }[];
  posts: { effect: EffectRef; enabled: boolean }[];
  controls: Record<string, Record<string, number>>;
  stage?: ObjectEffects;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

// 保存されていた場面の値を、使える値にそろえる。第 2 の計画の形 (いちばん上に engine がある = 設定だけ) も読む。
// 壊れた項は捨てる: id のない・builtin (default.fx のフォルダ)・同じ id のフォルダ、参照が壊れたポストエフェクト (enabled がなければオン)、
// 数でないコントローラーの値 (値は 0〜1 に収める)、ステージの割り当ての壊れた項 (normalizeObjectEffects。何も残らなければ項を作らない)
export function normalizeMmeScene(raw: unknown): MmeScene {
  const o = isRecord(raw) ? raw : {};
  if ('engine' in o) return { settings: normalizeMme(o), folders: [], posts: [], controls: {} };
  const folders: MmeScene['folders'] = [];
  for (const f of Array.isArray(o.folders) ? o.folders : []) {
    if (!isRecord(f) || typeof f.id !== 'string' || f.id === '' || f.id === 'builtin' || folders.some(x => x.id === f.id)) continue;
    folders.push({ id: f.id, name: typeof f.name === 'string' ? f.name : '' });
  }
  const posts: MmeScene['posts'] = [];
  for (const p of Array.isArray(o.posts) ? o.posts : []) {
    const slot = isRecord(p) ? normalizeSlot(p.effect) : null;
    if (slot && slot !== 'hide') posts.push({ effect: slot, enabled: (p as Record<string, unknown>).enabled !== false });
  }
  const controls: MmeScene['controls'] = {};
  for (const [name, items] of Object.entries(isRecord(o.controls) ? o.controls : {})) {
    if (name === '' || !isRecord(items)) continue;
    const values: Record<string, number> = {};
    for (const [item, v] of Object.entries(items)) if (typeof v === 'number' && Number.isFinite(v)) values[item] = Math.min(Math.max(v, 0), 1);
    if (Object.keys(values).length > 0) controls[name] = values;
  }
  const stage = normalizeObjectEffects(o.stage);
  return { settings: normalizeMme(o.settings), folders, posts, controls, ...(stage ? { stage } : {}) };
}
