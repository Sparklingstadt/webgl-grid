// --- models/ フォルダ (ユーザーの PMX モデル置き場) の一覧: アプリを配るサーバーとアプリで使う形 ---
// サーバー (mcp/models.ts) が models/ を調べて一覧とファイルを渡し、アプリは一覧から選んだモデルを読み込む
export const MODELS_PATH = '__models';            // 一覧 (アプリからは、ページからの相対パス)
export const MODELS_FILE_PATH = '__models/file';  // ファイル (?path= models/ から見た場所)

export interface ModelFolderEntry {
  name: string;       // モデルの名前 (.pmx のファイル名から)
  folder: string;     // models/ から見たフォルダ ('' は models/ の直下)
  pmx: string;        // .pmx の場所 (models/ から見た場所。/ 区切り)
  files: string[];    // 一緒に読むファイル (テクスチャなど。.pmx は含まない)
  size: number;       // .pmx とファイルの大きさの合計 (バイト)
}
// モーション (.vmd。ダンス・カメラ)・ポーズと表情 (.vpd)・曲。models/ の中ならどこにあってもよい
export interface FolderFileEntry {
  name: string;   // ファイル名から
  folder: string; // models/ から見たフォルダ
  path: string;   // models/ から見た場所
  size: number;
}
export interface ModelsListing { models: ModelFolderEntry[]; motions: FolderFileEntry[]; poses: FolderFileEntry[]; songs: FolderFileEntry[] }
// 曲 (models/ の中ならどこでも。一覧の「曲」に出す)
export const SONG_FILE = /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus)$/i;
// 起動したときに、まず読み込んでみるモデル (models/ のどこかにある、このファイル名の .pmx)。
// 読み込めなければ、いつもどおり一覧から選んでもらう
export const DEFAULT_MODEL_FILE = 'げのげ式初音ミク.pmx';
export const isDefaultModel = (m: ModelFolderEntry) => (m.pmx.split('/').pop() ?? '').normalize('NFC') === DEFAULT_MODEL_FILE.normalize('NFC');
// 起動したときに決まったモデルに付けるもの: モーションのあるフォルダの .vmd 全部 (体・表情・口・カメラ) と、そのフォルダの曲。
// フォルダは、モデルのフォルダ (の中のフォルダ) で最初に .vmd があるもの、なければ models/ で最初のもの (一覧はフォルダ・場所の順)。
// .vmd がどこにもなければ null
export function startFiles(l: Pick<ModelsListing, 'motions' | 'songs'>, model: ModelFolderEntry): { motions: FolderFileEntry[]; song: FolderFileEntry | null } | null {
  const inside = (m: FolderFileEntry) => !!model.folder && (m.folder === model.folder || m.folder.startsWith(`${model.folder}/`));
  const first = l.motions.find(inside) ?? l.motions[0];
  if (!first) return null;
  return { motions: l.motions.filter(m => m.folder === first.folder), song: l.songs.find(s => s.folder === first.folder) ?? null };
}
// 一緒に読むファイル (テクスチャ)。モーション・曲は、勝手に付けないよう入れない
export const MODEL_TEXTURE_FILE = /\.(png|jpe?g|bmp|tga|gif|webp|spa|sph|dds)$/i;
