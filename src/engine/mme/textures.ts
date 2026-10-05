import * as THREE from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { TGALoader } from 'three/examples/jsm/loaders/TGALoader.js';
import { t } from '../../core/i18n.ts';
import { parseDds, type DdsFormat, type DdsImage, type DdsLevel } from '../../core/mme/dds.ts';

// MME のテクスチャの決まり: 上下を返さず (flipY = false)、色空間を変えない (NoColorSpace。ガンマ空間のまま)

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', bmp: 'image/bmp', gif: 'image/gif', webp: 'image/webp' };

function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

// --- DDS ---
type PixelData = Uint8Array | Uint16Array | Float32Array;
interface Plan { format: THREE.PixelFormat; type: THREE.TextureDataType; convert?: (data: PixelData) => PixelData }

// 8 ビットの BGRA (D3D の A8R8G8B8・X8R8G8B8 のバイト順) を RGBA にする。alpha が無い形式 (X) は 255
function bgraToRgba(opaque: boolean) {
  return (data: PixelData): PixelData => {
    const src = data as Uint8Array;
    const out = new Uint8Array(src.length);
    for (let i = 0; i < src.length; i += 4) {
      out[i] = src[i + 2];
      out[i + 1] = src[i + 1];
      out[i + 2] = src[i];
      out[i + 3] = opaque ? 255 : src[i + 3];
    }
    return out;
  };
}

// 16 ビット整数 (0〜65535) は WebGL2 では RGBA16 のテクスチャにできないので、半精度の浮動小数点 (0〜1) にする
function unorm16ToHalf(data: PixelData): PixelData {
  const src = data as Uint16Array;
  const out = new Uint16Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = THREE.DataUtils.toHalfFloat(src[i] / 65535);
  return out;
}

const PLANS: Record<Exclude<DdsFormat, 'dxt1' | 'dxt3' | 'dxt5'>, Plan> = {
  rgba8: { format: THREE.RGBAFormat, type: THREE.UnsignedByteType },
  bgra8: { format: THREE.RGBAFormat, type: THREE.UnsignedByteType, convert: bgraToRgba(false) },
  bgrx8: { format: THREE.RGBAFormat, type: THREE.UnsignedByteType, convert: bgraToRgba(true) },
  rg8: { format: THREE.RGFormat, type: THREE.UnsignedByteType },
  r8: { format: THREE.RedFormat, type: THREE.UnsignedByteType },
  rgba16f: { format: THREE.RGBAFormat, type: THREE.HalfFloatType },
  rg16f: { format: THREE.RGFormat, type: THREE.HalfFloatType },
  r16f: { format: THREE.RedFormat, type: THREE.HalfFloatType },
  rgba16: { format: THREE.RGBAFormat, type: THREE.HalfFloatType, convert: unorm16ToHalf },
  rgba32f: { format: THREE.RGBAFormat, type: THREE.FloatType },
  rg32f: { format: THREE.RGFormat, type: THREE.FloatType },
  r32f: { format: THREE.RedFormat, type: THREE.FloatType },
};

const S3TC: Record<'dxt1' | 'dxt3' | 'dxt5', THREE.CompressedPixelFormat> = {
  dxt1: THREE.RGBA_S3TC_DXT1_Format, dxt3: THREE.RGBA_S3TC_DXT3_Format, dxt5: THREE.RGBA_S3TC_DXT5_Format,
};

let s3tcFound: boolean | undefined;
// この GPU が S3TC (DXT) の圧縮テクスチャを使えるか。使い捨ての WebGL で一度だけ調べる (調べる方法がなければ使えるとみなす)
export function s3tcSupported(): boolean {
  if (s3tcFound !== undefined) return s3tcFound;
  s3tcFound = true;
  try {
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : typeof document !== 'undefined' ? document.createElement('canvas') : null;
    const gl = canvas?.getContext('webgl2') as WebGL2RenderingContext | null | undefined;
    if (gl) {
      s3tcFound = gl.getExtension('WEBGL_compressed_texture_s3tc') !== null;
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch {
    // 調べられなければ、使えるとして読む (使えなければ three.js が警告を出す)
  }
  return s3tcFound;
}

// 1 つの段を GL に渡せる並び・型にする (変えなくていいときは元の配列のまま)
function glLevel(l: DdsLevel, plan: Plan): DdsLevel {
  return plan.convert ? { ...l, data: plan.convert(l.data) } : l;
}

function dataTexture(l: DdsLevel, plan: Plan): THREE.DataTexture {
  return new THREE.DataTexture(l.data as THREE.TypedArray, l.width, l.height, plan.format, plan.type);
}

function compressedTexture(dds: DdsImage & { format: 'dxt1' | 'dxt3' | 'dxt5' }): THREE.Texture {
  const format = S3TC[dds.format];
  if (!dds.cube) return new THREE.CompressedTexture(dds.faces[0] as THREE.CompressedTextureMipmap[], dds.width, dds.height, format);
  const images = dds.faces.map(mipmaps => ({ mipmaps, width: dds.width, height: dds.height }));
  return new THREE.CompressedCubeTexture(images as unknown as THREE.CompressedTextureImageData[], format);
}

function uncompressedTexture(dds: DdsImage, plan: Plan): THREE.Texture {
  const faces = dds.faces.map(levels => levels.map(l => glLevel(l, plan)));
  const levels = faces[0].length;
  if (!dds.cube) {
    const tex = dataTexture(faces[0][0], plan);
    // 2D の mipmaps は 1 段目 (元の大きさ) から並べる (three.js の DataTexture の決まり)
    if (levels > 1) tex.mipmaps = faces[0] as THREE.DataTexture['mipmaps'];
    return tex;
  }
  const cube = new THREE.CubeTexture(faces.map(f => dataTexture(f[0], plan)), THREE.CubeReflectionMapping, THREE.ClampToEdgeWrapping, THREE.ClampToEdgeWrapping, THREE.NearestFilter, THREE.NearestFilter, plan.format, plan.type);
  // 無圧縮のキューブの mipmaps は 2 段目から。各段は 6 面の DataTexture を image に持つ (three.js の決まり)
  for (let j = 1; j < levels; j++) (cube.mipmaps as unknown[]).push(new THREE.CubeTexture(faces.map(f => dataTexture(f[j], plan))));
  return cube;
}

function decodeDds(bytes: Uint8Array, hasS3tc: () => boolean): THREE.Texture {
  const dds = parseDds(bytes);
  if (dds.format === 'dxt1' || dds.format === 'dxt3' || dds.format === 'dxt5') {
    if (!hasS3tc()) throw new Error(t('この GPU は DXT (S3TC) の圧縮テクスチャに対応していません'));
    return compressedTexture({ ...dds, format: dds.format });
  }
  const tex = uncompressedTexture(dds, PLANS[dds.format]);
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;
  return tex;
}

// 画像ファイルを読む (上下は返さない。ガンマ空間のまま)。dds は自前の parseDds、hdr・tga は three.js のローダー、png・jpg・bmp・gif・webp はブラウザ。
// hasS3tc: DXT の DDS を読めるか (既定はこの GPU を調べる)。読めないなら Error
export async function decodeTexture(bytes: Uint8Array, path: string, hasS3tc: () => boolean = s3tcSupported): Promise<THREE.Texture> {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  let tex: THREE.Texture;
  if (ext === 'tga') {
    const d = new TGALoader().parse(bufferOf(bytes));
    tex = new THREE.DataTexture(d.data, d.width, d.height);
  } else if (ext === 'hdr') {
    const d = new HDRLoader().parse(bufferOf(bytes));
    tex = new THREE.DataTexture(d.data, d.width, d.height, THREE.RGBAFormat, THREE.HalfFloatType);
  } else if (ext === 'dds') {
    tex = decodeDds(bytes, hasS3tc);
  } else if (MIME[ext]) {
    const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: MIME[ext] });
    const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    tex = new THREE.Texture(bitmap);
    tex.addEventListener('dispose', () => bitmap.close());
  } else {
    throw new Error(t('知らない画像の形式です: .{ext}', { ext }));
  }
  tex.colorSpace = THREE.NoColorSpace;
  tex.flipY = false;
  tex.needsUpdate = true;
  return tex;
}

// source を共有した写し。CompressedCubeTexture は引数なしでは作れず (images[0] を読む)、mipmaps も undefined
// (面ごとのミップは image の中) で copy が落ちるので、自分で作り、mipmaps を補った見かけの元から写す (元は変えない)
export function cloneTexture(t: THREE.Texture): THREE.Texture {
  if (t instanceof THREE.CompressedCubeTexture) {
    const from = t.mipmaps ? t : Object.assign(Object.create(t) as THREE.CompressedCubeTexture, { mipmaps: [] });
    return new THREE.CompressedCubeTexture(t.image, t.format, t.type).copy(from);
  }
  return t.clone();
}
