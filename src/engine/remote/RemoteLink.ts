import { errorText } from '../../core/errors';
import { REMOTE_PROTOCOL, type RemoteHello, type RemoteRequest, type RemoteResponse } from '../../core/remote';
import type { Engine } from '../Engine';
import { runCommand } from './commands';

export type RemoteStatus = 'off' | 'waiting' | 'connected';

// --- MCP サーバーとのつながり ---
// ページから MCP サーバー (127.0.0.1) の WebSocket へつなぎに行き、届いた命令を 1 つずつ順に実行して結果を返す。
// サーバーがまだ動いていない・止まったときは、少し待ってつなぎ直す
export class RemoteLink {
  private ws: WebSocket | null = null;
  private port: number | null = null;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private delay = 1000;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private engine: Engine) {}

  get status(): RemoteStatus { return this.engine.ui.state.remote; }

  connect(port: number) {
    this.disconnect();
    this.port = port;
    this.delay = 1000;
    this.open();
  }
  disconnect() {
    this.port = null;
    clearTimeout(this.retry);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.setStatus('off');
  }

  private open() {
    if (this.port === null) return;
    this.setStatus('waiting');
    const ws = this.ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
    ws.onopen = () => {
      this.delay = 1000;
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
      if (this.port === null) return;
      this.setStatus('waiting');
      this.retry = setTimeout(() => this.open(), this.delay);
      this.delay = Math.min(this.delay * 2, 5000);
    };
  }

  private async handle(ws: WebSocket, req: RemoteRequest) {
    let res: RemoteResponse;
    try {
      res = { id: req.id, result: (await runCommand(this.engine, req.method, req.params)) ?? null };
    } catch (err) {
      res = { id: req.id, error: errorText(err) };
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(res));
  }

  private setStatus(remote: RemoteStatus) {
    if (this.engine.ui.state.remote !== remote) this.engine.ui.set({ remote });
  }
}
