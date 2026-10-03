import { hexToRgb, rgbToHex } from './hsv';

// --- シーンの設定 (Cinema 4D の空・床・太陽): 背景の空、床、太陽の光、部屋の光 (環境光) ---
// 色は画面の色 (sRGB) の "#rrggbb"
export type SkyMode = 'viewport' | 'color' | 'gradient';
export interface SceneSettings {
  sky: { mode: SkyMode; top: string; bottom: string };   // viewport: ビューポートの灰色 / color: top の単色 / gradient: 地平線から上へ bottom → top
  floor: { enabled: boolean; color: string; roughness: number };
  sun: { intensity: number; color: string; azimuthDeg: number; elevationDeg: number; shadows: boolean };
  environment: number;                                    // 部屋の光 (環境光) の明るさ
}
export const SKY_MODES: { key: SkyMode; name: string }[] = [
  { key: 'viewport', name: 'ビューポートの灰色' }, { key: 'color', name: '単色' }, { key: 'gradient', name: 'グラデーション' },
];
// 今までの見た目 (太陽の向きは、前からの (0.6, 1.0, 0.35) と同じ)
export const SCENE_DEFAULT: SceneSettings = {
  sky: { mode: 'viewport', top: '#6f9fd8', bottom: '#d9e4ef' },
  floor: { enabled: false, color: '#8a8a8a', roughness: 0.8 },
  sun: { intensity: 0.82, color: '#ffffff', azimuthDeg: 30.3, elevationDeg: 55.2, shadows: true },
  environment: 0.3,
};

const hex = (v: unknown, d: string) => (typeof v === 'string' && hexToRgb(v) ? rgbToHex(hexToRgb(v)!) : d);
const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : d);

export function normalizeScene(s: Partial<{ [K in keyof SceneSettings]: Partial<SceneSettings[K]> }> | undefined): SceneSettings {
  const d = SCENE_DEFAULT, o = s ?? {};
  const sky = o.sky ?? {}, floor = o.floor ?? {}, sun = o.sun ?? {};
  return {
    sky: { mode: SKY_MODES.some(m => m.key === sky.mode) ? sky.mode! : d.sky.mode, top: hex(sky.top, d.sky.top), bottom: hex(sky.bottom, d.sky.bottom) },
    floor: { enabled: typeof floor.enabled === 'boolean' ? floor.enabled : d.floor.enabled, color: hex(floor.color, d.floor.color), roughness: num(floor.roughness, d.floor.roughness, 0, 1) },
    sun: {
      intensity: num(sun.intensity, d.sun.intensity, 0, 10), color: hex(sun.color, d.sun.color),
      azimuthDeg: num(sun.azimuthDeg, d.sun.azimuthDeg, -360, 360), elevationDeg: num(sun.elevationDeg, d.sun.elevationDeg, 1, 90),
      shadows: typeof sun.shadows === 'boolean' ? sun.shadows : d.sun.shadows,
    },
    environment: num(o.environment, d.environment, 0, 5),
  };
}

// 太陽の来る向き (単位ベクトル)。方位は真上から見て +X から +Z へ回る角度、高さは地面からの角度
export function sunDirection(azimuthDeg: number, elevationDeg: number): [number, number, number] {
  const a = azimuthDeg * Math.PI / 180, e = elevationDeg * Math.PI / 180;
  return [Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a)];
}
