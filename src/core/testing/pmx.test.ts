import { describe, expect, it } from 'vitest';
import { makePmx } from './pmx';

const sha256 = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b as Uint8Array<ArrayBuffer>))].map(v => v.toString(16).padStart(2, '0')).join('');

describe('makePmx', () => {
  // 選択肢を足す前のファイルから作ったバイト列のハッシュ
  it('既定のバイト列は今までと同じ', async () => {
    expect(await sha256(makePmx())).toBe('c4f3691e54c5c56dfd235eef278b7c6f02a0bfeaa02f5631b6d9066fe2025637');
    expect(await sha256(makePmx('t', { physics: true }))).toBe('f891254c8f0877be010b4c222b18cb1f0a1903834739366ebedc4bdf3250055e');
    expect(await sha256(makePmx('t', { texture: 'a.png' }))).toBe('8a0a172554c73eb02b2554ac9f21e943502bb2e7c245210da6c41480bdafec97');
  });
  it('材質のフラグと SDEF の頂点を選べる', () => {
    expect(makePmx('t', { flags: 0x1f }).length).toBe(makePmx('t').length);
    expect(makePmx('t', { sdef: true }).length).toBe(makePmx('t').length + 4 * 44); // 上の 4 頂点: 骨 1 つ → 2 つ (+4)・重み (+4)・C・R0・R1 (+36)
  });
});
