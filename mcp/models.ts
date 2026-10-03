import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_TEXTURE_FILE, MODELS_FILE_PATH, MODELS_PATH, type ModelFolderEntry, type ModelsListing, type MotionFolderEntry } from '../src/core/models.ts';

// --- models/ フォルダ (ユーザーの PMX モデル置き場) の一覧とファイルを、アプリに渡す ---
// Vite の開発サーバー・プレビュー (vite.config.ts) と、MCP サーバーがアプリを配るとき (appServer.ts) に使う。
// 渡すのは models/ の中だけ (外のファイルは見せない)。場所は環境変数 WEBGL_GRID_MODELS_DIR で変えられる (テスト用)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const modelsDir = () => path.resolve(process.env.WEBGL_GRID_MODELS_DIR || path.join(ROOT, 'models'));
const MAX_FILES = 4000, MAX_DEPTH = 6;

// フォルダの中のファイル (models/ から見た場所、/ 区切り) と大きさ
async function walk(dir: string, rel: string, out: { rel: string; size: number }[], depth = 0) {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name), r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) await walk(p, r, out, depth + 1);
    else if (e.isFile()) out.push({ rel: r, size: (await stat(p).catch(() => null))?.size ?? 0 });
    if (out.length >= MAX_FILES) return;
  }
}

// モデルとモーションの一覧: models/ の直下のフォルダごとに、中の .pmx をモデルにする (テクスチャはそのフォルダの画像)。
// モーション (.vmd) は、どこにあっても並べる
export async function listModels(dir = modelsDir()): Promise<ModelsListing> {
  const out: ModelFolderEntry[] = [], motions: MotionFolderEntry[] = [];
  const top = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const groups: [string, { rel: string; size: number }[]][] = [];
  const loose: { rel: string; size: number }[] = [];
  for (const e of top) {
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) { const files: { rel: string; size: number }[] = []; await walk(path.join(dir, e.name), e.name, files); groups.push([e.name, files]); }
    else if (e.isFile()) loose.push({ rel: e.name, size: (await stat(path.join(dir, e.name)).catch(() => null))?.size ?? 0 });
  }
  groups.push(['', loose]);
  for (const [folder, files] of groups) {
    const tex = files.filter(f => MODEL_TEXTURE_FILE.test(f.rel));
    const texSize = tex.reduce((s, f) => s + f.size, 0);
    for (const pmx of files.filter(f => /\.pmx$/i.test(f.rel))) {
      out.push({ name: path.basename(pmx.rel, path.extname(pmx.rel)), folder, pmx: pmx.rel, files: tex.map(f => f.rel), size: pmx.size + texSize });
    }
    for (const v of files.filter(f => /\.vmd$/i.test(f.rel))) {
      motions.push({ name: path.basename(v.rel, path.extname(v.rel)), folder: path.posix.dirname(v.rel) === '.' ? '' : path.posix.dirname(v.rel), path: v.rel, size: v.size });
    }
  }
  return {
    models: out.sort((a, b) => a.folder.localeCompare(b.folder) || a.pmx.localeCompare(b.pmx)),
    motions: motions.sort((a, b) => a.folder.localeCompare(b.folder) || a.path.localeCompare(b.path)),
  };
}

// models/ の中のファイルの、本当の場所 (外を指していれば null)
export function resolveModelFile(rel: string, dir = modelsDir()) {
  const file = path.resolve(dir, rel);
  return file.startsWith(dir + path.sep) ? file : null;
}

// 一覧かファイルの問い合わせなら答えて true。ほかのリクエストなら何もせず false
export async function answerModels(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const p = url.pathname.replace(/^\/+/, '');
  if (p.endsWith(MODELS_FILE_PATH)) {
    const file = resolveModelFile(url.searchParams.get('path') ?? '');
    const st = file ? await stat(file).catch(() => null) : null;
    if (!file || !st?.isFile()) { res.writeHead(404).end(); return true; }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': st.size, 'cache-control': 'no-store' });
    createReadStream(file).pipe(res);
    return true;
  }
  if (p.endsWith(MODELS_PATH)) {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(await listModels()));
    return true;
  }
  return false;
}

// Vite のミドルウェア (connect 形式)
export const modelsMiddleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
  answerModels(req, res).then(handled => { if (!handled) next(); }, next);
};
