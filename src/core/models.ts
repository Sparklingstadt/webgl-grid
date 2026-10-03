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
// モーション (.vmd。ダンス・カメラ) とポーズ・表情 (.vpd)。models/ の中ならどこにあってもよい
export interface FolderFileEntry {
  name: string;   // ファイル名から
  folder: string; // models/ から見たフォルダ
  path: string;   // models/ から見た場所
  size: number;
}
export interface ModelsListing { models: ModelFolderEntry[]; motions: FolderFileEntry[]; poses: FolderFileEntry[] }
// 一緒に読むファイル (テクスチャ)。モーション・曲は、勝手に付けないよう入れない
export const MODEL_TEXTURE_FILE = /\.(png|jpe?g|bmp|tga|gif|webp|spa|sph|dds)$/i;
