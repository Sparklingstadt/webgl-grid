// --- 参照だけのプロジェクト (.wgpj): 参照しているファイルと、選ばれたファイルの対応づけ ---
// ブラウザはファイルの置き場所 (パス) を知ることができないので、名前 (大文字・小文字と Unicode の正規化の違いは無視) と
// 大きさで探す。名前と大きさが合うものを優先し、なければ名前だけ合うもの
export interface AssetRef { id: string; name: string; size?: number }
export interface Candidate { name: string; size: number }

export const nameKey = (name: string) => name.replace(/\\/g, '/').split('/').pop()!.normalize('NFC').toLowerCase();

export function matchAssets<T extends Candidate>(refs: AssetRef[], files: T[]): Map<string, T> {
  const byName = new Map<string, T[]>();
  for (const f of files) {
    const k = nameKey(f.name);
    byName.set(k, [...(byName.get(k) ?? []), f]);
  }
  const out = new Map<string, T>();
  for (const r of refs) {
    const same = byName.get(nameKey(r.name)) ?? [];
    const hit = same.find(f => r.size === undefined || f.size === r.size) ?? same[0];
    if (hit) out.set(r.id, hit);
  }
  return out;
}

// 名前だけでは分からない参照 (MME のフォルダのファイル。Ray-MMD には、名前も大きさも同じで中身の違うファイルが別のフォルダにある) を、
// 選ばれたファイルの相対パス (フォルダを選んだ・落としたときの webkitRelativePath) の終わりで探す。
// paths: 合ってほしいパスの終わり (先のものほど優先。'フォルダの名前/パス'、'パス' の順など)。パスの区切りでだけ合わせ、大文字・小文字と
// Unicode の正規化の違いは無視する。合うものがいくつかあれば大きさが合うもの、なければ先のもの。相対パスのないファイルは見ない
export interface PathRef { id: string; paths: string[]; size?: number }
export interface PathCandidate extends Candidate { webkitRelativePath?: string }

const pathKey = (path: string) => path.replace(/\\/g, '/').replace(/^(\.?\/)+/, '').normalize('NFC').toLowerCase();

export function matchAssetPaths<T extends PathCandidate>(refs: PathRef[], files: T[]): Map<string, T> {
  const withPath = files.filter(f => f.webkitRelativePath).map(f => ({ f, key: pathKey(f.webkitRelativePath!) }));
  const out = new Map<string, T>();
  for (const r of refs) {
    for (const p of r.paths) {
      const want = pathKey(p);
      const same = withPath.filter(({ key }) => key === want || key.endsWith(`/${want}`)).map(({ f }) => f);
      const hit = same.find(f => r.size === undefined || f.size === r.size) ?? same[0];
      if (hit) { out.set(r.id, hit); break; }
    }
  }
  return out;
}
