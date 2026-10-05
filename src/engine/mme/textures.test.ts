import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { addDictionary, setLang } from '../../core/i18n.ts';
import en from '../../i18n/en.ts';
import { buildDds, levelBytes, type DdsFormatName } from '../../core/testing/dds.ts';
import { cloneTexture, decodeTexture } from './textures.ts';

const bytesOf = (a: Float32Array | Uint16Array) => new Uint8Array(a.buffer);
const seq = (n: number) => (i: number) => i + n; // 先頭が n で、1 ずつ増えるバイト
const half = (v: number) => THREE.DataUtils.fromHalfFloat(v);
const common = (t: THREE.Texture) => expect(t).toMatchObject({ flipY: false, colorSpace: THREE.NoColorSpace });
const dataOf = (t: THREE.Texture) => Array.from((t as THREE.DataTexture).image.data as ArrayLike<number>);
type Mip = { data: Uint8Array | Uint16Array; width: number; height: number };
const mipsOf = (t: THREE.Texture) => t.mipmaps as unknown as Mip[];

describe('decodeTexture: DDS (自前の parseDds)', () => {
  it('A16B16G16R16F の 2D は HalfFloatType の DataTexture で、ミップは mipmaps に並ぶ', async () => {
    const payload = bytesOf(new Uint16Array((4 * 2 + 2 * 1 + 1 * 1) * 4).map((_, i) => 0x3c00 + i));
    const t = await decodeTexture(buildDds({ format: 'A16B16G16R16F', width: 4, height: 2, mips: 3, payload }), 'a.DDS') as THREE.DataTexture;
    expect(t).toBeInstanceOf(THREE.DataTexture);
    expect(t).toMatchObject({ format: THREE.RGBAFormat, type: THREE.HalfFloatType, generateMipmaps: false });
    expect(t.image).toMatchObject({ width: 4, height: 2 });
    expect(t.image.data).toBeInstanceOf(Uint16Array);
    expect(mipsOf(t).map(m => [m.width, m.height])).toEqual([[4, 2], [2, 1], [1, 1]]);
    expect(mipsOf(t).map(m => m.data.length)).toEqual([32, 8, 4]);
    expect(mipsOf(t)[0].data).toBe(t.image.data);
    expect(half(mipsOf(t)[1].data[0])).toBe(half(0x3c00 + 32));
    common(t);
    expect(t.version).toBeGreaterThan(0);
  });

  it('ミップが 1 段なら mipmaps は空', async () => {
    const t = await decodeTexture(buildDds({ format: 'A16B16G16R16F', width: 2, height: 2 }), 'a.dds') as THREE.DataTexture;
    expect(t.mipmaps).toEqual([]);
  });

  it('A16B16G16R16F のキューブは、6 面の DataTexture を持つ CubeTexture (ミップは 2 段目から)', async () => {
    const perFace = (4 * 4 + 2 * 2) * 4; // 画素数 (ミップ 2 段)
    const payload = bytesOf(new Uint16Array(perFace * 6).map((_, i) => Math.floor(i / perFace) * 0x100 + (i % perFace)));
    const t = await decodeTexture(buildDds({ format: 'A16B16G16R16F', width: 4, height: 4, mips: 2, cube: true, payload }), 'sky.dds') as THREE.CubeTexture;
    expect(t).toBeInstanceOf(THREE.CubeTexture);
    expect(t.isCubeTexture).toBe(true);
    expect(t).toMatchObject({ format: THREE.RGBAFormat, type: THREE.HalfFloatType, generateMipmaps: false });
    expect(t.image).toHaveLength(6);
    (t.image as THREE.DataTexture[]).forEach((face, f) => {
      expect(face).toBeInstanceOf(THREE.DataTexture);
      expect(face.image).toMatchObject({ width: 4, height: 4 });
      expect(face.image.data).toBeInstanceOf(Uint16Array);
      expect((face.image.data as Uint16Array)[0]).toBe(f * 0x100); // 面ごとの先頭 (+X,-X,+Y,-Y,+Z,-Z の順)
    });
    // three.js の決まり: 無圧縮のキューブの mipmaps は 2 段目から、各段は 6 面の DataTexture を image に持つ
    expect(t.mipmaps).toHaveLength(1);
    const level1 = (t.mipmaps[0] as unknown as { image: THREE.DataTexture[] }).image;
    expect(level1).toHaveLength(6);
    level1.forEach((face, f) => {
      expect(face.image).toMatchObject({ width: 2, height: 2 });
      expect((face.image.data as Uint16Array)[0]).toBe(f * 0x100 + 16 * 4);
    });
    common(t);
  });

  it('32 ビット浮動小数点は FloatType (Float32Array)、チャンネル数は Red・RG・RGBA', async () => {
    const f32 = (n: number) => bytesOf(new Float32Array(n).map((_, i) => 1.5 + i));
    const rgba = await decodeTexture(buildDds({ format: 'A32B32G32R32F', width: 2, height: 1, payload: f32(8) }), 'a.dds') as THREE.DataTexture;
    expect(rgba).toMatchObject({ format: THREE.RGBAFormat, type: THREE.FloatType });
    expect(rgba.image.data).toBeInstanceOf(Float32Array);
    expect(dataOf(rgba)).toEqual([1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5]);
    const rg = await decodeTexture(buildDds({ format: 'G32R32F', width: 2, height: 1, payload: f32(4) }), 'a.dds') as THREE.DataTexture;
    expect(rg).toMatchObject({ format: THREE.RGFormat, type: THREE.FloatType });
    const r = await decodeTexture(buildDds({ format: 'R32F', width: 2, height: 1, payload: f32(2) }), 'a.dds') as THREE.DataTexture;
    expect(r).toMatchObject({ format: THREE.RedFormat, type: THREE.FloatType });
    expect(dataOf(r)).toEqual([1.5, 2.5]);
    for (const t of [rgba, rg, r]) common(t);
  });

  it('16 ビット浮動小数点の 1・2 チャンネルは RedFormat・RGFormat の HalfFloatType', async () => {
    const r = await decodeTexture(buildDds({ format: 'R16F', width: 2, height: 1, payload: bytesOf(new Uint16Array([0x3c00, 0x4000])) }), 'a.dds') as THREE.DataTexture;
    expect(r).toMatchObject({ format: THREE.RedFormat, type: THREE.HalfFloatType });
    expect(dataOf(r)).toEqual([0x3c00, 0x4000]);
    const rg = await decodeTexture(buildDds({ format: 'G16R16F', width: 1, height: 1, payload: bytesOf(new Uint16Array([0x3c00, 0x4000])) }), 'a.dds') as THREE.DataTexture;
    expect(rg).toMatchObject({ format: THREE.RGFormat, type: THREE.HalfFloatType });
  });

  it('A16B16G16R16 (16 ビット整数) は半精度に直す (0 → 0、65535 → 1)', async () => {
    const payload = bytesOf(new Uint16Array([0, 65535, 32768, 65535]));
    const t = await decodeTexture(buildDds({ format: 'A16B16G16R16', width: 1, height: 1, payload }), 'a.dds') as THREE.DataTexture;
    expect(t).toMatchObject({ format: THREE.RGBAFormat, type: THREE.HalfFloatType });
    expect(t.image.data).toBeInstanceOf(Uint16Array);
    const v = dataOf(t).map(half);
    expect(v[0]).toBe(0);
    expect(v[1]).toBe(1);
    expect(v[2]).toBeCloseTo(0.5, 3);
    expect(v[3]).toBe(1);
  });

  it('8 ビットの BGRA は RGBA に並べ替える (B,G,R,A → R,G,B,A)。X8R8G8B8 の A は 255', async () => {
    const bgra = await decodeTexture(buildDds({ format: 'A8R8G8B8', width: 2, height: 1, payload: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) }), 'a.dds') as THREE.DataTexture;
    expect(bgra).toMatchObject({ format: THREE.RGBAFormat, type: THREE.UnsignedByteType });
    expect(dataOf(bgra)).toEqual([3, 2, 1, 4, 7, 6, 5, 8]);
    const bgrx = await decodeTexture(buildDds({ format: 'X8R8G8B8', width: 1, height: 1, payload: new Uint8Array([1, 2, 3, 0]) }), 'a.dds') as THREE.DataTexture;
    expect(dataOf(bgrx)).toEqual([3, 2, 1, 255]);
    const rgba = await decodeTexture(buildDds({ format: 'A8B8G8R8', width: 1, height: 1, payload: new Uint8Array([1, 2, 3, 4]) }), 'a.dds') as THREE.DataTexture;
    expect(dataOf(rgba)).toEqual([1, 2, 3, 4]);
    for (const t of [bgra, bgrx, rgba]) common(t);
  });

  it('8 ビットの BGRA のミップ・キューブも全部並べ替える。元の DDS のバイト列は変えない', async () => {
    const src = buildDds({ format: 'A8R8G8B8', width: 2, height: 2, mips: 2, cube: true, fill: seq(0) });
    const before = src.slice();
    const t = await decodeTexture(src, 'a.dds') as THREE.CubeTexture;
    expect(src).toEqual(before);
    const face0 = (t.image[0] as THREE.DataTexture).image.data as Uint8Array;
    expect([...face0.subarray(0, 4)]).toEqual([2, 1, 0, 3]);
    const l1 = (t.mipmaps[0] as unknown as { image: THREE.DataTexture[] }).image[0].image.data as Uint8Array;
    expect([...l1]).toEqual([18, 17, 16, 19]); // 2×2 の 16 バイトのあとの 1×1
  });

  it('8 ビットの 1・2 チャンネルは RedFormat・RGFormat', async () => {
    const r = await decodeTexture(buildDds({ format: 'L8', width: 3, height: 1, payload: new Uint8Array([9, 8, 7]) }), 'a.dds') as THREE.DataTexture;
    expect(r).toMatchObject({ format: THREE.RedFormat, type: THREE.UnsignedByteType });
    expect(dataOf(r)).toEqual([9, 8, 7]);
    const rg = await decodeTexture(buildDds({ format: 'R8G8', width: 1, height: 1, payload: new Uint8Array([9, 8]) }), 'a.dds') as THREE.DataTexture;
    expect(rg).toMatchObject({ format: THREE.RGFormat, type: THREE.UnsignedByteType });
  });

  it.each([['DXT1', THREE.RGBA_S3TC_DXT1_Format], ['DXT3', THREE.RGBA_S3TC_DXT3_Format], ['DXT5', THREE.RGBA_S3TC_DXT5_Format]] as [DdsFormatName, THREE.CompressedPixelFormat][])(
    '%s は CompressedTexture で、ミップは mipmaps にそのまま', async (format, three) => {
      const t = await decodeTexture(buildDds({ format, width: 8, height: 4, mips: 4, fill: seq(0) }), 'a.dds', () => true) as THREE.CompressedTexture;
      expect(t).toBeInstanceOf(THREE.CompressedTexture);
      expect(t.format).toBe(three);
      expect(t.image).toMatchObject({ width: 8, height: 4 });
      expect(mipsOf(t).map(m => [m.width, m.height])).toEqual([[8, 4], [4, 2], [2, 1], [1, 1]]);
      const block = format === 'DXT1' ? 8 : 16;
      expect(mipsOf(t).map(m => m.data.length)).toEqual([2 * block, block, block, block]);
      expect(mipsOf(t)[1].data[0]).toBe((2 * block) & 0xff);
      common(t);
    });

  it('DXT のキューブは CompressedCubeTexture (面ごとの mipmaps)', async () => {
    const t = await decodeTexture(buildDds({ format: 'DXT5', width: 4, height: 4, mips: 3, cube: true, fill: seq(0) }), 'sky.dds', () => true) as THREE.CompressedCubeTexture;
    expect(t).toBeInstanceOf(THREE.CompressedCubeTexture);
    expect(t.isCubeTexture).toBe(true);
    expect(t.format).toBe(THREE.RGBA_S3TC_DXT5_Format);
    const faces = t.image as unknown as { mipmaps: { width: number; height: number; data: Uint8Array }[]; width: number; height: number }[];
    expect(faces).toHaveLength(6);
    const perFace = levelBytes(4, 4, 16, true) + levelBytes(2, 2, 16, true) + levelBytes(1, 1, 16, true);
    faces.forEach((f, i) => {
      expect(f).toMatchObject({ width: 4, height: 4 });
      expect(f.mipmaps.map(m => m.width)).toEqual([4, 2, 1]);
      expect(f.mipmaps[0].data[0]).toBe((i * perFace) & 0xff);
    });
    common(t);
  });

  it('S3TC に対応していない GPU では、DXT は読めないものとして Error (警告に出る)。DXT 以外は読める', async () => {
    addDictionary('en', en);
    setLang('en');
    try {
      await expect(decodeTexture(buildDds({ format: 'DXT1', width: 4, height: 4 }), 'a.dds', () => false)).rejects.toThrow(/S3TC/);
      const t = await decodeTexture(buildDds({ format: 'A8R8G8B8', width: 1, height: 1 }), 'a.dds', () => false);
      expect(t).toBeInstanceOf(THREE.DataTexture);
    } finally {
      setLang('ja');
    }
  });

  it('壊れた DDS は parseDds の Error', async () => {
    await expect(decodeTexture(new Uint8Array(128), 'x.dds')).rejects.toThrow(/DDS/);
  });
});

describe('decodeTexture: .hdr・.tga・ブラウザの形式', () => {
  const ascii = (s: string) => Uint8Array.from(s, c => c.charCodeAt(0));
  const hdr = (w: number, h: number, pixels: number[]) =>
    new Uint8Array([...ascii(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${h} +X ${w}\n`), ...pixels]);

  it('.hdr は HalfFloatType の RGBA の DataTexture (上の行が先)', async () => {
    // RGBE: 仮数 255 / 指数 128 → 1.0。2 番目は 0
    const t = await decodeTexture(hdr(2, 1, [255, 0, 0, 128, 0, 255, 0, 128]), 'sky.HDR') as THREE.DataTexture;
    expect(t).toBeInstanceOf(THREE.DataTexture);
    expect(t).toMatchObject({ format: THREE.RGBAFormat, type: THREE.HalfFloatType });
    expect(t.image).toMatchObject({ width: 2, height: 1 });
    expect(t.image.data).toBeInstanceOf(Uint16Array);
    expect(dataOf(t).map(half)).toEqual([1, 0, 0, 1, 0, 1, 0, 1]);
    common(t);
    // 縦: ファイルの 1 行目が data の先頭 (v = 0 が上)
    const v = await decodeTexture(hdr(1, 2, [255, 0, 0, 128, 0, 0, 255, 128]), 'a.hdr') as THREE.DataTexture;
    expect(dataOf(v).map(half)).toEqual([1, 0, 0, 1, 0, 0, 1, 1]);
  });

  it('.tga は 2×1 の無圧縮を RGBA の DataTexture に', async () => {
    // 32 ビット・左下が原点 (画素は BGRA: 赤、青)
    const tga = new Uint8Array([0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 1, 0, 32, 0x08, 0, 0, 255, 255, 255, 0, 0, 255]);
    const t = await decodeTexture(tga, 'a.tga') as THREE.DataTexture;
    expect(t).toBeInstanceOf(THREE.DataTexture);
    expect(t.image).toMatchObject({ width: 2, height: 1 });
    expect(dataOf(t)).toEqual([255, 0, 0, 255, 0, 0, 255, 255]);
    common(t);
  });

  it('.tga は上下を返さない (1 行目が画像の上の行。D3D と同じく v = 0 が上)', async () => {
    // 1×2・32 ビット・左下が原点の TGA (画素は BGRA。ファイルでは下の行 (青) が先)
    const tga = new Uint8Array([0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 2, 0, 32, 0x08, 255, 0, 0, 255, 0, 0, 255, 255]);
    const t = await decodeTexture(tga, 'tex/a.TGA') as THREE.DataTexture;
    expect(t.image).toMatchObject({ width: 1, height: 2 });
    expect(dataOf(t)).toEqual([255, 0, 0, 255, 0, 0, 255, 255]);
    common(t);
  });

  it('.bmp・.png などはブラウザの createImageBitmap で読み、テクスチャを捨てると close する', async () => {
    const close = vi.fn();
    const create = vi.fn(async () => ({ width: 1, height: 1, close }));
    vi.stubGlobal('createImageBitmap', create);
    try {
      const png = await decodeTexture(new Uint8Array([1, 2, 3]), 'a.PNG');
      const bmp = await decodeTexture(new Uint8Array([1, 2, 3]), 'a.bmp');
      expect(create).toHaveBeenCalledTimes(2);
      expect((create.mock.calls[1] as unknown as [Blob])[0].type).toBe('image/bmp');
      expect(bmp.isTexture).toBe(true);
      common(png);
      common(bmp);
      expect(close).not.toHaveBeenCalled();
      png.dispose();
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('知らない拡張子は Error', async () => {
    await expect(decodeTexture(new Uint8Array(4), 'a.xyz')).rejects.toThrow('xyz');
  });
});

describe('cloneTexture', () => {
  it('Texture の種類ごとに source を共有した写しを作る (圧縮したキューブマップ・DDS の無圧縮キューブも)', async () => {
    const mip = { data: new Uint8Array(8), width: 4, height: 4 };
    const faces = Array.from({ length: 6 }, () => ({ mipmaps: [mip], width: 4, height: 4 }));
    const cube = await decodeTexture(buildDds({ format: 'A16B16G16R16F', width: 2, height: 2, mips: 2, cube: true }), 'a.dds');
    const flat = await decodeTexture(buildDds({ format: 'A16B16G16R16F', width: 2, height: 2, mips: 2 }), 'a.dds');
    const list: THREE.Texture[] = [
      new THREE.DataTexture(new Uint8Array(4), 1, 1),
      new THREE.CompressedTexture([mip], 4, 4, THREE.RGBA_S3TC_DXT1_Format),
      new THREE.CompressedCubeTexture(faces as unknown as THREE.CompressedTextureImageData[], THREE.RGBA_S3TC_DXT1_Format),
      new THREE.CubeTexture([]),
      new THREE.Data3DTexture(new Uint8Array(4), 1, 1, 1),
      cube,
      flat,
    ];
    for (const t of list) {
      const c = cloneTexture(t);
      expect(c.constructor, t.constructor.name).toBe(t.constructor);
      expect(c.source).toBe(t.source);
      expect(c).not.toBe(t);
    }
    // ミップも写る
    expect(cloneTexture(cube).mipmaps).toHaveLength(1);
    expect(cloneTexture(flat).mipmaps).toHaveLength(2);
  });
});
