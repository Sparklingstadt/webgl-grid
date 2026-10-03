import { describe, expect, it, vi } from 'vitest';
import { Emitter } from './events';

describe('Emitter', () => {
  it('登録した順に、引数付きで呼び、解除したら呼ばない', () => {
    const e = new Emitter<{ moved: [x: number, y: number] }>();
    const calls: string[] = [];
    const off = e.on('moved', (x, y) => calls.push(`a${x},${y}`));
    e.on('moved', x => calls.push(`b${x}`));
    e.emit('moved', 1, 2);
    off();
    e.emit('moved', 3, 4);
    expect(calls).toEqual(['a1,2', 'b1', 'b3']);
  });
  it('誰も聞いていなくてもよい', () => {
    const e = new Emitter<{ ping: [] }>();
    expect(() => e.emit('ping')).not.toThrow();
    const fn = vi.fn();
    e.on('ping', fn);
    e.emit('ping');
    expect(fn).toHaveBeenCalledOnce();
  });
});
