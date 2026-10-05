import { describe, expect, it } from 'vitest';
import { MMDParser } from '../../vendor/three-mmd/mmdparser.module.js';
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
  it('UV・拡散色・輪郭線の太さ・外向きの面を選べる', () => {
    const uvs: [number, number][] = [[0, 1], [0.25, 1], [0.5, 1], [0.75, 1], [0, 0], [0.25, 0], [0.5, 0], [0.75, 0]];
    const bytes = makePmx('t', { uvs, diffuse: [0.8, 0.6, 0.4, 1], edgeSize: 3, outward: true });
    const d = new MMDParser.Parser().parsePmx(bytes.buffer as ArrayBuffer, false);
    expect(d.vertices.map((v: { uv: number[] }) => v.uv)).toEqual(uvs);
    expect(d.materials[0].diffuse).toEqual([0.800000011920929, 0.6000000238418579, 0.4000000059604645, 1]);
    expect(d.materials[0].edgeSize).toBe(3);
    // 三角形ごとに 2 番目と 3 番目を入れ替える (外から見て時計回り)
    expect(d.faces.slice(0, 2).map((f: { indices: number[] }) => f.indices)).toEqual([[0, 5, 1], [0, 4, 5]]);
    const inward = new MMDParser.Parser().parsePmx(makePmx('t').buffer as ArrayBuffer, false);
    expect(inward.faces[0].indices).toEqual([0, 1, 5]);
  });
});
