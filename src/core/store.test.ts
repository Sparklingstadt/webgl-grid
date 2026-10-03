import { describe, expect, it, vi } from 'vitest';
import { createStore } from './store';

describe('createStore', () => {
  it('値が変わったときだけ知らせ、状態を新しいオブジェクトに差し替える', () => {
    const store = createStore({ a: 1, b: 'x' });
    const listener = vi.fn();
    store.subscribe(listener);
    const before = store.get();
    store.set({ a: 1 });
    expect(listener).not.toHaveBeenCalled();
    expect(store.get()).toBe(before);
    store.set({ a: 2 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get()).toEqual({ a: 2, b: 'x' });
    expect(store.get()).not.toBe(before);
  });

  it('購読をやめたら知らせない', () => {
    const store = createStore({ n: 0 });
    const listener = vi.fn();
    const off = store.subscribe(listener);
    off();
    store.set({ n: 1 });
    expect(listener).not.toHaveBeenCalled();
  });
});
