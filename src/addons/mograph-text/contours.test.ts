import { describe, expect, it } from 'vitest';
import { area, nest, simplify, traceLoops } from './contours';

// 格子に図形を塗る
const grid = (w: number, h: number, fill: (x: number, y: number) => boolean) => {
  const v = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) v[y * w + x] = fill(x, y) ? 1 : 0;
  return v;
};

describe('文字の輪郭', () => {
  it('四角を塗ると、閉じた輪郭が 1 つ (広さもだいたい同じ)', () => {
    const loops = traceLoops(grid(20, 20, (x, y) => x >= 5 && x < 15 && y >= 5 && y < 15), 20, 20);
    expect(loops).toHaveLength(1);
    expect(Math.abs(area(loops[0]))).toBeGreaterThan(80);
    expect(Math.abs(area(loops[0]))).toBeLessThan(110);
  });
  it('穴のある形 (ロの字) は、外側 1 つと穴 1 つ。離れた 2 つの形は外側 2 つ', () => {
    const ring = grid(30, 30, (x, y) => x >= 5 && x < 25 && y >= 5 && y < 25 && !(x >= 10 && x < 20 && y >= 10 && y < 20));
    const outs = nest(traceLoops(ring, 30, 30));
    expect(outs).toHaveLength(1);
    expect(outs[0].holes).toHaveLength(1);
    expect(Math.abs(area(outs[0].outer))).toBeGreaterThan(Math.abs(area(outs[0].holes[0])));
    const two = nest(traceLoops(grid(30, 10, (x, y) => y >= 2 && y < 8 && ((x >= 2 && x < 10) || (x >= 18 && x < 26))), 30, 10));
    expect(two.map(o => o.holes.length)).toEqual([0, 0]);
    // 回の字 (穴の中にまた形) は、外側 2 つ・穴 1 つ
    const nested = nest(traceLoops(grid(40, 40, (x, y) => {
      const r = Math.max(Math.abs(x - 20), Math.abs(y - 20));
      return r < 15 && !(r >= 10 && r < 15 ? false : r >= 5 && r < 10);
    }), 40, 40));
    expect(nested).toHaveLength(2);
    expect(nested.reduce((n, o) => n + o.holes.length, 0)).toBe(1);
  });
  it('斜めにだけつながった角 (市松) でも、線はみな閉じる', () => {
    const loops = traceLoops(grid(6, 6, (x, y) => (x + y) % 2 === 0 && x > 0 && y > 0 && x < 5 && y < 5), 6, 6);
    expect(loops.length).toBeGreaterThan(0);
    expect(loops.every(l => l.length >= 3)).toBe(true);
  });
  it('間引くと点が減り、形はほとんど変わらない', () => {
    const [loop] = traceLoops(grid(60, 60, (x, y) => Math.hypot(x - 30, y - 30) < 20), 60, 60);
    const s = simplify(loop, 0.5);
    expect(s.length).toBeLessThan(loop.length);
    expect(Math.abs(area(s) - area(loop)) / Math.abs(area(loop))).toBeLessThan(0.03);
  });
});
