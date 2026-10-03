import { MODELS_FILE_PATH, MODELS_PATH, type ModelFolderEntry, type ModelsListing, type FolderFileEntry } from '../../core/models';

// --- models/ フォルダのモデル: アプリを配るサーバーに一覧を聞き、選んだモデルのファイルをもらう ---
// (静的に配っているとき・サーバーが答えないときは、一覧は空)
const EMPTY: ModelsListing = { models: [], motions: [], poses: [], songs: [] };
export async function listModelFolder(): Promise<ModelsListing> {
  try {
    const res = await fetch(MODELS_PATH, { cache: 'no-store' });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return EMPTY;
    const data = await res.json();
    const list = (v: unknown) => (Array.isArray(v) ? v : []);
    return { models: list(data?.models), motions: list(data?.motions), poses: list(data?.poses), songs: list(data?.songs) };
  } catch {
    return EMPTY;
  }
}

// models/ の中のファイル 1 つ
async function fetchFile(rel: string) {
  const res = await fetch(`${MODELS_FILE_PATH}?path=${encodeURIComponent(rel)}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(rel);
  const f = new File([await res.blob()], rel.split('/').pop()!);
  Object.defineProperty(f, 'sourcePath', { value: `models/${rel}` });
  return f;
}
// モーション (.vmd)・ポーズ (.vpd)・曲のファイル
export const fetchFolderFile = (m: FolderFileEntry) => fetchFile(m.path);

// モデルの .pmx (最初) とテクスチャを File にする (元の場所は sourcePath に)
export async function fetchModelFiles(m: ModelFolderEntry, onProgress?: (done: number, total: number) => void): Promise<File[]> {
  const paths = [m.pmx, ...m.files];
  let done = 0;
  return Promise.all(paths.map(async rel => {
    const f = await fetchFile(rel);
    onProgress?.(++done, paths.length);
    return f;
  }));
}
