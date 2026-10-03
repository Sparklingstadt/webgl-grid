import { describe, expect, it } from 'vitest';
import { cameraAim, cameraForward, normalizeCamera } from './camera';

describe('カメラの物', () => {
  it('向き: r = 0 は -Z、傾きで下を向く。向きから r と傾きに戻せる', () => {
    expect(cameraForward(0, 0).map(v => +v.toFixed(6) + 0)).toEqual([0, 0, -1]);
    const f = cameraForward(Math.PI / 2, 30);
    expect(f.map(v => +v.toFixed(4) + 0)).toEqual([-0.866, -0.5, 0]);
    const a = cameraAim(...f);
    expect(a.r).toBeCloseTo(Math.PI / 2);
    expect(a.tiltDeg).toBeCloseTo(30);
  });
  it('設定をそろえる', () => {
    expect(normalizeCamera({ fov: 500, height: -1 } as never)).toEqual({ fov: 150, height: 0.05, tiltDeg: 8 });
  });
});
