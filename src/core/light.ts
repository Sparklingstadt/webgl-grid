import { hexToRgb, rgbToHex } from './hsv';

// --- ライトのオブジェクト (Cinema 4D のライト): 点光源・スポットライト・エリアライト ---
// 置いた物と同じく位置 (x, z) と向き (縦軸まわりの回転) を持ち、高さは自分で決める (積み重ねには加わらない)。
// スポット・エリアは、真下から tiltDeg だけ、物の向き (前) へ傾けて照らす
export type LightType = 'point' | 'spot' | 'area';
export interface LightSettings {
  type: LightType;
  color: string;      // "#rrggbb"
  intensity: number;  // 明るさ (three.js の単位。点・スポットはカンデラ、エリアはニト)
  height: number;     // 床からの高さ
  range: number;      // 届く距離 (0 で果てしなく)
  angleDeg: number;   // スポット: 光の広がり (円すいの半分の角度)
  softness: number;   // スポット: 縁のぼけ (0〜1)
  tiltDeg: number;    // スポット・エリア: 真下からの傾き
  width: number;      // エリア: 大きさ
  depth: number;
  shadows: boolean;   // 影を落とす (エリアは落とせない)
}
export const LIGHT_TYPES: { key: LightType; name: string }[] = [
  { key: 'point', name: '点光源' }, { key: 'spot', name: 'スポットライト' }, { key: 'area', name: 'エリアライト' },
];
export const LIGHT_KIND = 12; // 物の種類の番号 (形・モデルと重ならない)
export const lightName = (type: LightType) => LIGHT_TYPES.find(t => t.key === type)?.name ?? 'ライト';

export const lightDefault = (type: LightType): LightSettings => ({
  type, color: '#ffffff', intensity: type === 'point' ? 30 : type === 'spot' ? 80 : 6,
  height: type === 'area' ? 3 : 3.5, range: 0, angleDeg: 30, softness: 0.3, tiltDeg: 0, width: 2, depth: 2, shadows: type !== 'area',
});

export function normalizeLight(o: Partial<LightSettings> | undefined): LightSettings {
  const type = LIGHT_TYPES.some(t => t.key === o?.type) ? o!.type! : 'point';
  const d = lightDefault(type), s = o ?? {};
  const num = (v: unknown, dv: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : dv);
  return {
    type, color: typeof s.color === 'string' && hexToRgb(s.color) ? rgbToHex(hexToRgb(s.color)!) : d.color,
    intensity: num(s.intensity, d.intensity, 0, 10000), height: num(s.height, d.height, 0.05, 100), range: num(s.range, d.range, 0, 1000),
    angleDeg: num(s.angleDeg, d.angleDeg, 1, 89), softness: num(s.softness, d.softness, 0, 1), tiltDeg: num(s.tiltDeg, d.tiltDeg, -180, 180),
    width: num(s.width, d.width, 0.05, 50), depth: num(s.depth, d.depth, 0.05, 50),
    shadows: type === 'area' ? false : typeof s.shadows === 'boolean' ? s.shadows : d.shadows,
  };
}

// スポット・エリアの照らす向き (物の向きで回す前。y は下向きがマイナス)
export function lightAim(tiltDeg: number): [number, number, number] {
  const t = tiltDeg * Math.PI / 180;
  return [0, -Math.cos(t), Math.sin(t)];
}
