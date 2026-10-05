// テスト用に、小さな DDS を組み立てる (ヘッダー 128 バイト、DX10 なら +20 バイト、そのあとに画素)。
// 画素は payload (そのまま使う) か、fill (バイトの通し番号 → 値。なければ番号の下位 8 ビット) で埋める。
// 画素の並びは DDS の決まりどおり、面 (キューブは +X..−Z) ごとに、ミップの 大 → 小

const DDPF_ALPHAPIXELS = 0x1;
const DDPF_FOURCC = 0x4;
const DDPF_RGB = 0x40;
const DDPF_LUMINANCE = 0x20000;

interface Layout { flags: number; fourCC?: string | number; bits?: number; masks?: [number, number, number, number]; bytes: number; block?: boolean }

// bytes: 1 画素 (ブロック圧縮なら 4×4 のブロック) のバイト数
export const DDS_FORMATS = {
  A8R8G8B8: { flags: DDPF_RGB | DDPF_ALPHAPIXELS, bits: 32, masks: [0xff0000, 0xff00, 0xff, 0xff000000], bytes: 4 },
  X8R8G8B8: { flags: DDPF_RGB, bits: 32, masks: [0xff0000, 0xff00, 0xff, 0], bytes: 4 },
  A8B8G8R8: { flags: DDPF_RGB | DDPF_ALPHAPIXELS, bits: 32, masks: [0xff, 0xff00, 0xff0000, 0xff000000], bytes: 4 },
  R8G8: { flags: DDPF_RGB, bits: 16, masks: [0xff, 0xff00, 0, 0], bytes: 2 },
  L8: { flags: DDPF_LUMINANCE, bits: 8, masks: [0xff, 0, 0, 0], bytes: 1 },
  A8L8: { flags: DDPF_LUMINANCE | DDPF_ALPHAPIXELS, bits: 16, masks: [0xff, 0, 0, 0xff00], bytes: 2 },
  A16B16G16R16: { flags: DDPF_FOURCC, fourCC: 36, bytes: 8 },
  R16F: { flags: DDPF_FOURCC, fourCC: 111, bytes: 2 },
  G16R16F: { flags: DDPF_FOURCC, fourCC: 112, bytes: 4 },
  A16B16G16R16F: { flags: DDPF_FOURCC, fourCC: 113, bytes: 8 },
  R32F: { flags: DDPF_FOURCC, fourCC: 114, bytes: 4 },
  G32R32F: { flags: DDPF_FOURCC, fourCC: 115, bytes: 8 },
  A32B32G32R32F: { flags: DDPF_FOURCC, fourCC: 116, bytes: 16 },
  DXT1: { flags: DDPF_FOURCC, fourCC: 'DXT1', bytes: 8, block: true },
  DXT3: { flags: DDPF_FOURCC, fourCC: 'DXT3', bytes: 16, block: true },
  DXT5: { flags: DDPF_FOURCC, fourCC: 'DXT5', bytes: 16, block: true },
} satisfies Record<string, Layout>;
export type DdsFormatName = keyof typeof DDS_FORMATS;

export interface DdsBuild {
  format: DdsFormatName | { dxgi: number; bytes: number; block?: boolean } | { fourCC: string | number; bytes: number; block?: boolean }; // dxgi は DX10 の拡張ヘッダーで書く
  width: number;
  height: number;
  mips?: number; // 段の数 (既定 1)
  cube?: boolean; // 6 面
  volume?: boolean; // ボリュームテクスチャ (読めない形式の確認用。画素はふつうの 2D と同じだけ書く)
  arraySize?: number; // DX10 の配列の数 (既定 1)
  payload?: Uint8Array;
  fill?: (index: number) => number;
}

// 1 つの段の画素のバイト数
export function levelBytes(width: number, height: number, bytes: number, block: boolean): number {
  return block ? Math.max(1, Math.ceil(width / 4)) * Math.max(1, Math.ceil(height / 4)) * bytes : width * height * bytes;
}

export function buildDds(o: DdsBuild): Uint8Array {
  const f = typeof o.format === 'string' ? DDS_FORMATS[o.format] : o.format;
  const dxgi = 'dxgi' in f ? f.dxgi : null;
  const layout = f as Partial<Layout>;
  const mips = o.mips ?? 1;
  const faces = o.cube ? 6 : 1;

  let pixels = 0;
  for (let m = 0; m < mips; m++) pixels += levelBytes(Math.max(1, o.width >> m), Math.max(1, o.height >> m), f.bytes, !!layout.block);
  pixels *= faces;
  const header = 128 + (dxgi !== null ? 20 : 0);
  const out = new Uint8Array(header + pixels);
  const view = new DataView(out.buffer);
  const u32 = (at: number, v: number) => view.setUint32(at, v >>> 0, true);

  out.set([0x44, 0x44, 0x53, 0x20]); // 'DDS '
  u32(4, 124);
  u32(8, 0x1 | 0x2 | 0x4 | 0x1000 | (mips > 1 ? 0x20000 : 0) | (o.volume ? 0x800000 : 0));
  u32(12, o.height);
  u32(16, o.width);
  u32(24, o.volume ? 2 : 0);
  u32(28, mips);
  u32(76, 32); // DDS_PIXELFORMAT
  if (dxgi !== null) {
    u32(80, DDPF_FOURCC);
    out.set([0x44, 0x58, 0x31, 0x30], 84); // 'DX10'
  } else {
    const fourCC = layout.fourCC;
    u32(80, layout.flags ?? DDPF_FOURCC);
    if (typeof fourCC === 'string') for (let i = 0; i < 4; i++) out[84 + i] = fourCC.charCodeAt(i);
    else if (fourCC !== undefined) u32(84, fourCC);
    if (layout.bits) {
      u32(88, layout.bits);
      layout.masks!.forEach((m, i) => u32(92 + i * 4, m));
    }
  }
  u32(108, 0x1000 | (mips > 1 ? 0x400008 : 0)); // DDSCAPS_TEXTURE (・COMPLEX・MIPMAP)
  u32(112, (o.cube ? 0xfe00 : 0) | (o.volume ? 0x200000 : 0));
  if (dxgi !== null) {
    u32(128, dxgi);
    u32(132, o.volume ? 4 : 3); // D3D10_RESOURCE_DIMENSION_TEXTURE3D / TEXTURE2D
    u32(136, o.cube ? 4 : 0);
    u32(140, o.arraySize ?? 1);
  }
  for (let i = 0; i < pixels; i++) out[header + i] = o.payload ? (o.payload[i] ?? 0) : (o.fill ? o.fill(i) : i) & 0xff;
  return out;
}
