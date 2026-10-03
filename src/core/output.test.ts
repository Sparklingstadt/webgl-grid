import { describe, expect, it } from 'vitest';
import { OUTPUT_DEFAULT, clampOutputSize, frameSpan, normalizeOutput, outputFileName, outputFrame, presetIndex, scaleFov } from './output';

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
