import * as THREE from 'three';
import { nest, simplify, traceLoops, type Outline, type Pt } from './contours';

// --- 文字の形: パソコンのフォントで文字を描き、輪郭をなぞって、厚みのある形にする ---
// 大きさは em (フォントの大きさ = 1)。基準線 (ベースライン) が y = 0、文字の左が x = 0
const PX = 96;   // 描く大きさ (ピクセル)
const PAD = 4;
export interface GlyphShape { outlines: Outline[]; advance: number }

function canvas(w: number, h: number): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null {
  const g = globalThis as { OffscreenCanvas?: typeof OffscreenCanvas; document?: Document };
  if (g.OffscreenCanvas) return new g.OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });
  if (g.document) return Object.assign(g.document.createElement('canvas'), { width: w, height: h }).getContext('2d', { willReadFrequently: true });
  return null; // (描けないところ (テスト) では、形なし)
}

export const cssFont = (family: string, weight: string, px = PX) => `${weight === 'bold' ? 'bold' : 'normal'} ${px}px ${family}`;

const shapes = new Map<string, GlyphShape>();
// 文字 1 つの輪郭と送り幅 (次の文字までの幅)
export function glyphShape(ch: string, font: string): GlyphShape {
  const key = `${font}\0${ch}`;
  const hit = shapes.get(key);
  if (hit) return hit;
  let result: GlyphShape = { outlines: [], advance: 0.5 };
  const probe = canvas(1, 1);
  if (probe) {
    probe.font = font;
    const m = probe.measureText(ch);
    const left = Math.ceil(m.actualBoundingBoxLeft), right = Math.ceil(m.actualBoundingBoxRight);
    const asc = Math.ceil(m.actualBoundingBoxAscent), desc = Math.ceil(m.actualBoundingBoxDescent);
    const w = Math.max(left + right, 1) + PAD * 2, h = Math.max(asc + desc, 1) + PAD * 2;
    const ox = PAD + left, oy = PAD + asc; // 文字の基準 (左・ベースライン) の場所
    const ctx = /\s/.test(ch) ? null : canvas(w, h);
    let outlines: Outline[] = [];
    if (ctx) {
      ctx.font = font;
      ctx.fillStyle = '#fff';
      ctx.fillText(ch, ox, oy);
      const img = ctx.getImageData(0, 0, w, h).data, v = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) v[i] = img[i * 4 + 3] / 255;
      const em = (p: Pt): Pt => [(p[0] + 0.5 - ox) / PX, (oy - p[1] - 0.5) / PX];
      outlines = nest(traceLoops(v, w, h).map(l => simplify(l, 0.35)), 2).map(o => ({ outer: o.outer.map(em), holes: o.holes.map(hl => hl.map(em)) }));
    }
    result = { outlines, advance: m.width / PX };
  }
  if (shapes.size > 2000) shapes.clear();
  shapes.set(key, result);
  return result;
}

// 厚みのある文字の形 (em。奥行きは真ん中が z = 0)。depth・bevel も em で
const geometries = new Map<string, THREE.BufferGeometry | null>();
export function glyphGeometry(ch: string, font: string, depth: number, bevel: number): THREE.BufferGeometry | null {
  const key = `${font}\0${ch}\0${depth.toFixed(4)}\0${bevel.toFixed(4)}`;
  if (geometries.has(key)) return geometries.get(key)!;
  const { outlines } = glyphShape(ch, font);
  let g: THREE.BufferGeometry | null = null;
  if (outlines.length) {
    const v2 = (p: Pt) => new THREE.Vector2(p[0], p[1]);
    const list = outlines.map(o => { const s = new THREE.Shape(o.outer.map(v2)); s.holes = o.holes.map(hl => new THREE.Path(hl.map(v2))); return s; });
    g = new THREE.ExtrudeGeometry(list, {
      depth: Math.max(depth, 1e-4), steps: 1, curveSegments: 1,
      bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel * 0.6, bevelSegments: 2,
    });
    g.translate(0, 0, -depth / 2);
  }
  if (geometries.size > 1000) clearGlyphs();
  geometries.set(key, g);
  return g;
}
export function clearGlyphs() {
  for (const g of geometries.values()) g?.dispose();
  geometries.clear();
}
