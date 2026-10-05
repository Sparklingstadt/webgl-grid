import { describe, expect, it } from 'vitest';
import { matchAssetPaths, matchAssets } from './assetMatch';

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

  it('matchAssetPaths: 相対パス (webkitRelativePath) の終わりで探す。先に書いたパスほど優先し、同じなら大きさが合うもの。相対パスのないファイルは見ない', () => {
    const at = (rel: string, size = 10) => ({ name: rel.split('/').pop()!, size, webkitRelativePath: rel });
    const files = [
      at('ray-mmd/Lighting/Default Ambient/spot.fx'), at('ray-mmd/Lighting/Default/spot.fx'),
      at('Other/Default/spot.fx'), at('Back/Shadow/s.fx', 5), at('Back/Shadow/S.FX'.normalize('NFD'), 7),
      { name: 'loose.fx', size: 1, webkitRelativePath: '' }, at('x/Ray/á.fx'.normalize('NFD')),
    ];
    const m = matchAssetPaths([
      { id: 'a', paths: ['ray-mmd/Lighting/Default/spot.fx', 'Lighting/Default/spot.fx'], size: 10 },
      { id: 'b', paths: ['Gone/Default/spot.fx', 'Default/spot.fx'], size: 10 }, // (フォルダの名前が違えば、パスだけで)
      { id: 'c', paths: ['shadow/s.fx'], size: 7 },  // (大文字小文字は問わず、大きさが合うもの)
      { id: 'd', paths: ['loose.fx'], size: 1 },     // (相対パスのないファイルは見ない)
      { id: 'e', paths: ['ault/spot.fx'] },          // (パスの区切りでだけ合う)
      { id: 'f', paths: ['Ray/á.fx'] },         // (Unicode の正規化の違いは無視)
    ], files);
    expect(m.get('a')).toBe(files[1]);
    expect(m.get('b')).toBe(files[1]);
    expect(m.get('c')).toBe(files[4]);
    expect(m.has('d')).toBe(false);
    expect(m.has('e')).toBe(false);
    expect(m.get('f')).toBe(files[6]);
  });
});
