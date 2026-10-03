import { describe, expect, it, vi } from 'vitest';
import { surfaceShader } from '../../core/materials/tree';
import { Engine } from '../Engine';

// 元に戻す・やり直し (描画先なしのエンジンで)
const base = (e: Engine, i = 0) => surfaceShader(e.library.materials.get(e.world.objects[i].slots[0]!)!.tree)!.values.baseColor;
const step = (e: Engine) => e.history.checkpoint();

describe('History', () => {
  it('形を置く → 元に戻すと消え、やり直すと同じ物 (同じ id・マテリアル) が戻る', async () => {
    const e = new Engine();
    e.addShape(1);
    step(e);
    const torus = e.world.objects[1];
    expect(e.ui.state.history).toEqual({ labels: ['最初', '追加'], index: 1 });
    await e.history.undo();
    expect(e.world.objects.map(o => o.s)).toEqual([0]);
    expect(e.ui.state.history.index).toBe(0);
    await e.history.redo();
    expect(e.world.objects[1]).toBe(torus);
    expect(e.library.users(torus.slots[0]!)).toBe(1);
  });

  it('移動・色・回転をそれぞれ 1 手にし、順に戻す', async () => {
    const e = new Engine();
    const cube = e.world.objects[0];
    e.select(cube);
    e.setObjProp('x', 3); step(e);
    e.setObjColor(1); step(e);
    e.setObjProp('r', 90); step(e);
    expect(e.ui.state.history.labels).toEqual(['最初', '移動', '色', '回転']);
    await e.history.undo();
    expect(cube.r).toBe(0);
    await e.history.undo();
    expect(cube.c).toBe(0);
    expect(base(e)).toEqual([0.85, 0.62, 0.32].map(v => expect.closeTo(v, 2)));
    await e.history.undo();
    expect(cube.x).toBe(0);
    await e.history.undo(); // これ以上は戻らない
    expect(e.ui.state.history.index).toBe(0);
    await e.history.jump(3);
    expect([cube.x, cube.c, cube.r]).toEqual([3, 1, Math.PI / 2]);
  });

  it('名前・ビューポートで隠す・レンダリングに写さないを、それぞれ 1 手にして戻す。隠すと選択が外れ、クリックで選べない', async () => {
    const e = new Engine();
    const cube = e.world.objects[0];
    e.select(cube);
    e.renameObj(cube, '  箱  '); step(e);
    expect(e.ui.state.sel?.name).toBe('箱');
    e.setVisibility(cube, { hideRender: true }); step(e);
    e.hideSelected(); step(e);
    expect([cube.hidden, cube.node.visible, e.selection.current]).toEqual([true, false, null]);
    expect(e.camera.pick({ ro: [0, 0.5, 5], rd: [0, 0, -1] })).toBeNull();
    expect(e.ui.state.history.labels).toEqual(['最初', '名前', 'レンダリングに写さない', 'ビューポートで隠す']);
    await e.history.undo();
    expect([cube.hidden, cube.node.visible]).toEqual([undefined, true]);
    expect(e.camera.pick({ ro: [0, 0.5, 5], rd: [0, 0, -1] })?.obj).toBe(cube);
    await e.history.undo();
    expect(cube.hideRender).toBeUndefined();
    await e.history.undo();
    expect(cube.name).toBeUndefined();
    await e.history.jump(3);
    expect([cube.name, cube.hideRender, cube.hidden]).toEqual(['箱', true, true]);
    e.revealAll();
    expect(cube.hidden).toBeUndefined();
  });

  it('並べ替え (アウトライナー) を 1 手にして戻す', async () => {
    const e = new Engine();
    e.addShape(1); e.addShape(2); step(e);
    const [a, b, c] = e.world.objects;
    e.moveObject(c, a, 'before'); step(e);
    expect(e.world.objects).toEqual([c, a, b]);
    e.moveObject(c, b, 'after'); step(e);
    expect(e.world.objects).toEqual([a, b, c]);
    expect(e.ui.state.history.labels.slice(-2)).toEqual(['並べ替え', '並べ替え']);
    await e.history.undo();
    expect(e.world.objects).toEqual([c, a, b]);
  });

  it('消した物を戻すと、元の並び順と積み重ねに戻る', async () => {
    const e = new Engine();
    e.addShape(0);
    const [a, b] = e.world.objects;
    e.select(b);
    e.setObjProp('x', a.x); e.setObjProp('z', a.z);
    step(e);
    expect(b.y).toBe(1);
    e.select(a);
    e.deleteSelected();
    step(e);
    expect(b.y).toBe(0);
    expect(e.ui.state.history.labels.at(-1)).toBe('削除');
    await e.history.undo();
    expect(e.world.objects).toEqual([a, b]);
    expect(b.y).toBe(1);
  });

  it('マテリアルの変更 (名前・値・新規) を戻す', async () => {
    const e = new Engine();
    e.select(e.world.objects[0]);
    const id = e.world.objects[0].slots[0]!;
    e.materials.rename('木');
    e.materials.setNodeValue(e.materials.surfaceShader()!.id, 'roughness', 0.9);
    step(e);
    e.materials.create();
    step(e);
    expect(e.ui.state.history.labels).toEqual(['最初', 'マテリアル', 'マテリアル']);
    await e.history.undo();
    expect(e.world.objects[0].slots[0]).toBe(id);
    expect(e.library.materials.get(id)!.name).toBe('木');
    await e.history.undo();
    expect(e.library.materials.get(id)!.name).toBe('マテリアル');
    expect(surfaceShader(e.library.materials.get(id)!.tree)!.values.roughness).toBe(0.5);
  });

  it('押しているあいだの変化は、離したときに 1 手にまとめる', () => {
    vi.useFakeTimers();
    try {
      const e = new Engine();
      e.select(e.world.objects[0]);
      e.history.setPressed(true);
      for (let i = 1; i <= 10; i++) { e.setObjProp('x', i); vi.advanceTimersByTime(100); }
      expect(e.ui.state.history.labels).toEqual(['最初']);
      e.history.setPressed(false);
      vi.advanceTimersByTime(100);
      expect(e.ui.state.history.labels).toEqual(['最初', '移動']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('戻したあとに別の変更をすると、やり直しの先は消え、もう使わない消した物は片付ける', async () => {
    const e = new Engine();
    const dispose = vi.spyOn(e.world, 'dispose');
    e.addShape(1); step(e);
    const torus = e.world.objects[1];
    await e.history.undo();
    e.select(e.world.objects[0]);
    e.setObjProp('x', 2); step(e);
    expect(e.ui.state.history.labels).toEqual(['最初', '移動']);
    expect(dispose).toHaveBeenCalledWith(torus);
  });

  it('最初の状態に戻すと、履歴も消える', () => {
    const e = new Engine();
    e.addShape(1); step(e);
    e.resetAll();
    expect(e.ui.state.history).toEqual({ labels: ['最初'], index: 0 });
  });

  it('フレーム範囲も戻す。いまのフレームは手に数えない', async () => {
    const e = new Engine();
    e.clock.seekFrame(30); step(e);
    expect(e.ui.state.history.labels).toEqual(['最初']);
    e.clock.setRange(10, 100); step(e);
    await e.history.undo();
    expect([e.clock.start, e.clock.end]).toEqual([0, 250]);
  });
});
