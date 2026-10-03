import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SceneGraph } from './SceneGraph';
import { Viewport, type System } from './Viewport';

// 描画ループ: 再生中に描き直しを頼まれても、1 フレームに 1 回だけ描く
describe('Viewport の描画ループ', () => {
  let queue: FrameRequestCallback[] = [];
  const flush = (now: number) => { const q = queue; queue = []; for (const cb of q) cb(now); };
  beforeEach(() => {
    queue = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => queue.push(cb));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  // WebGL なしで、描いた回数だけ数える
  const make = () => {
    const vp = new Viewport({ scene: {}, camera: {} } as unknown as SceneGraph);
    const draw = vi.fn();
    Object.assign(vp, { renderer: {}, outline: { render: draw } });
    return { vp, draw };
  };
  const system = (frames: number) => {
    let left = frames;
    const s: System & { update: ReturnType<typeof vi.fn> } = { active: () => left > 0, update: vi.fn(() => { left--; }) };
    return s;
  };

  it('動いているあいだに何度描き直しを頼まれても、1 フレームに 1 回だけ描く', () => {
    const { vp, draw } = make();
    const s = system(3);
    vp.addSystem(s);
    vp.startTicking();
    for (let f = 1; f <= 3; f++) {
      vp.requestDraw();
      vp.requestDraw();
      flush(f * 16);
      expect(s.update).toHaveBeenCalledTimes(f);
      expect(draw).toHaveBeenCalledTimes(f);
    }
    // 動くものがなくなったら止まる (頼まれていなければ描かない)
    flush(64);
    expect(draw).toHaveBeenCalledTimes(3);
    expect(queue).toHaveLength(0);
  });

  it('止まっているときは、頼まれたフレームにだけ描く', () => {
    const { vp, draw } = make();
    vp.requestDraw();
    vp.requestDraw();
    expect(queue).toHaveLength(1);
    flush(16);
    expect(draw).toHaveBeenCalledTimes(1);
    expect(queue).toHaveLength(0);
  });

  it('止まる最後のフレームで頼まれていれば、それは描く', () => {
    const { vp, draw } = make();
    vp.addSystem(system(1));
    vp.startTicking();
    flush(16);
    expect(draw).toHaveBeenCalledTimes(1);
    vp.requestDraw();
    flush(32);
    expect(draw).toHaveBeenCalledTimes(2);
    expect(queue).toHaveLength(0);
  });
});
