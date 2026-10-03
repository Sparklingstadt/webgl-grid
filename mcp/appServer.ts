import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import path from 'node:path';

// --- ビルドしたアプリ (dist/) を 127.0.0.1 で配る ---
// MCP サーバーだけで、ブラウザにアプリを開いて操作できるようにする (npm run build が済んでいること)
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain',
};

export async function serveApp(dist: string, port: number): Promise<Server | null> {
  if (!(await stat(path.join(dist, 'index.html')).catch(() => null))) return null;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.resolve(dist, rel);
    if (!file.startsWith(path.resolve(dist) + path.sep)) { res.writeHead(403).end(); return; } // dist の外は見せない
    const st = await stat(file).catch(() => null);
    if (!st?.isFile()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'content-length': st.size });
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((ok, ng) => { server.once('error', ng); server.listen(port, '127.0.0.1', () => ok()); });
  return server;
}

// いつものブラウザで URL を開く
export function openBrowser(url: string) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  spawn(cmd, args as string[], { detached: true, stdio: 'ignore' }).unref();
}
