import { describe, expect, it } from 'vitest';
import { filterFxPaths, fxTree, initiallyOpen } from './fxTree';

describe('.fx の木', () => {
  it('フォルダごとにまとめ、各階層はファイルを先に、名前の順 (大文字小文字を区別しない) に並べる。フォルダは中の .fx の数を持つ', () => {
    expect(fxTree(['b.fx', 'Sky/x.fx', 'A.fx', 'Main/m.fx', 'Main/sub/s.fx'])).toEqual([
      { kind: 'file', name: 'A.fx', path: 'A.fx' },
      { kind: 'file', name: 'b.fx', path: 'b.fx' },
      { kind: 'folder', name: 'Main', path: 'Main', count: 2, children: [
        { kind: 'file', name: 'm.fx', path: 'Main/m.fx' },
        { kind: 'folder', name: 'sub', path: 'Main/sub', count: 1, children: [{ kind: 'file', name: 's.fx', path: 'Main/sub/s.fx' }] },
      ] },
      { kind: 'folder', name: 'Sky', path: 'Sky', count: 1, children: [{ kind: 'file', name: 'x.fx', path: 'Sky/x.fx' }] },
    ]);
  });
  it('フォルダ 1 つだけが入ったフォルダは、1 行 (a/b) にまとめる', () => {
    expect(fxTree(['a/b/c/x.fx', 'a/b/c/y.fx', 'top.fx'])).toEqual([
      { kind: 'file', name: 'top.fx', path: 'top.fx' },
      { kind: 'folder', name: 'a/b/c', path: 'a/b/c', count: 2, children: [
        { kind: 'file', name: 'x.fx', path: 'a/b/c/x.fx' },
        { kind: 'file', name: 'y.fx', path: 'a/b/c/y.fx' },
      ] },
    ]);
    // (ファイル 1 つだけのフォルダはまとめない)
    expect(fxTree(['a/x.fx'])).toEqual([
      { kind: 'folder', name: 'a', path: 'a', count: 1, children: [{ kind: 'file', name: 'x.fx', path: 'a/x.fx' }] },
    ]);
  });
  it('はじめに開くのは、その階層にそれしかないフォルダだけ (一番上の階層は見せ、ほかは閉じる)', () => {
    expect(initiallyOpen(fxTree(['a.fx', 'Main/m.fx', 'Sky/s.fx']))).toEqual([]);
    expect(initiallyOpen(fxTree(['Effect/a.fx', 'Effect/Sub/b.fx']))).toEqual(['Effect']);
    expect(initiallyOpen(fxTree(['x/y/a.fx', 'x/y/b.fx']))).toEqual(['x/y']);
  });
  it('絞り込み: 大文字小文字を区別せず、パスに含むものを残す。空白で区切るとすべてを含むもの。空なら全部', () => {
    const paths = ['ray.fx', 'Materials/Main_Ex.fx', 'Skybox/Time of day/Time of day.fx', 'Main/main.fx'];
    expect(filterFxPaths(paths, 'MAIN')).toEqual(['Materials/Main_Ex.fx', 'Main/main.fx']);
    expect(filterFxPaths(paths, 'time day')).toEqual(['Skybox/Time of day/Time of day.fx']);
    expect(filterFxPaths(paths, '  ')).toEqual(paths);
    expect(filterFxPaths(paths, 'nothing')).toEqual([]);
  });
});
