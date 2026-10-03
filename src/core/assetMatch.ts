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
