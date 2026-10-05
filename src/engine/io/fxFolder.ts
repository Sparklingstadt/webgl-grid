import { FX_FILE_PATH, FX_PATH, fxFileTarget, fxServerPath, type FxFolderEntry, type FxListing } from '../../core/fxFolder';

// --- fx/ フォルダのエフェクト: アプリを配るサーバーに一覧を聞き、選んだフォルダのファイルをもらう (models/ と同じ仕組み。engine/io/modelsFolder.ts) ---
// 静的に配っているとき・サーバーが答えないとき・fx/ にエフェクトがないときは、一覧は null (選択肢を出さない)
export async function listFxFolder(): Promise<FxListing | null> {
  try {
    const res = await fetch(FX_PATH, { cache: 'no-store' });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null;
    const data = await res.json();
    const folders = (Array.isArray(data?.folders) ? data.folders : []).filter(isEntry);
    return folders.length ? { folders } : null;
  } catch {
    return null;
  }
}
const isEntry = (v: unknown): v is FxFolderEntry => {
  const e = v as FxFolderEntry | null;
  return !!e && typeof e.name === 'string' && typeof e.dir === 'string' && Array.isArray(e.files) && Array.isArray(e.fx) && typeof e.size === 'number';
};

// 同時に聞くファイルの数 (Ray-MMD は 900 ほど。全部を一度に聞かない)
const PARALLEL = 8;

// フォルダの中のファイル全部を File にする。webkitRelativePath は フォルダの名前/パス (フォルダを選んだときと同じ形)
export async function fetchFxFiles(folder: FxFolderEntry, onProgress?: (done: number, total: number) => void): Promise<File[]> {
  const out: File[] = [];
  let next = 0, done = 0, failed = false;
  const worker = async () => {
    for (let i = next++; i < folder.files.length && !failed; i = next++) {
      const rel = folder.files[i];
      try {
        const res = await fetch(`${FX_FILE_PATH}?path=${encodeURIComponent(fxServerPath(folder, rel))}`, { cache: 'no-store' });
        if (!res.ok) throw new Error(rel);
        const modified = Date.parse(res.headers.get('last-modified') ?? '');
        const f = new File([await res.blob()], rel.split('/').pop()!, Number.isFinite(modified) ? { lastModified: modified } : undefined);
        Object.defineProperty(f, 'webkitRelativePath', { value: fxFileTarget(folder, rel) });
        out[i] = f;
        onProgress?.(++done, folder.files.length);
      } catch (err) {
        failed = true; // (ほかの取りかかりも止める)
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, folder.files.length) }, worker));
  return out;
}
