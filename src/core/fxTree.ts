// --- .fx を選ぶ窓の一覧: フォルダの中の .fx の相対パスを、フォルダの木にする ---
// 各階層はファイルを先に、名前の順 (大文字小文字を区別しない) に並べる。フォルダ 1 つだけが入ったフォルダは 1 行 (a/b) にまとめる

export type FxTreeNode =
  | { kind: 'file'; name: string; path: string }
  | { kind: 'folder'; name: string; path: string; count: number; children: FxTreeNode[] };

type Dir = { files: string[]; dirs: Map<string, Dir> };

const byName = (a: string, b: string) => {
  const x = a.toLowerCase(), y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
};

export function fxTree(paths: string[]): FxTreeNode[] {
  const root: Dir = { files: [], dirs: new Map() };
  for (const p of paths) {
    const parts = p.split('/');
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      let next = dir.dirs.get(part);
      if (!next) dir.dirs.set(part, next = { files: [], dirs: new Map() });
      dir = next;
    }
    dir.files.push(parts[parts.length - 1]);
  }
  const build = (dir: Dir, prefix: string): FxTreeNode[] => [
    ...[...dir.files].sort(byName).map(name => ({ kind: 'file' as const, name, path: prefix + name })),
    ...[...dir.dirs.keys()].sort(byName).map(key => {
      let name = key, sub = dir.dirs.get(key)!;
      // (フォルダ 1 つだけが入ったフォルダはまとめる)
      while (sub.files.length === 0 && sub.dirs.size === 1) {
        const [k, d] = [...sub.dirs][0];
        name += `/${k}`;
        sub = d;
      }
      const children = build(sub, `${prefix}${name}/`);
      const count = children.reduce((n, c) => n + (c.kind === 'file' ? 1 : c.count), 0);
      return { kind: 'folder' as const, name, path: prefix + name, count, children };
    }),
  ];
  return build(root, '');
}

// はじめに開いておくフォルダ (のパス): その階層にそれしかないフォルダだけ
export function initiallyOpen(nodes: FxTreeNode[]): string[] {
  const only = nodes.length === 1 ? nodes[0] : undefined;
  return only?.kind === 'folder' ? [only.path, ...initiallyOpen(only.children)] : [];
}

// 絞り込み: 空白で区切った言葉をすべて (大文字小文字を区別せず) パスに含むものを残す。言葉がなければ全部
export function filterFxPaths(paths: string[], query: string): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return paths.filter(p => { const l = p.toLowerCase(); return words.every(w => l.includes(w)); });
}
