import { describe, expect, it } from 'vitest';
import { ScriptTargets } from './PostChain.ts';
import type { EffectInstance } from './EffectInstance.ts';
import type { LoadedEffect } from './EffectStore.ts';
import type { DrawTarget, Framebuffers } from './Framebuffers.ts';

// Script の Clear は、消す値 (ClearSetColor・ClearSetDepth・ClearSetStencil のパラメータ) を Framebuffers.clear に渡す
function setup(params: Record<string, number[]>, overrides?: ReadonlyMap<string, number[]>) {
  const calls: unknown[][] = [];
  const fb = {
    has: () => true, bind: () => ({ flipY: -1, size: [4, 4] }) as DrawTarget,
    clear: (...a: unknown[]) => { calls.push(a); }, afterDraw: () => {},
  } as unknown as Framebuffers;
  const inst = {
    param: (n: string, o?: ReadonlyMap<string, number[]>) => o?.get(n) ?? params[n] ?? null, setParam: () => {},
  } as unknown as EffectInstance;
  const targets = new ScriptTargets(fb, {} as LoadedEffect, inst, () => {}, null, overrides);
  const c = targets.commands();
  return { calls, c };
}

describe('ScriptTargets の Clear', () => {
  const P = { C: [0.1, 0.2, 0.3, 0.4], D: [0.5], S: [7] };
  const prepared = () => {
    const s = setup(P);
    s.c.setClearColor('C');
    s.c.setClearDepth('D');
    s.c.setClearStencil('S');
    return s;
  };

  it('Clear=Depth は深度とステンシルを消す (ステンシルは ClearSetStencil の値。既定は 0)', () => {
    const s = prepared();
    s.c.clear('depth');
    expect(s.calls).toEqual([[null, 0.5, 7]]);
    const plain = setup({});
    plain.c.clear('depth');
    expect(plain.calls).toEqual([[null, 1, 0]]);
  });

  it('Clear=Color は色だけ、Clear=Stencil はステンシルだけ消す', () => {
    const s = prepared();
    s.c.clear('color');
    s.c.clear('stencil');
    expect(s.calls).toEqual([[[0.1, 0.2, 0.3, 0.4], null, null], [null, null, 7]]);
  });
});

describe('ScriptTargets のパラメータ', () => {
  it('LoopByCount の回数と消す値は、描いている物のパラメータの値 (overrides) から読む', () => {
    const s = setup({ N: [3], C: [0, 0, 0, 1] }, new Map([['N', [5]], ['C', [1, 0, 0, 1]]]));
    expect(s.c.loopCount('N')).toBe(5);
    s.c.setClearColor('C');
    s.c.clear('color');
    expect(s.calls).toEqual([[[1, 0, 0, 1], null, null]]);
    expect(setup({ N: [3] }).c.loopCount('N')).toBe(3);
  });
});
