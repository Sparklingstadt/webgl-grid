import { hexToRgb, rgbToHex } from './hsv';

// --- ライトのオブジェクト (Blender のライト): ポイント・サン・スポット・エリア ---
// 置いた物と同じく位置 (x, z) と向き (縦軸まわりの回転) を持ち、高さは自分で決める (積み重ねには加わらない)。
// サン・スポット・エリアは、真下から tiltDeg だけ、物の向き (前) へ傾けて照らす。
// 明るさは Blender と同じ単位: ポイント・スポット・エリアはパワー (W)、サンは強さ (W/m²)。
// three.js の明るさへは、Blender と同じ定義で直す (lightIntensity)
export type LightType = 'point' | 'sun' | 'spot' | 'area';
export type AreaShape = 'square' | 'rectangle';
export interface LightSettings {
  type: LightType;
  color: string;        // "#rrggbb"
  power: number;        // ポイント・スポット・エリア: パワー (W)
  strength: number;     // サン: 強さ (W/m²)
  radius: number;       // ポイント・スポット: 半径 (m。影のぼけ)
  angleDeg: number;     // サン: 角度 (影のぼけ)
  spotSizeDeg: number;  // スポット: スポットサイズ (光の円すいの全体の角度)
  blend: number;        // スポット: ブレンド (縁のぼけ 0〜1)
  shape: AreaShape;     // エリア: 形状
  size: number;         // エリア: サイズ (正方形の辺・長方形の X)
  sizeY: number;        // エリア: サイズ Y (長方形)
  height: number;       // 床からの高さ
  tiltDeg: number;      // サン・スポット・エリア: 真下からの傾き
  range: number;        // カスタム距離 (0 で無制限。ポイント・スポット)
  shadows: boolean;     // 影 (エリアは落とせない)
}
// Blender の日本語の表示と同じ名前
export const LIGHT_TYPES: { key: LightType; name: string }[] = [
  { key: 'point', name: 'ポイント' }, { key: 'sun', name: 'サン' }, { key: 'spot', name: 'スポット' }, { key: 'area', name: 'エリア' },
];
export const AREA_SHAPES: { key: AreaShape; name: string }[] = [{ key: 'square', name: '正方形' }, { key: 'rectangle', name: '長方形' }];
export const LIGHT_KIND = 12; // 物の種類の番号 (形・モデルと重ならない)
export const lightName = (type: LightType) => LIGHT_TYPES.find(t => t.key === type)?.name ?? 'ライト'; // 物の名前も Blender と同じ

export const lightDefault = (type: LightType): LightSettings => ({
  type, color: '#ffffff', power: { point: 400, sun: 1000, spot: 1000, area: 20 }[type], strength: 3, radius: 0.1, angleDeg: 0.526,
  spotSizeDeg: 45, blend: 0.15, shape: 'square', size: 1, sizeY: 1,
  height: type === 'sun' ? 5 : 4, tiltDeg: type === 'sun' ? 35 : 0, range: 0, shadows: type !== 'area',
});

// 前の版 (明るさを three.js の単位で持っていた) の設定
interface OldLight { intensity?: number; angleDeg?: number; softness?: number; width?: number; depth?: number }

export function normalizeLight(o: (Partial<LightSettings> & OldLight) | undefined): LightSettings {
  const type = LIGHT_TYPES.some(t => t.key === o?.type) ? o!.type! : 'point';
  const d = lightDefault(type), s = { ...o };
  // 前の版 (明るさ intensity を持つ) から: 明るさ → パワー、広がり (半分の角度) → スポットサイズ、縁のぼけ → ブレンド、幅・奥行き → サイズ
  if (s.power === undefined && typeof s.intensity === 'number') {
    s.power = type === 'area' ? s.intensity * Math.PI * (s.width ?? 1) * (s.depth ?? 1) : s.intensity * 4 * Math.PI;
    if (typeof s.angleDeg === 'number') s.spotSizeDeg = s.angleDeg * 2;
    s.angleDeg = undefined;
    if (typeof s.softness === 'number') s.blend = s.softness;
    if (typeof s.width === 'number') { s.size = s.width; s.sizeY = s.depth; s.shape = s.width === s.depth ? 'square' : 'rectangle'; }
  }
  const num = (v: unknown, dv: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : dv);
  return {
    type, color: typeof s.color === 'string' && hexToRgb(s.color) ? rgbToHex(hexToRgb(s.color)!) : d.color,
    power: num(s.power, d.power, 0, 1e6), strength: num(s.strength, d.strength, 0, 1000),
    radius: num(s.radius, d.radius, 0, 10), angleDeg: num(s.angleDeg, d.angleDeg, 0, 180),
    spotSizeDeg: num(s.spotSizeDeg, d.spotSizeDeg, 1, 180), blend: num(s.blend, d.blend, 0, 1),
    shape: AREA_SHAPES.some(a => a.key === s.shape) ? s.shape! : d.shape,
    size: num(s.size, d.size, 0.01, 100), sizeY: num(s.sizeY, d.sizeY, 0.01, 100),
    height: num(s.height, d.height, 0.05, 100), tiltDeg: num(s.tiltDeg, d.tiltDeg, -180, 180), range: num(s.range, d.range, 0, 1000),
    shadows: type === 'area' ? false : typeof s.shadows === 'boolean' ? s.shadows : d.shadows,
  };
}

// エリアの大きさ (X, Y)
export const areaSize = (l: LightSettings): [number, number] => [l.size, l.shape === 'square' ? l.size : l.sizeY];

// three.js の明るさ (Blender (Cycles) と同じ定義で直す。three.js も Cycles も、白い面の明るさは照度 ÷ π)
//   ポイント・スポット: 全方向に放つパワー P (W) → 光度 P / 4π (スポットも、Blender と同じく点光源としてのパワー)
//   エリア: 片面から放つパワー P (W)・面積 A → 輝度 P / (π A)
//   サン: 強さ (W/m²) = 照度
export function lightIntensity(l: LightSettings) {
  if (l.type === 'sun') return l.strength;
  if (l.type === 'area') { const [x, y] = areaSize(l); return l.power / (Math.PI * x * y); }
  return l.power / (4 * Math.PI);
}

// サン・スポット・エリアの照らす向き (物の向きで回す前。y は下向きがマイナス)
export function lightAim(tiltDeg: number): [number, number, number] {
  const t = tiltDeg * Math.PI / 180;
  return [0, -Math.cos(t), Math.sin(t)];
}
