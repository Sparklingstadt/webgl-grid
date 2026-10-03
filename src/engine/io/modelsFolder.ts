import { MODELS_FILE_PATH, MODELS_PATH, type ModelFolderEntry } from '../../core/models';

// --- models/ フォルダのモデル: アプリを配るサーバーに一覧を聞き、選んだモデルのファイルをもらう ---
// (静的に配っているとき・サーバーが答えないときは、一覧は空)
export async function listModelFolder(): Promise<ModelFolderEntry[]> {
  try {
    const res = await fetch(MODELS_PATH, { cache: 'no-store' });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return [];
    const data = await res.json();
    return Array.isArray(data?.models) ? data.models : [];
  } catch {
    return [];
  }
}

// モデルの .pmx (最初) とテクスチャを File にする (元の場所は sourcePath に)
export async function fetchModelFiles(m: ModelFolderEntry, onProgress?: (done: number, total: number) => void): Promise<File[]> {
  const paths = [m.pmx, ...m.files];
  let done = 0;
  return Promise.all(paths.map(async rel => {
    const res = await fetch(`${MODELS_FILE_PATH}?path=${encodeURIComponent(rel)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(rel);
    const f = new File([await res.blob()], rel.split('/').pop()!);
    Object.defineProperty(f, 'sourcePath', { value: `models/${rel}` });
    onProgress?.(++done, paths.length);
    return f;
  }));
}
