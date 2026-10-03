import { describe, expect, it } from 'vitest';
import { OUTPUT_DEFAULT, clampOutputSize, frameSpan, normalizeOutput, outputFileName, presetIndex } from './output';

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
});
