import type * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { newDeformer } from './deform';
import type { Engine } from '../../engine/Engine';
import { engineWithC4d } from './testing';

// デフォーマ (描画先なしのエンジンで)
const top = (e: Engine) => {
  const g = e.world.objects[0].mesh!.geometry as THREE.BufferGeometry;
  g.computeBoundingBox();
  return g.boundingBox!.max.toArray().map(v => Math.round(v * 100) / 100);
};

describe('デフォーマ', () => {
  it('かけると形の写しを変形し (ほかの物の形はそのまま)、外すと元の形に戻る', async () => {
    const { e, c4d } = await engineWithC4d();
    e.addShape(0);
    const [cube, other] = e.world.objects;
    const shared = cube.mesh!.geometry;
    e.select(cube);
    c4d.setDeformers([{ ...newDeformer('taper'), amount: -0.5 }]);
    expect(cube.mesh!.geometry).not.toBe(shared);
    expect(other.mesh!.geometry).toBe(shared);
    expect(top(e)).toEqual([0.5, 1, 0.5]); // 上が半分
    expect(c4d.deformerList(e.selection.current)).toHaveLength(1);
    c4d.setDeformers([]);
    expect(cube.mesh!.geometry).toBe(shared);
  });
  it('クローナーのクローンも変形した形になり、元に戻す・プロジェクトにも残る', async () => {
    const { e, c4d } = await engineWithC4d();
    const cube = e.world.objects[0];
    e.select(cube);
    c4d.setCloner({ mode: 'linear', count: 2 });
    e.history.checkpoint();
    c4d.setDeformers([{ ...newDeformer('twist'), amount: 45 }]);
    e.history.checkpoint();
    const clone = cube.node.getObjectByName('__clones')!.children[0].children[0] as THREE.Mesh;
    expect(clone.geometry).toBe(cube.mesh!.geometry);
    expect(e.ui.state.history.labels.at(-1)).toBe('デフォーマ');
    const bytes = await e.project.save('reference');
    await e.history.undo();
    expect(c4d.deformerList(cube)).toEqual([]);
    const { e: f, c4d: g } = await engineWithC4d();
    await f.project.open(bytes);
    expect(g.deformerList(f.world.objects[0])).toEqual([{ ...newDeformer('twist'), amount: 45 }]);
    expect(f.world.objects[0].mesh!.userData.baseGeometry).toBeDefined();
  });
});
