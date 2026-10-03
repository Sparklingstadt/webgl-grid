import { describe, expect, it } from 'vitest';
import { REMOTE_DEFAULT_PORT, fromBase64, isLocalOrigin, remotePortFromSearch, toBase64 } from './remote';

describe('外部からの操作 (MCP) の約束事', () => {
  it('?mcp からポートを決める', () => {
    expect(remotePortFromSearch('')).toBeNull();
    expect(remotePortFromSearch('?debug')).toBeNull();
    expect(remotePortFromSearch('?mcp')).toBe(REMOTE_DEFAULT_PORT);
    expect(remotePortFromSearch('?debug&mcp=9000')).toBe(9000);
    expect(remotePortFromSearch('?mcp=abc')).toBe(REMOTE_DEFAULT_PORT);
  });
  it('つないでよいのは、自分のパソコンで開いたページだけ', () => {
    for (const o of ['http://localhost:5173', 'http://127.0.0.1:7458', 'https://localhost', 'http://[::1]:8080']) expect(isLocalOrigin(o)).toBe(true);
    for (const o of [undefined, '', 'null', 'https://example.com', 'http://localhost.evil.com', 'file://', 'chrome-extension://abc']) expect(isLocalOrigin(o)).toBe(false);
  });
  it('base64 の行き来 (大きなデータも)', () => {
    const bytes = Uint8Array.from({ length: 100_000 }, (_, i) => (i * 7) & 255);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
    expect(toBase64(new TextEncoder().encode('hi'))).toBe('aGk=');
  });
});
