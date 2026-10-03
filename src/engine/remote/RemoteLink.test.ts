import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Engine } from '../Engine';
import { REMOTE_MAX_RETRIES, RemoteLink } from './RemoteLink';

// MCP サーバーとのつながり: 動いているかを問い合わせてからつなぎ、だめなら 3 回までつなぎ直す
class FakeSocket {
  static all: FakeSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  constructor(readonly url: string) { FakeSocket.all.push(this); }
  send(d: string) { this.sent.push(d); }
  close() { this.readyState = 3; this.onclose?.(); }
  accept() { this.readyState = 1; this.onopen?.(); }
}

describe('RemoteLink', () => {
  let up = false;
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ up }), { headers: { 'content-type': 'application/json' } }));
  beforeEach(() => {
    vi.useFakeTimers();
    up = false;
    FakeSocket.all = [];
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('location', { href: 'http://localhost:5173/?mcp' });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  const settle = async (ms = 0) => { await vi.advanceTimersByTimeAsync(ms); };

  it('サーバーが動いていなければ WebSocket を作らず、3 回つなぎ直してからやめる', async () => {
    const e = new Engine(), link = new RemoteLink(e);
    link.connect(7457);
    await settle();
    expect(e.ui.state.remote).toBe('waiting');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]).toEqual(['/__webgl-grid-mcp?port=7457', { cache: 'no-store' }]);
    await settle(1000 + 2000 + 4000); // 1・2・4 秒おいて
    expect(fetchMock).toHaveBeenCalledTimes(1 + REMOTE_MAX_RETRIES);
    expect(FakeSocket.all).toHaveLength(0); // つなげない WebSocket は作らない (ブラウザがエラーを出すので)
    expect(e.ui.state.remote).toBe('off');
    expect(e.ui.state.toast?.text).toMatch(/MCP サーバーにつなげませんでした/);
    await settle(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1 + REMOTE_MAX_RETRIES); // もう問い合わせない
  });

  it('待っているあいだにサーバーが動き出したらつなぎ、名乗る', async () => {
    const e = new Engine(), link = new RemoteLink(e);
    link.connect(7457);
    await settle();
    up = true;
    await settle(1000);
    expect(FakeSocket.all.map(s => s.url)).toEqual(['ws://127.0.0.1:7457']);
    FakeSocket.all[0].accept();
    expect(e.ui.state.remote).toBe('connected');
    expect(JSON.parse(FakeSocket.all[0].sent[0])).toMatchObject({ type: 'hello', app: 'webgl-grid' });
  });

  it('切れたら、また 3 回までつなぎ直す (つながったら数え直す)', async () => {
    const e = new Engine(), link = new RemoteLink(e);
    up = true;
    link.connect(7457);
    await settle();
    FakeSocket.all[0].accept();
    up = false;
    FakeSocket.all[0].close(); // サーバーが止まった
    expect(e.ui.state.remote).toBe('waiting');
    await settle(1000 + 2000);
    up = true;
    await settle(4000);
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.all[1].accept();
    expect(e.ui.state.remote).toBe('connected');
  });

  it('やめると、待つのもやめる', async () => {
    const e = new Engine(), link = new RemoteLink(e);
    link.connect(7457);
    await settle();
    link.disconnect();
    await settle(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(e.ui.state.remote).toBe('off');
  });
});
