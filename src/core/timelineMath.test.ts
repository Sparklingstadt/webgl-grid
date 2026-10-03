import { describe, expect, it } from 'vitest';
import { fitView, frameAt, rulerStep, zoomView } from './timelineMath';

describe('rulerStep', () => {
  it('数字の間隔が 50px 以上になる、きりのいい間隔', () => {
    expect(rulerStep(60)).toBe(1);
    expect(rulerStep(10)).toBe(5);
    expect(rulerStep(3)).toBe(20);
    expect(rulerStep(0.4)).toBe(200);
  });
});

describe('fitView', () => {
  it('開始〜終了に少し余白を付ける', () => {
    expect(fitView(0, 250)).toEqual({ f0: -10, f1: 260 });
    expect(fitView(0, 10)).toEqual({ f0: -2, f1: 12 }); // 短くても 2 フレームは余白を取る
  });
});

describe('zoomView', () => {
  it('指した位置を動かさずに拡大・縮小する', () => {
    const v = zoomView({ f0: 0, f1: 100 }, 25, 0.5);
    expect(v).toEqual({ f0: 12.5, f1: 62.5 });
    expect(frameAt(v, 25, 100)).toBe(Math.round(12.5 + 0.25 * 50)); // 同じ割合の位置に、同じフレームがある
  });
  it('幅は 10 フレームより狭くしない', () => {
    const v = zoomView({ f0: 0, f1: 20 }, 10, 0.01);
    expect(v.f1 - v.f0).toBe(10);
  });
});

describe('frameAt', () => {
  it('位置からフレーム (整数) を求める', () => {
    expect(frameAt({ f0: 0, f1: 100 }, 50, 200)).toBe(25);
    expect(frameAt({ f0: -10, f1: 10 }, 0, 100)).toBe(-10);
  });
});
