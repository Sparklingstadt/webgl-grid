import type * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { Engine } from '../../engine/Engine';
import { engineWithC4d } from './testing';

// クローナー (描画先なしのエンジンで)
const clones = (e: Engine, i = 0) => e.world.objects[i].node.getObjectByName('__clones')?.children ?? [];
const pos = (g: THREE.Object3D) => [g.position.x, g.position.y, g.position.z].map(v => Math.round(v * 100) / 100 + 0);

describe('クローナー', () => {
  it('物をクローナーにすると、元の物を隠してクローンを並べ、設定を変えると並べ直す。やめると戻る', async () => {
    const { e, c4d } = await engineWithC4d();
    const cube = e.world.objects[0];
    e.select(cube);
    c4d.setCloner({ mode: 'grid', grid: [2, 1, 2], spacing: [2, 1, 2] });
    expect(clones(e).map(pos)).toEqual([[-1, 0, -1], [1, 0, -1], [-1, 0, 1], [1, 0, 1]]);
    expect(cube.mesh!.visible).toBe(false);
    expect(c4d.cloner(e.selection.current)?.mode).toBe('grid');
    c4d.setCloner({ mode: 'linear', count: 3 });
    expect(clones(e)).toHaveLength(3);
    c4d.setCloner(null);
    expect(clones(e)).toHaveLength(0);
    expect(cube.mesh!.visible).toBe(true);
  });

  it('クローンは元の物の材質を使い、スロットを替えると描く前に合わせる', async () => {
    const { e, c4d } = await engineWithC4d();
    const cube = e.world.objects[0];
    e.select(cube);
    c4d.setCloner({ mode: 'linear', count: 2 });
    const m = clones(e)[0].children[0] as THREE.Mesh;
    expect(m.material).toBe(cube.mesh!.material);
    e.materials.create(); // スロットに新しいマテリアル
    e.viewport.render(); // (描画先がないので描かないが、ここでは描く前の処理だけを確かめたい)
    c4d.cloners.sync();
    expect(m.material).toBe(cube.mesh!.material);
  });

  it('元に戻す・やり直す', async () => {
    const { e, c4d } = await engineWithC4d();
    e.select(e.world.objects[0]);
    c4d.setCloner({ mode: 'radial', count: 6 });
    e.history.checkpoint();
    expect(e.ui.state.history.labels.at(-1)).toBe('クローナー');
    await e.history.undo();
    expect(clones(e)).toHaveLength(0);
    await e.history.redo();
    expect(clones(e)).toHaveLength(6);
  });

  it('実体にする: クローンを 1 つずつの物にし (マテリアルは共有)、多すぎるときはしない', async () => {
    const { e, c4d } = await engineWithC4d();
    const cube = e.world.objects[0];
    e.select(cube);
    const mat = cube.slots[0];
    c4d.setCloner({ mode: 'grid', grid: [2, 2, 1], spacing: [2, 1, 1] }); // 2 段
    c4d.bake();
    expect(e.world.objects).toHaveLength(4);
    expect(e.world.objects.every(o => o.slots[0] === mat && !c4d.cloner(o))).toBe(true);
    expect(e.library.users(mat!)).toBe(4);
    expect(e.world.objects.map(o => o.y).sort()).toEqual([0, 0, 1, 1]); // 上の段は積み重なる
    e.select(e.world.objects[0]);
    c4d.setCloner({ mode: 'grid', grid: [10, 1, 10] });
    c4d.bake();
    expect(e.ui.state.toast?.text).toMatch(/まで/);
    expect(e.world.objects).toHaveLength(4);
  });

  it('プロジェクトに保存して開くと、クローナーも戻る', async () => {
    const { e, c4d } = await engineWithC4d();
    e.select(e.world.objects[0]);
    c4d.setCloner({ mode: 'linear', count: 4, step: [1, 0, 0.5] });
    const bytes = await e.project.save('reference');
    const { e: f, c4d: g } = await engineWithC4d();
    await f.project.open(bytes);
    expect(g.cloner(f.world.objects[0])).toEqual(c4d.cloner(e.world.objects[0]));
    expect(clones(f).map(pos)).toEqual(clones(e).map(pos));
  });
});
