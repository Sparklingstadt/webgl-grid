// --- 色選びの画面で使う色の変換 (画面の色 sRGB の 0〜1 と、色相・彩度・明度) ---
export interface Hsv { h: number; s: number; v: number } // h: 0〜360, s・v: 0〜1

export function rgbToHsv([r, g, b]: [number, number, number], keepHue = 0): Hsv {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = keepHue; // 灰色 (彩度 0) のときは色相が決まらないので、前の色相のまま
  if (d > 1e-6) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
    if (h < 0) h += 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}

export function hsvToRgb({ h, s, v }: Hsv): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)];
}

export const rgbToHex = (c: [number, number, number]) => `#${c.map(v => Math.round(Math.min(Math.max(v, 0), 1) * 255).toString(16).padStart(2, '0')).join('')}`;
// "#rgb" "#rrggbb" (# はなくてもよい)。読めなければ null
export function hexToRgb(hex: string): [number, number, number] | null {
  let s = hex.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(s)) s = [...s].map(c => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(s)) return null;
  return [0, 2, 4].map(i => parseInt(s.slice(i, i + 2), 16) / 255) as [number, number, number];
}
