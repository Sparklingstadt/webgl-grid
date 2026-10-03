import { describe, expect, it } from 'vitest';
import { hexToRgb, hsvToRgb, rgbToHex, rgbToHsv } from './hsv';

describe('色選びの色の変換', () => {
  it('RGB と HSV の行き来', () => {
    expect(rgbToHsv([1, 0, 0])).toEqual({ h: 0, s: 1, v: 1 });
    expect(rgbToHsv([0, 0, 1]).h).toBeCloseTo(240);
    for (const c of [[0.2, 0.5, 0.9], [1, 1, 0], [0.3, 0.3, 0.3], [0.9, 0.1, 0.4]] as [number, number, number][]) {
      hsvToRgb(rgbToHsv(c)).forEach((v, i) => expect(v).toBeCloseTo(c[i]));
    }
  });
  it('灰色では色相を保つ', () => {
    expect(rgbToHsv([0.5, 0.5, 0.5], 120)).toEqual({ h: 120, s: 0, v: 0.5 });
  });
  it('16 進', () => {
    expect(rgbToHex([1, 0.5, 0])).toBe('#ff8000');
    expect(hexToRgb('#ff8000')).toEqual([1, 128 / 255, 0]);
    expect(hexToRgb('0f0')).toEqual([0, 1, 0]);
    expect(hexToRgb('#12345')).toBeNull();
  });
});
