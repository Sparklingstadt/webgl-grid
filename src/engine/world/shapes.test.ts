import type * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { SHAPES } from '../../core/shapes';
import { Engine } from '../Engine';

// どの形も置け、形の大きさが足場 (高さ・幅) とおおむね合っている
describe('形を置く', () => {
  it('すべての形の、底が地面 (y = 0) で、高さと幅が足場と合う', () => {
    const e = new Engine();
    for (const d of SHAPES) {
      e.addShape(d.s);
      const o = e.selection.current!;
      expect(e.ui.state.sel?.name).toBe(d.name);
      const g = o.mesh!.geometry as THREE.BufferGeometry;
      g.computeBoundingBox();
      const b = g.boundingBox!;
      expect(b.min.y, d.name).toBeCloseTo(0, 5);
      expect(b.max.y, d.name).toBeCloseTo(d.h, 2);
      expect(b.max.x, d.name).toBeLessThanOrEqual(d.hx + 1e-6); // 足場の中に収まり、
      expect(b.max.x, d.name).toBeGreaterThan(d.hx * 0.8);        // ほぼいっぱい
    }
    expect(e.world.objects).toHaveLength(SHAPES.length + 1);
  });
});
