// MME のレンダーターゲット (RENDERCOLORTARGET・RENDERDEPTHSTENCILTARGET) の大きさと形式
import type { Annotation, TextureDecl } from '../fx/desc.ts';

export type TargetFormat = 'rgba8' | 'rgba16f' | 'rgba32f' | 'r16f' | 'r32f' | 'rg16f' | 'rg32f' | 'depth24stencil8';
export interface TargetSpec { width: number; height: number; format: TargetFormat; mipmaps: boolean; warnings: string[] }

const COLOR_FORMATS: Record<string, TargetFormat> = {
  A8R8G8B8: 'rgba8', X8R8G8B8: 'rgba8', A8B8G8R8: 'rgba8',
  A16B16G16R16F: 'rgba16f', A32B32G32R32F: 'rgba32f',
  R16F: 'r16f', R32F: 'r32f', G16R16F: 'rg16f', G32R32F: 'rg32f',
};
const DEPTH_FORMATS = new Set(['D24S8', 'D24X8', 'D16']);

function numbers(list: Annotation[], name: string): number[] | null {
  const n = name.toLowerCase();
  const v = list.find(a => a.name.toLowerCase() === n)?.value;
  return Array.isArray(v) && v.length > 0 ? v : null;
}
function text(list: Annotation[], name: string): string | null {
  const n = name.toLowerCase();
  const v = list.find(a => a.name.toLowerCase() === n)?.value;
  return typeof v === 'string' ? v : null;
}

export function targetSpec(t: TextureDecl, screen: [number, number], depth: boolean): TargetSpec {
  const an = t.annotations;
  const warnings: string[] = [];
  const dim = numbers(an, 'Dimensions');
  const ratio = numbers(an, 'ViewportRatio');
  const fromRatio = (axis: 0 | 1) => Math.round(screen[axis] * (ratio?.[axis] ?? ratio?.[0] ?? 1));
  const size = (explicit: number | undefined, axis: 0 | 1) => Math.max(1, explicit ?? fromRatio(axis));
  const width = size(dim && dim.length >= 2 ? dim[0] : numbers(an, 'Width')?.[0], 0);
  const height = size(dim && dim.length >= 2 ? dim[1] : numbers(an, 'Height')?.[0], 1);

  const fallback: TargetFormat = depth ? 'depth24stencil8' : 'rgba8';
  let format: TargetFormat = fallback;
  const raw = text(an, 'Format');
  if (raw !== null) {
    const key = raw.trim().toUpperCase().replace(/^D3DFMT_/, '');
    const known = depth ? (DEPTH_FORMATS.has(key) ? fallback : undefined) : COLOR_FORMATS[key];
    if (known) format = known;
    else warnings.push(`レンダーターゲット ${t.name} の形式 ${raw} は使えないので既定にします`);
  }

  // MipLevels の既定は D3DX と同じく 1 (なし → ミップマップなし)。0 は全段、2 以上も作る
  const mips = numbers(an, 'MipLevels')?.[0] ?? 1;
  return { width, height, format, mipmaps: !depth && mips !== 1, warnings };
}
