// DDS (DirectDraw Surface) の読み込み。画素のバイト列を、形式ごとの型付き配列にして面・ミップの段ごとに返す (GL は使わない)。
// 読める形式: マスクで書かれた 8 ビット系、FourCC の D3DFMT (浮動小数・16 ビット)、DXT1/3/5、DX10 の拡張ヘッダー (DXGI_FORMAT)。
// 画素の並び (バイトの順) は形式の名前のとおり: bgra8 は B,G,R,A の順、rgba8 は R,G,B,A の順 (swizzle は使う側)
import { t } from '../i18n.ts';

export type DdsFormat =
  | 'rgba8' | 'bgra8' | 'bgrx8' | 'rg8' | 'r8'
  | 'rgba16f' | 'rgba32f' | 'rg16f' | 'rg32f' | 'r16f' | 'r32f' | 'rgba16'
  | 'dxt1' | 'dxt3' | 'dxt5';

// data: 半精度 (…16f) と rgba16 は Uint16Array (半精度は生のビットのまま)、…32f は Float32Array、それ以外は Uint8Array
export interface DdsLevel { width: number; height: number; data: Uint8Array | Uint16Array | Float32Array }
// faces: 面ごと (キューブは +X,-X,+Y,-Y,+Z,-Z)、その中がミップの段ごと (大 → 小)
export interface DdsImage { format: DdsFormat; width: number; height: number; cube: boolean; faces: DdsLevel[][] }
export interface DdsInfo { format: DdsFormat | string; width: number; height: number; mips: number; cube: boolean; volume: boolean }

const MAGIC = 0x20534444; // 'DDS '
const HEADER = 128; // 'DDS ' + DDS_HEADER (124)
const DX10_HEADER = 20;
const DDPF_FOURCC = 0x4;
const DDPF_RGB = 0x40;
const DDPF_LUMINANCE = 0x20000;
const CAPS2_CUBEMAP = 0x200;
const CAPS2_CUBEMAP_ALL_FACES = 0xfc00;
const CAPS2_VOLUME = 0x200000;
const FLAG_DEPTH = 0x800000;
const DX10_DIMENSION_3D = 4;
const DX10_MISC_CUBE = 0x4;

interface Layout { bytes: number; block?: boolean; array: 'u8' | 'u16' | 'f32' } // bytes: 1 画素 (ブロック圧縮は 1 ブロック) のバイト数
const LAYOUTS: Record<DdsFormat, Layout> = {
  rgba8: { bytes: 4, array: 'u8' }, bgra8: { bytes: 4, array: 'u8' }, bgrx8: { bytes: 4, array: 'u8' },
  rg8: { bytes: 2, array: 'u8' }, r8: { bytes: 1, array: 'u8' },
  rgba16f: { bytes: 8, array: 'u16' }, rgba32f: { bytes: 16, array: 'f32' }, rg16f: { bytes: 4, array: 'u16' }, rg32f: { bytes: 8, array: 'f32' },
  r16f: { bytes: 2, array: 'u16' }, r32f: { bytes: 4, array: 'f32' }, rgba16: { bytes: 8, array: 'u16' },
  dxt1: { bytes: 8, block: true, array: 'u8' }, dxt3: { bytes: 16, block: true, array: 'u8' }, dxt5: { bytes: 16, block: true, array: 'u8' },
};

const FOURCC_NAMES: Record<string, DdsFormat> = { DXT1: 'dxt1', DXT3: 'dxt3', DXT5: 'dxt5' };
// FourCC の欄に D3DFMT の番号が入る形式
const D3DFMT: Record<number, DdsFormat> = { 36: 'rgba16', 111: 'r16f', 112: 'rg16f', 113: 'rgba16f', 114: 'r32f', 115: 'rg32f', 116: 'rgba32f' };
const DXGI: Record<number, DdsFormat> = {
  2: 'rgba32f', 10: 'rgba16f', 11: 'rgba16', 16: 'rg32f', 34: 'rg16f', 41: 'r32f', 54: 'r16f',
  28: 'rgba8', 29: 'rgba8', 49: 'rg8', 61: 'r8', 87: 'bgra8', 91: 'bgra8', 88: 'bgrx8', 93: 'bgrx8',
  71: 'dxt1', 72: 'dxt1', 74: 'dxt3', 75: 'dxt3', 77: 'dxt5', 78: 'dxt5',
};

function headerView(bytes: Uint8Array): DataView {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 4 || v.getUint32(0, true) !== MAGIC) throw new Error(t('DDS のファイルではありません'));
  if (bytes.length < HEADER || v.getUint32(4, true) !== 124 || v.getUint32(76, true) !== 32) throw new Error(t('DDS のヘッダーが壊れています'));
  return v;
}

const hex = (n: number) => `0x${(n >>> 0).toString(16)}`;

interface Parsed { info: DdsInfo; format: DdsFormat | null; dataStart: number; arraySize: number }

function parseHeader(bytes: Uint8Array): Parsed {
  const v = headerView(bytes);
  const flags = v.getUint32(8, true);
  const height = v.getUint32(12, true);
  const width = v.getUint32(16, true);
  const depth = v.getUint32(24, true);
  const mips = Math.max(1, v.getUint32(28, true));
  const pfFlags = v.getUint32(80, true);
  const fourCC = v.getUint32(84, true);
  const bits = v.getUint32(88, true);
  const masks = [v.getUint32(92, true), v.getUint32(96, true), v.getUint32(100, true), v.getUint32(104, true)];
  const caps2 = v.getUint32(112, true);
  let cube = (caps2 & CAPS2_CUBEMAP) !== 0;
  let volume = (caps2 & CAPS2_VOLUME) !== 0 || ((flags & FLAG_DEPTH) !== 0 && depth > 1);
  if (cube && (caps2 & CAPS2_CUBEMAP_ALL_FACES) !== CAPS2_CUBEMAP_ALL_FACES) throw new Error(t('キューブマップの DDS に 6 面がそろっていません'));

  let format: DdsFormat | null = null;
  let name = '';
  let dataStart = HEADER;
  let arraySize = 1;
  if (pfFlags & DDPF_FOURCC) {
    const text = String.fromCharCode(fourCC & 0xff, (fourCC >> 8) & 0xff, (fourCC >> 16) & 0xff, (fourCC >>> 24) & 0xff);
    if (text === 'DX10') {
      if (bytes.length < HEADER + DX10_HEADER) throw new Error(t('DDS のヘッダーが壊れています'));
      const dxgi = v.getUint32(HEADER, true);
      if (v.getUint32(HEADER + 4, true) === DX10_DIMENSION_3D) volume = true;
      cube = (v.getUint32(HEADER + 8, true) & DX10_MISC_CUBE) !== 0;
      arraySize = Math.max(1, v.getUint32(HEADER + 12, true));
      dataStart = HEADER + DX10_HEADER;
      format = DXGI[dxgi] ?? null;
      name = `DXGI_${dxgi}`;
    } else if (/^[\x20-\x7e]{4}$/.test(text)) {
      format = FOURCC_NAMES[text] ?? null;
      name = text;
    } else {
      format = D3DFMT[fourCC] ?? null;
      name = `D3DFMT_${fourCC}`;
    }
  } else {
    // マスクで書かれた形式 (R,G,B,A のビットの位置)
    const is = (m: number[]) => masks.every((x, i) => x === m[i]);
    if ((pfFlags & DDPF_RGB) && bits === 32) {
      if (is([0xff0000, 0xff00, 0xff, 0xff000000])) format = 'bgra8';
      else if (is([0xff0000, 0xff00, 0xff, 0])) format = 'bgrx8';
      else if (is([0xff, 0xff00, 0xff0000, 0xff000000])) format = 'rgba8';
    } else if ((pfFlags & DDPF_RGB) && bits === 16 && is([0xff, 0xff00, 0, 0])) format = 'rg8';
    else if ((pfFlags & DDPF_LUMINANCE) && bits === 8 && is([0xff, 0, 0, 0])) format = 'r8';
    else if ((pfFlags & DDPF_LUMINANCE) && bits === 16 && is([0xff, 0, 0, 0xff00])) format = 'rg8';
    name = `${(pfFlags & DDPF_LUMINANCE) ? 'L' : 'RGB'}${bits}(${masks.map(hex).join(',')})`;
  }
  return { info: { format: format ?? name, width, height, mips, cube, volume }, format, dataStart, arraySize };
}

// ヘッダーだけ読む (形式が読めなくても Error にしない。形式は FourCC・D3DFMT・DXGI の番号などの文字で返す)。DDS でなければ Error
export function ddsHeader(bytes: Uint8Array): DdsInfo {
  return parseHeader(bytes).info;
}

function levelBytes(width: number, height: number, l: Layout): number {
  return l.block ? Math.ceil(width / 4) * Math.ceil(height / 4) * l.bytes : width * height * l.bytes;
}

export function parseDds(bytes: Uint8Array): DdsImage {
  const { info, format, dataStart, arraySize } = parseHeader(bytes);
  if (info.volume) throw new Error(t('ボリュームテクスチャの DDS は読めません'));
  if (format === null) throw new Error(t('DDS の形式 {format} は読めません', { format: String(info.format) }));
  if (arraySize > 1) throw new Error(t('配列テクスチャの DDS は読めません'));
  const { width, height, mips } = info;
  // 段の数は、1 × 1 になるまでの数 (これを超えるのはヘッダーの誤り。巨大な数でループしない)
  if (width < 1 || height < 1 || mips > Math.floor(Math.log2(Math.max(width, height))) + 1) throw new Error(t('DDS のヘッダーが壊れています'));

  const layout = LAYOUTS[format];
  const dims: [number, number][] = [];
  let total = 0;
  for (let m = 0; m < mips; m++) {
    const w = Math.max(1, Math.floor(width / 2 ** m));
    const h = Math.max(1, Math.floor(height / 2 ** m));
    dims.push([w, h]);
    total += levelBytes(w, h, layout);
  }
  const faceCount = info.cube ? 6 : 1;
  // 画素の数が足りないなら、確保する前に断る (大きさだけ大きいファイルで大量に確保しない)
  if (dataStart + total * faceCount > bytes.length) throw new Error(t('DDS の画素のデータが足りません'));

  const faces: DdsLevel[][] = [];
  let at = dataStart;
  for (let f = 0; f < faceCount; f++) {
    const levels: DdsLevel[] = [];
    for (const [w, h] of dims) {
      const n = levelBytes(w, h, layout);
      // 元のバイト列と別の、位置がそろったバッファ。Buffer の slice は写さず同じ領域を見るので、Uint8Array の slice を指名する
      const copy = Uint8Array.prototype.slice.call(bytes, at, at + n) as Uint8Array;
      at += n;
      const data = layout.array === 'u8' ? copy : layout.array === 'u16' ? new Uint16Array(copy.buffer) : new Float32Array(copy.buffer);
      levels.push({ width: w, height: h, data });
    }
    faces.push(levels);
  }
  return { format, width, height, cube: info.cube, faces };
}
