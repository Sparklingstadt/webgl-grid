import type * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Engine } from '../Engine';

// クローナー (描画先なしのエンジンで)
const clones = (e: Engine, i = 0) => e.world.objects[i].node.getObjectByName('__clones')?.children ?? [];
const pos = (g: THREE.Object3D) => [g.position.x, g.position.y, g.position.z].map(v => Math.round(v * 100) / 100 + 0);

describe('クローナー', () => {
  it('物をクローナーにすると、元の物を隠してクローンを並べ、設定を変えると並べ直す。やめると戻る', () => {
    const e = new Engine();
    const cube = e.world.objects[0];
    e.select(cube);
    e.setCloner({ mode: 'grid', grid: [2, 1, 2], spacing: [2, 1, 2] });
    expect(clones(e).map(pos)).toEqual([[-1, 0, -1], [1, 0, -1], [-1, 0, 1], [1, 0, 1]]);
    expect(cube.mesh!.visible).toBe(false);
    expect(e.ui.state.sel?.cloner?.mode).toBe('grid');
    e.setCloner({ mode: 'linear', count: 3 });
    expect(clones(e)).toHaveLength(3);
    e.setCloner(null);
    expect(clones(e)).toHaveLength(0);
    expect(cube.mesh!.visible).toBe(true);
  });

  it('クローンは元の物の材質を使い、スロットを替えると描く前に合わせる', () => {
    const e = new Engine();
    const cube = e.world.objects[0];
    e.select(cube);
    e.setCloner({ mode: 'linear', count: 2 });
    const m = clones(e)[0].children[0] as THREE.Mesh;
    expect(m.material).toBe(cube.mesh!.material);
    e.materials.create(); // スロットに新しいマテリアル
    e.viewport.render(); // (描画先がないので描かないが、ここでは描く前の処理だけを確かめたい)
    (e.cloners as unknown as { sync(): void }).sync();
    expect(m.material).toBe(cube.mesh!.material);
  });

  it('元に戻す・やり直す', async () => {
    const e = new Engine();
    e.select(e.world.objects[0]);
    e.setCloner({ mode: 'radial', count: 6 });
    e.history.checkpoint();
    expect(e.ui.state.history.labels.at(-1)).toBe('クローナー');
    await e.history.undo();
    expect(clones(e)).toHaveLength(0);
    await e.history.redo();
    expect(clones(e)).toHaveLength(6);
  });

  it('実体にする: クローンを 1 つずつの物にし (マテリアルは共有)、多すぎるときはしない', () => {
    const e = new Engine();
    const cube = e.world.objects[0];
    e.select(cube);
    const mat = cube.slots[0];
    e.setCloner({ mode: 'grid', grid: [2, 2, 1], spacing: [2, 1, 1] }); // 2 段
    e.bakeCloner();
    expect(e.world.objects).toHaveLength(4);
    expect(e.world.objects.every(o => o.slots[0] === mat && !o.cloner)).toBe(true);
    expect(e.library.users(mat!)).toBe(4);
    expect(e.world.objects.map(o => o.y).sort()).toEqual([0, 0, 1, 1]); // 上の段は積み重なる
    e.select(e.world.objects[0]);
    e.setCloner({ mode: 'grid', grid: [10, 1, 10] });
    e.bakeCloner();
    expect(e.ui.state.toast?.text).toMatch(/まで/);
    expect(e.world.objects).toHaveLength(4);
  });

  it('プロジェクトに保存して開くと、クローナーも戻る', async () => {
    const e = new Engine();
    e.select(e.world.objects[0]);
    e.setCloner({ mode: 'linear', count: 4, step: [1, 0, 0.5] });
    const bytes = await e.project.save('reference');
    const f = new Engine();
    await f.project.open(bytes);
    expect(f.world.objects[0].cloner).toEqual(e.world.objects[0].cloner);
    expect(clones(f).map(pos)).toEqual(clones(e).map(pos));
  });
});
