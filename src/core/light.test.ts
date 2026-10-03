import { describe, expect, it } from 'vitest';
import { lightDefault, lightIntensity, normalizeLight } from './light';

describe('ライト (Blender の単位)', () => {
  it('パワーを Blender (Cycles) と同じ定義で three.js の明るさに直す', () => {
    expect(lightIntensity({ ...lightDefault('point'), power: 1000 })).toBeCloseTo(1000 / (4 * Math.PI));
    expect(lightIntensity({ ...lightDefault('spot'), power: 1000 })).toBeCloseTo(1000 / (4 * Math.PI));
    expect(lightIntensity({ ...lightDefault('area'), power: 60, shape: 'rectangle', size: 2, sizeY: 3 })).toBeCloseTo(60 / (Math.PI * 6));
    expect(lightIntensity({ ...lightDefault('area'), power: 60, shape: 'square', size: 2, sizeY: 3 })).toBeCloseTo(60 / (Math.PI * 4));
    expect(lightIntensity({ ...lightDefault('sun'), strength: 4 })).toBe(4);
  });

  it('前の版 (明るさ・広がり・縁のぼけ・幅と奥行き) の設定を、同じ見た目の Blender の設定に直す', () => {
    const spot = normalizeLight({ type: 'spot', intensity: 80, angleDeg: 30, softness: 0.3 } as never);
    expect(spot).toMatchObject({ spotSizeDeg: 60, blend: 0.3, angleDeg: lightDefault('sun').angleDeg });
    expect(lightIntensity(spot)).toBeCloseTo(80);
    const area = normalizeLight({ type: 'area', intensity: 6, width: 2, depth: 1 } as never);
    expect(area).toMatchObject({ shape: 'rectangle', size: 2, sizeY: 1 });
    expect(lightIntensity(area)).toBeCloseTo(6);
  });

  it('知らない種類はポイント、エリアは影を落とさない', () => {
    expect(normalizeLight({ type: 'laser' } as never).type).toBe('point');
    expect(normalizeLight({ type: 'area', shadows: true }).shadows).toBe(false);
  });
});
