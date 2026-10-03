import { describe, expect, it } from 'vitest';
import { matchAssets } from './assetMatch';

describe('参照しているファイルの対応づけ', () => {
  it('名前と大きさが合うものを優先し、なければ名前だけ合うもの', () => {
    const files = [
      { name: 'tex.png', size: 10 }, { name: 'TEX.png', size: 20 },
      { name: 'ミク.pmx'.normalize('NFD'), size: 5 }, { name: 'dance.vmd', size: 99 },
    ];
    const m = matchAssets([
      { id: 'a', name: 'tex.png', size: 20 },
      { id: 'b', name: 'ミク.pmx', size: 5 },
      { id: 'c', name: 'dance.vmd', size: 1 },  // 大きさが違っても名前が合えば使う
      { id: 'd', name: 'song.wav', size: 3 },   // ない
    ], files);
    expect(m.get('a')).toBe(files[1]);
    expect(m.get('b')).toBe(files[2]);
    expect(m.get('c')).toBe(files[3]);
    expect(m.has('d')).toBe(false);
  });
});
