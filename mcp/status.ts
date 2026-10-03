import type { IncomingMessage, ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { REMOTE_STATUS_PATH } from '../src/core/remote.ts';

// --- MCP サーバーが動いているかの問い合わせ (REMOTE_STATUS_PATH) に答える ---
// Vite の開発サーバー・プレビュー (vite.config.ts) と、MCP サーバーがアプリを配るとき (appServer.ts) に使う

// 127.0.0.1 の port で、だれかが待っているか
export function isPortOpen(port: number, timeoutMs = 300) {
  return new Promise<boolean>(ok => {
    const socket = connect({ host: '127.0.0.1', port });
    const done = (up: boolean) => { socket.destroy(); ok(up); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

// 問い合わせなら答えて true。ほかのリクエストなら何もせず false
export async function answerStatus(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname !== REMOTE_STATUS_PATH) return false;
  const port = Number(url.searchParams.get('port'));
  const up = Number.isInteger(port) && port > 0 && port < 65536 && await isPortOpen(port);
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ up }));
  return true;
}

// Vite のミドルウェア (connect 形式)
export const statusMiddleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
  answerStatus(req, res).then(handled => { if (!handled) next(); }, next);
};
