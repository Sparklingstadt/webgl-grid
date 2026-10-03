// --- 外部からの操作 (MCP) の約束事 ---
// MCP サーバー (mcp/server.ts) とページは WebSocket でつながる。ページが MCP サーバーへつなぎに行き、
// サーバーから届いた命令 (RemoteRequest) をエンジンで実行して、結果 (RemoteResponse) を返す。
// このファイルはページと MCP サーバー (Node) の両方から読むので、型と定数だけを置く
export const REMOTE_DEFAULT_PORT = 7457;
export const REMOTE_PROTOCOL = 1;

export interface RemoteHello { type: 'hello'; app: 'webgl-grid'; protocol: number; url: string }
export interface RemoteRequest { id: number; method: string; params?: unknown }
export type RemoteResponse = { id: number; result: unknown } | { id: number; error: string };

// ファイルは base64 で送る (名前はファイル名だけ。MMD のテクスチャはファイル名で対応づける)
// path は MCP サーバーが読んだ元の場所 (分かるときだけ。参照だけのプロジェクトで使う)
export interface RemoteFile { name: string; type?: string; data: string; path?: string }

// ページの URL の ?mcp (=ポート番号) から、つなぎに行くポートを決める。なければ null
export function remotePortFromSearch(search: string): number | null {
  const p = new URLSearchParams(search);
  if (!p.has('mcp')) return null;
  const v = Number(p.get('mcp'));
  return Number.isInteger(v) && v > 0 && v < 65536 ? v : REMOTE_DEFAULT_PORT;
}

// WebSocket でつないでよいページか (自分のパソコンで開いたページだけ)。ほかのサイトに操作させない
export function isLocalOrigin(origin: string | undefined) {
  if (!origin) return false;
  try {
    const { protocol, hostname } = new URL(origin);
    return (protocol === 'http:' || protocol === 'https:') && ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
  } catch {
    return false;
  }
}

export function toBase64(bytes: Uint8Array) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromBase64(b64: string) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
