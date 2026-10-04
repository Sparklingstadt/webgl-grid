import { describe, expect, it } from 'vitest';
import { OUTPUT_DEFAULT, clampOutputSize, frameSpan, normalizeOutput, outputFileName, outputFrame, presetIndex, scaleFov, blurTimes, normalizeRegion, regionPixels } from './output';

describe('出力の設定', () => {
  it('大きさは偶数にそろえ、16〜4096 に収める', () => {
    expect(clampOutputSize(1921)).toBe(1922);
    expect(clampOutputSize(1080)).toBe(1080);
    expect(clampOutputSize(3)).toBe(16);
    expect(clampOutputSize(99999)).toBe(4096);
    expect(clampOutputSize(NaN)).toBe(16);
  });
  it('プリセットの見分け', () => {
    expect(presetIndex(1920, 1080)).toBe(0);
    expect(presetIndex(1080, 1920)).toBe(3);
    expect(presetIndex(1000, 1000)).toBe(-1);
  });
  it('フレーム範囲は両端を含む (30 fps)', () => {
    expect(frameSpan(0, 29)).toEqual({ count: 30, seconds: 1 });
    expect(frameSpan(10, 10)).toEqual({ count: 1, seconds: 1 / 30 });
  });
  it('ファイル名: 画像は 4 桁のフレーム番号、使えない文字は _ にする', () => {
    expect(outputFileName('ダンス', 'png', 25)).toBe('ダンス_0025.png');
    expect(outputFileName('a/b:c', 'mp4')).toBe('a_b_c.mp4');
    expect(outputFileName('  ', 'webm')).toBe('レンダー.webm');
  });
  it('保存されていた設定を、使える値にそろえる', () => {
    expect(normalizeOutput(undefined)).toEqual(OUTPUT_DEFAULT);
    expect(normalizeOutput({ width: 1281, format: 'avi' as never, quality: 'high', audio: false }))
      .toEqual({ ...OUTPUT_DEFAULT, width: 1282, quality: 'high', audio: false });
  });
  it('ビューポートの中の出力の枠: 横長の出力は上下を、縦長の出力は左右を空けて真ん中に置く', () => {
    expect(outputFrame(1000, 800, 1920, 1080)).toEqual({ x: 0, y: 118.75, w: 1000, h: 562.5, fovScale: 562.5 / 800 });
    expect(outputFrame(1000, 800, 1080, 1920)).toEqual({ x: 275, y: 0, w: 450, h: 800, fovScale: 1 });
  });
  it('画角を tan で何倍かにする', () => {
    expect(scaleFov(60, 1)).toBeCloseTo(60);
    expect(Math.tan(scaleFov(60, 0.5) * Math.PI / 360)).toBeCloseTo(Math.tan(Math.PI / 6) * 0.5);
  });
});

describe('レンダー範囲・モーションブラー', () => {
  it('範囲は出力の枠の中の割合にそろえ、書き出す大きさは偶数で 16 以上、枠からはみ出さない', () => {
    expect(normalizeRegion({ x: -0.2, y: 0.5, w: 0.5, h: 0.9 })).toEqual({ x: 0, y: 0.5, w: 0.5, h: 0.5 });
    expect(normalizeRegion({ x: 0.5, y: 0.5, w: 0.001, h: 0.3 })).toBeNull();
    expect(normalizeRegion(null)).toBeNull();
    expect(regionPixels({ width: 1920, height: 1080, region: null })).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
    expect(regionPixels({ width: 1920, height: 1080, region: { x: 0.25, y: 0.5, w: 0.5, h: 0.5 } })).toEqual({ x: 480, y: 540, w: 960, h: 540 });
    expect(regionPixels({ width: 100, height: 100, region: { x: 0.95, y: 0, w: 0.05, h: 0.333 } })).toEqual({ x: 84, y: 0, w: 16, h: 34 });
  });
  it('モーションブラーは、シャッターが開いてからフレームの時刻までを等分した時刻を重ねる', () => {
    expect(blurTimes(1, 0.5, 4, 10).map(v => +v.toFixed(4))).toEqual([0.9625, 0.975, 0.9875, 1]);
    expect(normalizeOutput({ shutter: 5, blurSamples: 1 } as never)).toMatchObject({ motionBlur: false, shutter: 1, blurSamples: 2, region: null });
  });
});
