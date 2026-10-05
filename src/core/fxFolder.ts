// --- fx/ フォルダ (ユーザーの MME のエフェクト置き場) の一覧: アプリを配るサーバーとアプリで使う形 ---
// サーバー (mcp/fx.ts) が fx/ を調べて一覧とファイルを渡し、アプリは一覧から選んだフォルダを、フォルダを選んで読み込んだときと同じように読み込む
export const FX_PATH = '__fx';            // 一覧 (アプリからは、ページからの相対パス)
export const FX_FILE_PATH = '__fx/file';  // ファイル (?path= fx/ から見た場所)
// fx/ の直下のファイルをまとめたフォルダの名前 (fx/ 自身の名前)
export const FX_ROOT_NAME = 'fx';

export interface FxFolderEntry {
  name: string;     // フォルダの名前 (fx/ の直下のフォルダの名前。直下のファイルをまとめたものは FX_ROOT_NAME)
  dir: string;      // fx/ から見たフォルダの場所 ('' は fx/ の直下のファイル)
  files: string[];  // 中のファイル全部 (フォルダから見た場所。/ 区切り)
  fx: string[];     // そのうちの .fx
  size: number;     // ファイルの大きさの合計 (バイト)
}
export interface FxListing { folders: FxFolderEntry[] }

// 隠しファイル・隠しフォルダ (名前が . で始まるもの) は、一覧にも渡すファイルにも入れない
const hasHidden = (rel: string) => rel.split('/').some(s => s.startsWith('.'));

// fx/ の中のファイル (fx/ から見た場所、/ 区切り) を、fx/ の直下のフォルダごとにまとめる。
// 直下のファイルは FX_ROOT_NAME のフォルダ 1 つに。.fx のないフォルダは出さない。名前の順
export function groupFxFolders(files: readonly { rel: string; size: number }[]): FxFolderEntry[] {
  const groups = new Map<string, { rel: string; size: number }[]>();
  for (const f of files) {
    if (hasHidden(f.rel)) continue;
    const slash = f.rel.indexOf('/');
    const dir = slash < 0 ? '' : f.rel.slice(0, slash);
    const inside = { rel: slash < 0 ? f.rel : f.rel.slice(slash + 1), size: f.size };
    const g = groups.get(dir);
    if (g) g.push(inside); else groups.set(dir, [inside]);
  }
  const out: FxFolderEntry[] = [];
  for (const [dir, list] of groups) {
    const fx = list.filter(f => /\.fx$/i.test(f.rel)).map(f => f.rel).sort();
    if (!fx.length) continue;
    out.push({ name: dir || FX_ROOT_NAME, dir, files: list.map(f => f.rel).sort(), fx, size: list.reduce((s, f) => s + f.size, 0) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// サーバーに渡すよう頼む場所 (fx/ から見た場所)
export const fxServerPath = (folder: Pick<FxFolderEntry, 'dir'>, rel: string) => (folder.dir ? `${folder.dir}/${rel}` : rel);
// File の webkitRelativePath (フォルダの名前/フォルダの中のパス)。フォルダを選んだときと同じ形で、EffectStore.addFolder にそのまま渡せる
export const fxFileTarget = (folder: Pick<FxFolderEntry, 'name' | 'dir'>, rel: string) => `${folder.name || FX_ROOT_NAME}/${rel}`;

// 渡してよい場所か: fx/ から見た、隠れていない相対パスで、.. ・ . ・空の部分・絶対パス・ドライブ名・\ ・NUL を含まないもの
export function isServableFxPath(rel: string): boolean {
  if (!rel || /[\\\0]/.test(rel) || /^[a-zA-Z]:/.test(rel)) return false;
  return rel.split('/').every(s => s !== '' && s !== '.' && s !== '..' && !s.startsWith('.'));
}
