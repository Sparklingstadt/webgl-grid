import { WebSocketServer, type WebSocket } from 'ws';
import { REMOTE_PROTOCOL, isLocalOrigin, type RemoteHello, type RemoteResponse } from '../src/core/remote.ts';

// --- ページとの橋渡し ---
// 127.0.0.1 で WebSocket を待ち、自分のパソコンで開いたページ (localhost) からのつながりだけを受け付ける。
// つながったページに命令を送り、返事を待つ。ページが複数つながったときは、最後につながったものを使う
export class AppBridge {
  private app: { ws: WebSocket; url: string } | null = null;
  private pending = new Map<number, { ok: (v: unknown) => void; ng: (e: Error) => void; timer: NodeJS.Timeout }>();
  private nextId = 1;
  private waiters = new Set<() => void>();
  readonly ready: Promise<void>;
  private readonly wss: WebSocketServer;

  readonly port: number;
  private log: (msg: string) => void;

  constructor(port: number, log: (msg: string) => void) {
    this.port = port;
    this.log = log;
    this.wss = new WebSocketServer({
      host: '127.0.0.1', port, maxPayload: 2 ** 30,
      verifyClient: ({ origin }: { origin?: string }) => isLocalOrigin(origin),
    });
    this.ready = new Promise((ok, ng) => {
      this.wss.once('listening', () => ok());
      this.wss.once('error', ng);
    });
    this.wss.on('connection', ws => {
      ws.once('message', data => {
        let hello: RemoteHello;
        try { hello = JSON.parse(String(data)); } catch { ws.close(); return; }
        if (hello.type !== 'hello' || hello.app !== 'webgl-grid' || hello.protocol !== REMOTE_PROTOCOL) { ws.close(1008, 'protocol'); return; }
        this.app = { ws, url: hello.url };
        this.log(`ページがつながりました: ${hello.url}`);
        for (const w of this.waiters) w();
        this.waiters.clear();
        ws.on('message', d => this.onResponse(String(d)));
      });
      ws.on('close', () => {
        if (this.app?.ws !== ws) return;
        this.app = null;
        this.log('ページとのつながりが切れました');
        for (const [id, p] of this.pending) { clearTimeout(p.timer); p.ng(new Error('ページとのつながりが切れました')); this.pending.delete(id); }
      });
    });
  }

  get connected() { return !!this.app; }
  get appUrl() { return this.app?.url ?? null; }

  // ページがつながるまで最大 ms ミリ秒待つ
  waitForApp(ms: number) {
    if (this.app) return Promise.resolve(true);
    return new Promise<boolean>(ok => {
      const done = () => { clearTimeout(timer); ok(true); };
      const timer = setTimeout(() => { this.waiters.delete(done); ok(false); }, ms);
      this.waiters.add(done);
    });
  }

  call(method: string, params: unknown, timeoutMs = 60_000): Promise<unknown> {
    const app = this.app;
    if (!app) return Promise.reject(new Error(NOT_CONNECTED));
    const id = this.nextId++;
    return new Promise((ok, ng) => {
      const timer = setTimeout(() => { this.pending.delete(id); ng(new Error(`ページから ${timeoutMs / 1000} 秒返事がありません (${method})`)); }, timeoutMs);
      this.pending.set(id, { ok, ng, timer });
      app.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  private onResponse(text: string) {
    let res: RemoteResponse;
    try { res = JSON.parse(text); } catch { return; }
    const p = this.pending.get(res.id);
    if (!p) return;
    this.pending.delete(res.id);
    clearTimeout(p.timer);
    if ('error' in res) p.ng(new Error(res.error)); else p.ok(res.result);
  }

  close() { this.wss.close(); }
}

export const NOT_CONNECTED = 'webgl-grid のページがつながっていません。open_app でアプリを開くか、アプリを ?mcp を付けて開く (または「ファイル > 外部から操作 (MCP) を受け付ける」を選ぶ) と使えます';
