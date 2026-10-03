import { describe, expect, it } from 'vitest';
import { freeSpot, overlaps, settleHeights, stackFrom, type Stackable } from './stacking';

const cube = (x: number, z: number, y = 0, r = 0): Stackable => ({ x, z, y, r, hx: 0.5, hz: 0.5, h: 1 });

describe('overlaps', () => {
  it('重なっている足場', () => {
    expect(overlaps(cube(0, 0), cube(0.5, 0.5))).toBe(true);
  });
  it('離れている足場', () => {
    expect(overlaps(cube(0, 0), cube(2, 0))).toBe(false);
  });
  it('辺がちょうど接しているだけなら重ならない', () => {
    expect(overlaps(cube(0, 0), cube(1, 0))).toBe(false);
  });
  it('45° 回した立方体は、角が隣のマスにはみ出す', () => {
    // 回していなければ 1.1 離れた立方体とは重ならないが、45° 回すと対角の半分 (約 0.707) までとどく
    expect(overlaps(cube(0, 0), cube(1.1, 0))).toBe(false);
    expect(overlaps(cube(0, 0, 0, Math.PI / 4), cube(1.1, 0))).toBe(true);
  });
});

describe('settleHeights', () => {
  it('重なる物は下から順に積み上がり、離れた物は地面に落ちる', () => {
    const a = cube(0, 0, 5), b = cube(0.2, 0, 9), c = cube(3, 0, 4);
    settleHeights([b, c, a]);
    expect(a.y).toBe(0);
    expect(b.y).toBe(1);
    expect(c.y).toBe(0);
  });
  it('exclude の物は動かさず、足場にもしない', () => {
    const a = cube(0, 0, 0), held = cube(0, 0, 3);
    settleHeights([a, held], [held]);
    expect(held.y).toBe(3);
    expect(a.y).toBe(0);
  });
});

describe('stackFrom', () => {
  it('上に (間接的にも) 載っている物を集める', () => {
    const a = cube(0, 0, 0), b = cube(0, 0, 1), c = cube(0.3, 0, 2), d = cube(3, 0, 0);
    expect(stackFrom([a, b, c, d], a)).toEqual([a, b, c]);
    expect(stackFrom([a, b, c, d], b)).toEqual([b, c]);
  });
});

describe('freeSpot', () => {
  it('空いていれば、その場所', () => {
    expect(freeSpot([], 0.7, 2, 3)).toEqual([2, 3]);
  });
  it('ふさがっていれば、近くの空いているマス', () => {
    const [x, z] = freeSpot([cube(0, 0)], 0.7, 0, 0);
    expect(Math.max(Math.abs(x), Math.abs(z))).toBe(2);
  });
});
