import { createReadStream } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FX_FILE_PATH, FX_PATH, groupFxFolders, isServableFxPath, type FxListing } from '../src/core/fxFolder.ts';

// --- fx/ フォルダ (ユーザーの MME のエフェクト置き場) の一覧とファイルを、アプリに渡す ---
// Vite の開発サーバー・プレビュー (vite.config.ts) と、MCP サーバーがアプリを配るとき (appServer.ts) に使う。mcp/models.ts と同じ仕組み。
// 渡すのは fx/ の中だけ (外のファイルは見せない)。場所は環境変数 WEBGL_GRID_FX_DIR で変えられる (テスト用)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const fxDir = () => path.resolve(process.env.WEBGL_GRID_FX_DIR || path.join(ROOT, 'fx'));
// 1 つのフォルダに数える上限。Ray-MMD 1.5.2 は 897 ファイル・深さ 4 (約 88 MB) で、その 5 倍の余裕を見て
// (モデルが入ったりテクスチャが多かったりする一式も入るように)。上限を超えたら、それ以上は見ない (いつまでも歩かないため)
const MAX_FILES = 5000, MAX_DEPTH = 8;

// フォルダの中のファイル (fx/ から見た場所、/ 区切り) と大きさ。隠しファイル・隠しフォルダは見ない
async function walk(dir: string, rel: string, out: { rel: string; size: number }[], depth = 0) {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name), r = `${rel}/${e.name}`;
    if (e.isDirectory()) await walk(p, r, out, depth + 1);
    else if (e.isFile()) out.push({ rel: r, size: (await stat(p).catch(() => null))?.size ?? 0 });
    if (out.length >= MAX_FILES) return;
  }
}

// エフェクトの一覧: fx/ の直下のフォルダごとに (直下のファイルは fx/ の名前の 1 つのフォルダに)、中の .fx とファイル。.fx のないものは出さない
export async function listFx(dir = fxDir()): Promise<FxListing> {
  const all: { rel: string; size: number }[] = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) await walk(path.join(dir, e.name), e.name, all);
    else if (e.isFile()) all.push({ rel: e.name, size: (await stat(path.join(dir, e.name)).catch(() => null))?.size ?? 0 });
  }
  return { folders: groupFxFolders(all) };
}

// fx/ の中のファイルの、本当の場所 (外を指していれば・隠しファイルなら・なければ null)。
// 外を指す ../ や絶対パスだけでなく、fx/ の中のリンクの行き先が外でも渡さない
export async function resolveFxFile(rel: string, dir = fxDir()): Promise<string | null> {
  if (!isServableFxPath(rel)) return null;
  const file = path.resolve(dir, rel);
  if (!file.startsWith(dir + path.sep)) return null;
  const [real, realDir] = await Promise.all([realpath(file).catch(() => null), realpath(dir).catch(() => null)]);
  return real && realDir && real.startsWith(realDir + path.sep) ? real : null;
}

// 一覧かファイルの問い合わせなら答えて true。ほかのリクエストなら何もせず false
export async function answerFx(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const p = url.pathname.replace(/^\/+/, '');
  if (p.endsWith(FX_FILE_PATH)) {
    const file = await resolveFxFile(url.searchParams.get('path') ?? '');
    const st = file ? await stat(file).catch(() => null) : null;
    if (!file || !st?.isFile()) { res.writeHead(404).end(); return true; }
    // (last-modified は、同じフォルダを読み直したときに「変わっていない」と分かるため。EffectStore.addFolder が更新日時を比べる)
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': st.size, 'last-modified': st.mtime.toUTCString(), 'cache-control': 'no-store' });
    createReadStream(file).pipe(res);
    return true;
  }
  if (p.endsWith(FX_PATH)) {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(await listFx()));
    return true;
  }
  return false;
}

// Vite のミドルウェア (connect 形式)
export const fxMiddleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
  answerFx(req, res).then(handled => { if (!handled) next(); }, next);
};
