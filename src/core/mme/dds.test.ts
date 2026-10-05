import { describe, expect, it } from 'vitest';
import { addDictionary, setLang } from '../i18n.ts';
import en from '../../i18n/en.ts';
import { buildDds } from '../testing/dds.ts';
import { ddsHeader, parseDds } from './dds.ts';

const bytesOf = (a: Float32Array | Uint16Array) => new Uint8Array(a.buffer);
const first = (n: number) => (i: number) => i + n; // 先頭の値が n で、1 ずつ増える

describe('parseDds', () => {
  it('A8R8G8B8 (マスク) は bgra8', () => {
    const img = parseDds(buildDds({ format: 'A8R8G8B8', width: 4, height: 4, fill: first(10) }));
    expect(img).toMatchObject({ format: 'bgra8', width: 4, height: 4, cube: false });
    expect(img.faces).toHaveLength(1);
    expect(img.faces[0]).toHaveLength(1);
    const level = img.faces[0][0];
    expect(level).toMatchObject({ width: 4, height: 4 });
    expect(level.data).toBeInstanceOf(Uint8Array);
    expect(level.data).toHaveLength(64);
    expect([...level.data.subarray(0, 4)]).toEqual([10, 11, 12, 13]);
  });

  it('マスクで書かれた 8 ビットの形式', () => {
    const read = (format: 'X8R8G8B8' | 'A8B8G8R8' | 'R8G8' | 'L8' | 'A8L8') => parseDds(buildDds({ format, width: 4, height: 2, fill: first(1) }));
    expect(read('X8R8G8B8')).toMatchObject({ format: 'bgrx8' });
    expect(read('A8B8G8R8')).toMatchObject({ format: 'rgba8' });
    expect(read('R8G8')).toMatchObject({ format: 'rg8' });
    expect(read('A8L8')).toMatchObject({ format: 'rg8' });
    expect(read('L8')).toMatchObject({ format: 'r8' });
    expect(read('L8').faces[0][0].data).toHaveLength(8);
    expect(read('R8G8').faces[0][0].data).toHaveLength(16);
  });

  it('A16B16G16R16F (FourCC 113) は rgba16f で、半精度の値のまま Uint16Array', () => {
    const payload = bytesOf(new Uint16Array(4 * 4 * 4).map((_, i) => 0x3c00 + i)); // 0x3c00 = 半精度の 1.0
    const img = parseDds(buildDds({ format: 'A16B16G16R16F', width: 4, height: 4, payload }));
    expect(img.format).toBe('rgba16f');
    const d = img.faces[0][0].data;
    expect(d).toBeInstanceOf(Uint16Array);
    expect(d).toHaveLength(64);
    expect([...d.subarray(0, 3)]).toEqual([0x3c00, 0x3c01, 0x3c02]);
  });

  it('R32F (FourCC 114) は r32f の Float32Array', () => {
    const img = parseDds(buildDds({ format: 'R32F', width: 4, height: 4, payload: bytesOf(new Float32Array(16).map((_, i) => 1.5 + i)) }));
    expect(img.format).toBe('r32f');
    const d = img.faces[0][0].data;
    expect(d).toBeInstanceOf(Float32Array);
    expect(d).toHaveLength(16);
    expect([...d.subarray(0, 2)]).toEqual([1.5, 2.5]);
  });

  it('そのほかの FourCC の D3DFMT', () => {
    const f = (format: 'A16B16G16R16' | 'R16F' | 'G16R16F' | 'G32R32F' | 'A32B32G32R32F') => parseDds(buildDds({ format, width: 2, height: 2 }));
    expect(f('A16B16G16R16')).toMatchObject({ format: 'rgba16' });
    expect(f('A16B16G16R16').faces[0][0].data).toBeInstanceOf(Uint16Array);
    expect(f('R16F')).toMatchObject({ format: 'r16f' });
    expect(f('G16R16F')).toMatchObject({ format: 'rg16f' });
    expect(f('G32R32F')).toMatchObject({ format: 'rg32f' });
    expect(f('A32B32G32R32F')).toMatchObject({ format: 'rgba32f' });
    expect(f('A32B32G32R32F').faces[0][0].data).toHaveLength(16);
  });

  it('DX10 の拡張ヘッダー (R16G16B16A16_FLOAT) は rgba16f', () => {
    const payload = bytesOf(new Uint16Array(4 * 4 * 4).map((_, i) => 0x4000 + i));
    const img = parseDds(buildDds({ format: { dxgi: 10, bytes: 8 }, width: 4, height: 4, payload }));
    expect(img.format).toBe('rgba16f');
    expect(img.faces[0][0].data).toHaveLength(64);
    expect(img.faces[0][0].data[0]).toBe(0x4000);
  });

  it('DX10 のほかの DXGI_FORMAT', () => {
    const dx = (dxgi: number, bytes: number, block = false) => parseDds(buildDds({ format: { dxgi, bytes, block }, width: 4, height: 4 })).format;
    expect([
      dx(2, 16), dx(11, 8), dx(16, 8), dx(34, 4), dx(41, 4), dx(54, 2),
      dx(28, 4), dx(29, 4), dx(49, 2), dx(61, 1), dx(87, 4), dx(91, 4), dx(88, 4),
      dx(71, 8, true), dx(74, 16, true), dx(77, 16, true),
    ]).toEqual([
      'rgba32f', 'rgba16', 'rg32f', 'rg16f', 'r32f', 'r16f',
      'rgba8', 'rgba8', 'rg8', 'r8', 'bgra8', 'bgra8', 'bgrx8',
      'dxt1', 'dxt3', 'dxt5',
    ]);
  });

  it('DXT1・DXT3・DXT5 は 4×4 のブロックごと (4 の倍数でない大きさは切り上げ)', () => {
    const dxt1 = parseDds(buildDds({ format: 'DXT1', width: 4, height: 4, fill: first(7) }));
    expect(dxt1.format).toBe('dxt1');
    expect(dxt1.faces[0][0].data).toHaveLength(8);
    expect(dxt1.faces[0][0].data[0]).toBe(7);
    expect(parseDds(buildDds({ format: 'DXT1', width: 8, height: 8 })).faces[0][0].data).toHaveLength(32);
    expect(parseDds(buildDds({ format: 'DXT1', width: 2, height: 2 })).faces[0][0].data).toHaveLength(8);
    expect(parseDds(buildDds({ format: 'DXT3', width: 8, height: 4 })).faces[0][0].data).toHaveLength(32);
    const dxt5 = parseDds(buildDds({ format: 'DXT5', width: 5, height: 5 }));
    expect(dxt5.format).toBe('dxt5');
    expect(dxt5.faces[0][0].data).toHaveLength(64);
  });

  it('ミップ 3 段は、段ごとの大きさと、続けて並ぶ画素', () => {
    const img = parseDds(buildDds({ format: 'A8R8G8B8', width: 4, height: 4, mips: 3, fill: i => i }));
    const levels = img.faces[0];
    expect(levels.map(l => [l.width, l.height, l.data.length])).toEqual([[4, 4, 64], [2, 2, 16], [1, 1, 4]]);
    expect(levels.map(l => l.data[0])).toEqual([0, 64, 80]);
  });

  it('長方形のミップは、片方が 1 になったあとも 1 で続く', () => {
    const img = parseDds(buildDds({ format: 'L8', width: 4, height: 1, mips: 3 }));
    expect(img.faces[0].map(l => [l.width, l.height])).toEqual([[4, 1], [2, 1], [1, 1]]);
  });

  it('キューブは 6 面 (+X,-X,+Y,-Y,+Z,-Z の順) × ミップ', () => {
    const img = parseDds(buildDds({ format: 'A8R8G8B8', width: 2, height: 2, mips: 2, cube: true, fill: i => i }));
    expect(img.cube).toBe(true);
    expect(img.faces).toHaveLength(6);
    // 1 面 = 16 + 4 バイト
    expect(img.faces.map(f => f.map(l => [l.width, l.data[0]]))).toEqual([0, 1, 2, 3, 4, 5].map(k => [[2, k * 20], [1, k * 20 + 16]]));
  });

  it('DX10 のキューブ', () => {
    const img = parseDds(buildDds({ format: { dxgi: 28, bytes: 4 }, width: 2, height: 2, cube: true, fill: i => i }));
    expect(img.cube).toBe(true);
    expect(img.format).toBe('rgba8');
    expect(img.faces.map(f => f[0].data[0])).toEqual([0, 16, 32, 48, 64, 80]);
  });

  it('返す data は元のバイト列と別のコピー (位置がそろっていなくても読める)', () => {
    const dds = buildDds({ format: 'R32F', width: 2, height: 2, payload: bytesOf(new Float32Array([1, 2, 3, 4])) });
    const shifted = new Uint8Array(dds.length + 1);
    shifted.set(dds, 1);
    const img = parseDds(shifted.subarray(1));
    expect([...img.faces[0][0].data]).toEqual([1, 2, 3, 4]);
    shifted.fill(0);
    expect([...img.faces[0][0].data]).toEqual([1, 2, 3, 4]);
  });

  it('ボリュームテクスチャ・配列・読めない形式・壊れたファイルは Error', () => {
    expect(() => parseDds(buildDds({ format: 'A8R8G8B8', width: 4, height: 4, volume: true }))).toThrow();
    expect(() => parseDds(buildDds({ format: { dxgi: 28, bytes: 4 }, width: 4, height: 4, volume: true }))).toThrow();
    expect(() => parseDds(buildDds({ format: { dxgi: 28, bytes: 4 }, width: 4, height: 4, arraySize: 2 }))).toThrow();
    expect(() => parseDds(buildDds({ format: { fourCC: 'ATI2', bytes: 16, block: true }, width: 4, height: 4 }))).toThrow(/ATI2/);
    expect(() => parseDds(buildDds({ format: { dxgi: 1, bytes: 16 }, width: 4, height: 4 }))).toThrow(/DXGI_1/);
    expect(() => parseDds(buildDds({ format: { fourCC: 117, bytes: 4 }, width: 4, height: 4 }))).toThrow(/D3DFMT_117/);
    expect(() => parseDds(new Uint8Array([0x44, 0x44]))).toThrow();
    expect(() => parseDds(new Uint8Array(0))).toThrow();
    expect(() => parseDds(new Uint8Array(200))).toThrow(); // 'DDS ' で始まらない
    const ok = buildDds({ format: 'A8R8G8B8', width: 4, height: 4 });
    expect(() => parseDds(ok.subarray(0, 100))).toThrow(); // ヘッダーが途中
    expect(() => parseDds(ok.subarray(0, ok.length - 1))).toThrow(); // 画素が足りない
    const bad = ok.slice();
    bad[4] = 0; // ヘッダーの大きさが 124 でない
    expect(() => parseDds(bad)).toThrow();
    const mips = ok.slice();
    mips[28] = 0xff; // ミップの段が 1×1 になるまでの数 (4×4 なら 3) を超える
    expect(() => parseDds(mips)).toThrow();
    const zero = ok.slice();
    zero[16] = 0; // 幅 0
    expect(() => parseDds(zero)).toThrow();
  });

  it('キューブの面が 6 つそろっていなければ Error', () => {
    const cube = buildDds({ format: 'A8R8G8B8', width: 2, height: 2, cube: true });
    cube[113] = 0xe; // caps2 の面を +X・-X だけにする (0xfe00 → 0x0e00)
    expect(() => parseDds(cube)).toThrow();
  });

  it('Error の文は画面の言語で出す', () => {
    addDictionary('en', en);
    setLang('en');
    try {
      expect(() => parseDds(new Uint8Array(0))).toThrow('Not a DDS file');
    } finally {
      setLang('ja');
    }
  });
});

describe('ddsHeader', () => {
  it('形式・大きさ・ミップ・キューブ・ボリューム', () => {
    expect(ddsHeader(buildDds({ format: 'A16B16G16R16F', width: 8, height: 4, mips: 4 })))
      .toEqual({ format: 'rgba16f', width: 8, height: 4, mips: 4, cube: false, volume: false });
    expect(ddsHeader(buildDds({ format: 'DXT5', width: 4, height: 4, cube: true })))
      .toEqual({ format: 'dxt5', width: 4, height: 4, mips: 1, cube: true, volume: false });
    expect(ddsHeader(buildDds({ format: { dxgi: 10, bytes: 8 }, width: 2, height: 2, cube: true })))
      .toMatchObject({ format: 'rgba16f', cube: true });
  });

  it('読めない形式は FourCC か番号の文字で返す (Error にしない)', () => {
    expect(ddsHeader(buildDds({ format: { fourCC: 'ATI2', bytes: 16, block: true }, width: 4, height: 4 })).format).toBe('ATI2');
    expect(ddsHeader(buildDds({ format: { fourCC: 117, bytes: 4 }, width: 4, height: 4 })).format).toBe('D3DFMT_117');
    expect(ddsHeader(buildDds({ format: { dxgi: 1, bytes: 16 }, width: 4, height: 4 })).format).toBe('DXGI_1');
  });

  it('ボリュームは volume: true (Error にしない)', () => {
    expect(ddsHeader(buildDds({ format: 'A8R8G8B8', width: 4, height: 4, volume: true }))).toMatchObject({ volume: true });
    expect(ddsHeader(buildDds({ format: { dxgi: 28, bytes: 4 }, width: 4, height: 4, volume: true }))).toMatchObject({ volume: true });
  });

  it('DDS でないファイルは Error', () => {
    expect(() => ddsHeader(new Uint8Array(0))).toThrow();
    expect(() => ddsHeader(new Uint8Array(200))).toThrow();
  });
});
