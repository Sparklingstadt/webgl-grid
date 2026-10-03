import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RemoteFile } from '../src/core/remote.ts';

// --- MCP サーバーが読み書きするファイル ---
const TEXTURE = /\.(png|jpe?g|bmp|tga|gif|webp|spa|sph|dds)$/i;
const MAX_TOTAL = 1024 * 1024 * 1024; // 一度に送るのは 1 GB まで

const MIME: Record<string, string> = {
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.flac': 'audio/flac', '.opus': 'audio/opus', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp',
};
export const mimeOf = (p: string) => MIME[path.extname(p).toLowerCase()] ?? '';

// フォルダの中のテクスチャ画像 (サブフォルダも。深さ 4 まで)
async function texturesIn(dir: string, depth = 0): Promise<string[]> {
  if (depth > 4) return [];
  const out: string[] = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...await texturesIn(p, depth + 1));
    else if (TEXTURE.test(ent.name)) out.push(p);
  }
  return out;
}

// 読み込むファイルを集める。.pmx を指定したら、同じフォルダ (とサブフォルダ) のテクスチャ画像も一緒に送る。
// フォルダを指定したら、その中のファイル (サブフォルダは含めない) をすべて送る
export async function collectFiles(paths: string[], cwd: string): Promise<string[]> {
  const out = new Set<string>();
  for (const raw of paths) {
    const p = path.resolve(cwd, raw);
    const st = await stat(p).catch(() => null);
    if (!st) throw new Error(`ファイルがありません: ${p}`);
    if (st.isDirectory()) {
      for (const ent of await readdir(p, { withFileTypes: true })) if (ent.isFile() && !ent.name.startsWith('.')) out.add(path.join(p, ent.name));
      continue;
    }
    out.add(p);
    if (/\.pmx$/i.test(p)) for (const t of await texturesIn(path.dirname(p))) out.add(t);
  }
  return [...out];
}

export async function readAsRemoteFiles(paths: string[]): Promise<{ files: RemoteFile[]; bytes: number }> {
  let bytes = 0;
  const files: RemoteFile[] = [];
  for (const p of paths) {
    const data = await readFile(p);
    bytes += data.length;
    if (bytes > MAX_TOTAL) throw new Error('ファイルが大きすぎます (合わせて 1 GB まで)');
    files.push({ name: path.basename(p), type: mimeOf(p), data: data.toString('base64'), path: p });
  }
  return { files, bytes };
}

// 参照だけのプロジェクト (.wgpj) が参照しているファイルを探す: 元の場所 → プロジェクトから見た場所 → プロジェクトと同じフォルダ。
// 大きさが合うものを優先する
export async function findAsset(a: { name: string; size?: number; source?: string; relative?: string }, projectDir: string) {
  const candidates = [a.source, a.relative && path.resolve(projectDir, a.relative), path.join(projectDir, a.name)].filter((p): p is string => !!p);
  let fallback: string | null = null;
  for (const p of candidates) {
    const st = await stat(p).catch(() => null);
    if (!st?.isFile()) continue;
    if (a.size === undefined || st.size === a.size) return p;
    fallback ??= p;
  }
  return fallback;
}

// base64 の中身をファイルに書く (フォルダがなければ作る)。書いた場所の絶対パスを返す
export async function writeBase64(target: string, cwd: string, b64: string) {
  const p = path.resolve(cwd, target);
  await mkdir(path.dirname(p), { recursive: true });
  const data = Buffer.from(b64, 'base64');
  await writeFile(p, data);
  return { path: p, bytes: data.length };
}
