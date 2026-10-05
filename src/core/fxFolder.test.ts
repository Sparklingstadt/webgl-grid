import { describe, expect, it } from 'vitest';
import { FX_ROOT_NAME, fxFileTarget, fxServerPath, groupFxFolders, isServableFxPath } from './fxFolder';

const f = (rel: string, size = 1) => ({ rel, size });

describe('fx フォルダの一覧', () => {
  it('fx/ の直下のフォルダごとに、中の .fx の相対パスと全部のファイルを並べる (名前の順)', () => {
    const list = groupFxFolders([
      f('B/sub/b.FX', 10), f('B/tex/a.png', 100), f('A/a.fx', 5), f('A/inc.fxsub', 2),
    ]);
    expect(list.map(e => e.name)).toEqual(['A', 'B']);
    expect(list[0]).toEqual({ name: 'A', dir: 'A', files: ['a.fx', 'inc.fxsub'], fx: ['a.fx'], size: 7 });
    expect(list[1]).toEqual({ name: 'B', dir: 'B', files: ['sub/b.FX', 'tex/a.png'], fx: ['sub/b.FX'], size: 110 });
  });
  it('.fx のないフォルダは出さない', () => {
    expect(groupFxFolders([f('文書/メモ.txt'), f('README.md')])).toEqual([]);
  });
  it('fx/ の直下のファイルは、fx/ の名前のフォルダ 1 つにまとめる', () => {
    const list = groupFxFolders([f('単体.fx', 3), f('README.md', 4), f('A/a.fx', 1)]);
    expect(list.map(e => [e.name, e.dir])).toEqual([['A', 'A'], [FX_ROOT_NAME, '']]);
    expect(list[1]).toEqual({ name: FX_ROOT_NAME, dir: '', files: ['README.md', '単体.fx'], fx: ['単体.fx'], size: 7 });
  });
  it('隠しファイル・隠しフォルダの中は出さない', () => {
    const list = groupFxFolders([f('A/a.fx'), f('A/.git/x.fx'), f('A/.DS_Store'), f('.hidden/h.fx'), f('.top.fx')]);
    expect(list).toEqual([{ name: 'A', dir: 'A', files: ['a.fx'], fx: ['a.fx'], size: 1 }]);
  });
});

describe('fx フォルダのファイルの場所', () => {
  it('サーバーに聞く場所は、フォルダの名前 (直下のファイルは空) とフォルダの中のパスをつなぐ', () => {
    expect(fxServerPath({ dir: 'Ray' }, 'a/b.fx')).toBe('Ray/a/b.fx');
    expect(fxServerPath({ dir: '' }, 'b.fx')).toBe('b.fx');
  });
  it('File の webkitRelativePath は フォルダの名前/パス (EffectStore.addFolder にそのまま渡せる)', () => {
    expect(fxFileTarget({ name: 'Ray', dir: 'Ray' }, 'a/b.fx')).toBe('Ray/a/b.fx');
    expect(fxFileTarget({ name: FX_ROOT_NAME, dir: '' }, 'b.fx')).toBe(`${FX_ROOT_NAME}/b.fx`);
  });
  it('渡してよいのは fx/ の中の、隠れていないファイルだけ (.. ・絶対パス・\\ ・隠しファイル・空は渡さない)', () => {
    for (const ok of ['a.fx', 'A/b/c.fx', 'A/a..b.fx', 'ミク/い.fx']) expect(isServableFxPath(ok), ok).toBe(true);
    for (const ng of ['', '..', '../package.json', 'A/../../x', 'A/..', '/etc/passwd', 'C:/x.fx', 'c:x.fx', 'A\\..\\x', 'A//b', 'A/./b', '.git/config', 'A/.env', 'a\0.fx']) {
      expect(isServableFxPath(ng), JSON.stringify(ng)).toBe(false);
    }
  });
});
