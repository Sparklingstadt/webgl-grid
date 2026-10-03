import { errorText } from '../../core/errors';
import { REMOTE_PROTOCOL, REMOTE_STATUS_PATH, type RemoteHello, type RemoteRequest, type RemoteResponse } from '../../core/remote';
import type { Engine } from '../Engine';
import { runCommand } from './commands';

export type RemoteStatus = 'off' | 'waiting' | 'connected';
export const REMOTE_MAX_RETRIES = 3; // つなげない・切れたときに、つなぎ直す回数

// --- MCP サーバーとのつながり ---
// ページから MCP サーバー (127.0.0.1) の WebSocket へつなぎに行き、届いた命令を 1 つずつ順に実行して結果を返す。
// ブラウザは、つながらなかった WebSocket を必ずコンソールにエラーとして出すので、先にページを配っているサーバーへ
// MCP サーバーが動いているかを問い合わせ (REMOTE_STATUS_PATH。エラーにならない)、動いているときだけつなぐ。
// 見つからない・切れたときは、1・2・4 秒おいて 3 回までつなぎ直し、それでもだめならやめる
export class RemoteLink {
  private ws: WebSocket | null = null;
  private port: number | null = null;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private retries = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private engine: Engine) {}

  get status(): RemoteStatus { return this.engine.ui.state.remote; }

  connect(port: number) {
    this.disconnect();
    this.port = port;
    this.retries = 0;
    void this.attempt();
  }
  disconnect() {
    this.port = null;
    clearTimeout(this.retry);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.setStatus('off');
  }

  private async attempt() {
    const port = this.port;
    if (port === null) return;
    this.setStatus('waiting');
    const up = await this.serverUp(port);
    if (this.port !== port) return; // 待つあいだに、やめた・つなぎ先を変えた
    if (up === false) this.retryLater();
    else this.open(port); // 動いている (問い合わせに答えないサーバーで配っているときは、そのままつないでみる)
  }

  // MCP サーバーが動いているか。問い合わせに答えないサーバー (dist/ をほかの方法で配ったとき) なら null
  private async serverUp(port: number): Promise<boolean | null> {
    try {
      const res = await fetch(`${REMOTE_STATUS_PATH}?port=${port}`, { cache: 'no-store' });
      if (!res.ok || !res.headers.get('content-type')?.includes('json')) return null;
      return !!(await res.json()).up;
    } catch {
      return false;
    }
  }

  private retryLater() {
    if (this.port === null) return;
    if (this.retries >= REMOTE_MAX_RETRIES) {
      this.disconnect();
      this.engine.ui.toast(`MCP サーバーにつなげませんでした (${REMOTE_MAX_RETRIES} 回つなぎ直しました)。サーバーを起動してから「ファイル > 外部から操作 (MCP) を受け付ける」を選んでください`, 10000);
      return;
    }
    this.setStatus('waiting');
    this.retry = setTimeout(() => void this.attempt(), 1000 * 2 ** this.retries++);
  }

  private open(port: number) {
    const ws = this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.onopen = () => {
      this.retries = 0;
      const hello: RemoteHello = { type: 'hello', app: 'webgl-grid', protocol: REMOTE_PROTOCOL, url: location.href };
      ws.send(JSON.stringify(hello));
      this.setStatus('connected');
    };
    ws.onmessage = ev => {
      let req: RemoteRequest;
      try { req = JSON.parse(String(ev.data)); } catch { return; }
      // 命令は届いた順に 1 つずつ (読み込みの途中でレンダリングが始まったりしないように)
      this.queue = this.queue.then(() => this.handle(ws, req));
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.retryLater();
    };
  }

  private async handle(ws: WebSocket, req: RemoteRequest) {
    let res: RemoteResponse;
    try {
      res = { id: req.id, result: (await this.engine.history.batch(() => runCommand(this.engine, req.method, req.params))) ?? null };
    } catch (err) {
      res = { id: req.id, error: errorText(err) };
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(res));
  }

  private setStatus(remote: RemoteStatus) {
    if (this.engine.ui.state.remote !== remote) this.engine.ui.set({ remote });
  }
}
