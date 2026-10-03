import { describe, expect, it } from 'vitest';
import { SCENE_DEFAULT, normalizeScene, sunDirection } from './scene';

describe('シーンの設定', () => {
  it('太陽の向き: 既定は前からの向き (0.6, 1.0, 0.35) と同じ', () => {
    const d = sunDirection(SCENE_DEFAULT.sun.azimuthDeg, SCENE_DEFAULT.sun.elevationDeg);
    const old = [0.6, 1.0, 0.35], len = Math.hypot(...old);
    d.forEach((v, i) => expect(v).toBeCloseTo(old[i] / len, 2));
    expect(sunDirection(0, 90)[1]).toBeCloseTo(1); // 真上
  });
  it('設定をそろえる (色は #rrggbb に、範囲の外は収め、知らない値は既定)', () => {
    const s = normalizeScene({ sky: { mode: 'sunset' as never, top: '#ABC' }, floor: { roughness: 3 }, sun: { elevationDeg: -10 }, environment: -1 });
    expect(s.sky).toEqual({ mode: 'viewport', top: '#aabbcc', bottom: SCENE_DEFAULT.sky.bottom });
    expect(s.floor.roughness).toBe(1);
    expect(s.sun.elevationDeg).toBe(1);
    expect(s.environment).toBe(0);
    expect(normalizeScene(undefined)).toEqual(SCENE_DEFAULT);
  });
});
