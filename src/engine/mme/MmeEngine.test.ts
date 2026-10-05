import { afterEach, describe, expect, it, vi } from 'vitest';
import { Engine } from '../Engine';
import { MME_DEFAULTS } from './MmeEngine';

// 描画先なしで、レンダーエンジンの切り替えと Viewport.drawOverride の差し替えを確かめる
describe('MmeEngine', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('既定の設定', () => {
    expect(MME_DEFAULTS).toEqual({ engine: 'standard', selfShadow: true, shadowDistance: 8875, groundShadow: true });
    expect(new Engine().mme.settings).toEqual(MME_DEFAULTS);
  });

  it('engine を mme にすると drawOverride が MME の描画を呼び、standard に戻すと前の描画に戻る', () => {
    const e = new Engine();
    // 前の描画 (効果の後処理)
    const prev = vi.spyOn(e.effects as unknown as { render: () => boolean }, 'render').mockReturnValue(false);
    const render = vi.spyOn(e.mme.renderer, 'render').mockReturnValue(true);
    const dispose = vi.spyOn(e.mme.renderer, 'dispose');
    const draw = vi.spyOn(e.viewport, 'requestDraw');

    expect(e.viewport.drawOverride!()).toBe(false);
    expect([prev.mock.calls.length, render.mock.calls.length]).toEqual([1, 0]);

    e.mme.set({ engine: 'mme' });
    expect(draw).toHaveBeenCalled();
    expect(e.viewport.drawOverride!()).toBe(true);
    expect([prev.mock.calls.length, render.mock.calls.length]).toEqual([1, 1]);
    expect(dispose).not.toHaveBeenCalled();

    e.mme.set({ engine: 'standard' });
    expect(dispose).toHaveBeenCalledTimes(1); // 資源を片付ける
    expect(e.viewport.drawOverride!()).toBe(false);
    expect([prev.mock.calls.length, render.mock.calls.length]).toEqual([2, 1]);
  });

  it('render が例外を出したら false を返し、お知らせを 1 回だけ出す', () => {
    const e = new Engine();
    e.mme.set({ engine: 'mme' });
    vi.spyOn(e.mme.renderer, 'render').mockImplementation(() => { throw new Error('壊れた'); });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const toast = vi.spyOn(e.ui, 'toast');
    expect(e.viewport.drawOverride!()).toBe(false);
    expect(e.viewport.drawOverride!()).toBe(false);
    expect(error).toHaveBeenCalledTimes(2);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(e.ui.state.toast?.text).toContain('壊れた');
  });

  it('物を消すと、その物の .fx の割り当ても消える', async () => {
    const e = new Engine();
    const obj = e.world.addShape(0, 0, 0, 0);
    const fx = await e.mme.loadEffect([new File(['technique T { }'], 'a.fx')], 'a.fx');
    e.mme.store.setObjectEffect(obj.id, fx);
    expect(e.mme.store.objectEffect(obj.id)).toBe(fx);
    e.world.remove(obj);
    expect(e.mme.store.objectEffect(obj.id)).toBeNull();
  });

  it('whenReady は .fx のテクスチャと .pmx の読み込みを待つ (何もなければすぐ終わる)', async () => {
    const e = new Engine();
    e.world.addShape(0, 0, 0, 0);
    await expect(e.mme.whenReady()).resolves.toBeUndefined();
  });
});
