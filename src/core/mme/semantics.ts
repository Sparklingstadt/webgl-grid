// MMD が .fx のセマンティクスに渡す値 (設計書「MMD が .fx に渡す値」)。three.js の空間の状態から MMD (左手系・D3D) の値を作る。
import { Matrix4, Vector3 } from 'three';
import type { Annotation, Param, TextureDecl } from '../fx/desc.ts';
import { groundShadowMatrix, perspectiveD3D, toMmd, toMmdVec, viewLH } from './coords.ts';

export type MmdPass = 'object' | 'object_ss' | 'zplot' | 'shadow' | 'edge';
export interface CameraState { position: Vector3; target: Vector3; up: Vector3; fovY: number; aspect: number; near: number; far: number } // three.js の空間 (fovY はラジアン)
export interface LightState {
  direction: Vector3;                 // 光が進む向き (three.js の空間)
  color: [number, number, number];
  shadowView: Matrix4; shadowProjection: Matrix4; // セルフシャドウのライトのカメラ (左手系・D3D に直したもの)
}
export interface MaterialState {
  diffuse: [number, number, number, number]; ambient: [number, number, number]; specular: [number, number, number]; power: number;
  toon: [number, number, number]; edgeColor: [number, number, number, number]; groundShadowColor: [number, number, number, number];
  hasTexture: boolean; hasSphere: boolean; hasToon: boolean; sphereAdd: boolean; transparent: boolean;
}
export interface SemanticContext {
  camera: CameraState; light: LightState; world: Matrix4 /* three.js の物 → 世界 */; material: MaterialState | null;
  pass: MmdPass | null /* null はポストエフェクト */; time: number; elapsed: number; screen: [number, number]; selfShadow: boolean;
}
export type SemanticValue = { kind: 'numbers'; values: number[] } | { kind: 'unsupported'; what: string } | { kind: 'none' };
export type TextureRole = 'material' | 'sphere' | 'toon' | 'colorTarget' | 'depthTarget' | 'file' | 'unsupported' | 'none';

// 地面の影の既定の色 (MMD と同じ半透明の黒)
export const SHADOW_COLOR: [number, number, number, number] = [0, 0, 0, 0.5];

// ライトの位置は MME のエフェクトがほぼ使わないので、カメラの注視点から光の来る側へこの距離だけ離した点にする
export const LIGHT_DISTANCE = 1000;

const MATRIX_RE = /^(WORLD|VIEW|PROJECTION|WORLDVIEW|VIEWPROJECTION|WORLDVIEWPROJECTION)(INVERSE|TRANSPOSE|INVERSETRANSPOSE)?$/;
const UNSUPPORTED = new Set(['CONTROLOBJECT', 'MOUSEPOSITION', 'LEFTMOUSEDOWN', 'MIDDLEMOUSEDOWN', 'RIGHTMOUSEDOWN', 'TEXTUREVALUE']);

const numbers = (values: number[]): SemanticValue => ({ kind: 'numbers', values });
const NONE: SemanticValue = { kind: 'none' };

function annotation(list: Annotation[], name: string): Annotation | undefined {
  const n = name.toLowerCase();
  return list.find(a => a.name.toLowerCase() === n);
}

// 注釈 Object の値 (小文字)。なければ null
function objectOf(p: Param): string | null {
  const a = annotation(p.annotations, 'Object');
  return a && typeof a.value === 'string' ? a.value.toLowerCase() : null;
}

// 型の形 (行 × 列)。スカラーは 1 × 1。知らない型は null
function shapeOf(type: string): { rows: number; cols: number; matrix: boolean } | null {
  const m = /^(?:float|half|double|int|uint|bool)([1-4])?(?:x([1-4]))?$/.exec(type);
  if (!m) return null;
  if (m[2]) return { rows: Number(m[1]), cols: Number(m[2]), matrix: true };
  return { rows: 1, cols: m[1] ? Number(m[1]) : 1, matrix: false };
}

// 値を型の形に合わせる。行列は 4×4 (行ごと) から R 行 C 列を取り、ベクトル・スカラーは先の個数を取る。足りない成分は 1 (不透明度など)
function fit(values: number[], type: string): number[] {
  const s = shapeOf(type);
  if (!s) return values.slice();
  if (s.matrix) {
    const out: number[] = [];
    for (let r = 0; r < s.rows; r++) for (let c = 0; c < s.cols; c++) out.push(values[r * 4 + c] ?? 0);
    return out;
  }
  const out = values.slice(0, s.cols);
  while (out.length < s.cols) out.push(1);
  return out;
}

function unit(v: Vector3): Vector3 {
  const l = v.length();
  return l > 0 ? v.clone().divideScalar(l) : v.clone();
}

// MMD の世界での、光が進む向き (左手系)
function lightDirection(ctx: SemanticContext): Vector3 {
  return unit(toMmdVec(ctx.light.direction));
}

function matrixValue(m: RegExpExecArray, p: Param, ctx: SemanticContext): number[] {
  const useLight = objectOf(p) === 'light';
  let w = toMmd(ctx.world);
  if (ctx.pass === 'shadow') w = groundShadowMatrix(lightDirection(ctx)).multiply(w);
  const cam = ctx.camera;
  const view = useLight
    ? ctx.light.shadowView
    : viewLH(toMmdVec(cam.position), toMmdVec(cam.target), toMmdVec(cam.up));
  const proj = useLight ? ctx.light.shadowProjection : perspectiveD3D(cam.fovY, cam.aspect, cam.near, cam.far);
  // HLSL の W·V·P は、列ベクトルの書き方では P·V·W
  let r: Matrix4;
  switch (m[1]) {
    case 'WORLD': r = w; break;
    case 'VIEW': r = view.clone(); break;
    case 'PROJECTION': r = proj.clone(); break;
    case 'WORLDVIEW': r = new Matrix4().multiplyMatrices(view, w); break;
    case 'VIEWPROJECTION': r = new Matrix4().multiplyMatrices(proj, view); break;
    default: r = new Matrix4().multiplyMatrices(proj, view).multiply(w); break;
  }
  // shadow の pass の W は地面に潰す行列 (特異) を含むので、WORLDINVERSE などの逆行列は 0 の行列になる
  const kind = m[2] ?? '';
  if (kind.startsWith('INVERSE')) r = r.clone().invert();
  if (kind.endsWith('TRANSPOSE')) r = r.clone().transpose();
  return r.elements.slice();
}

function lightValue(sem: string, ctx: SemanticContext): number[] | null {
  switch (sem) {
    case 'DIFFUSE': return [0, 0, 0, 1];                                    // MME の決まり
    case 'AMBIENT': case 'SPECULAR': return [...ctx.light.color, 1];
    case 'DIRECTION': return lightDirection(ctx).toArray();
    case 'POSITION': return toMmdVec(ctx.camera.target).addScaledVector(lightDirection(ctx), -LIGHT_DISTANCE).toArray();
    default: return null;
  }
}

function materialValue(sem: string, mat: MaterialState): number[] | null {
  switch (sem) {
    case 'DIFFUSE': return mat.diffuse;
    case 'AMBIENT': return mat.diffuse.slice(0, 3);  // MME の決まり (拡散色)
    case 'EMISSIVE': return mat.ambient;             // MME の決まり (環境色)
    case 'SPECULAR': return mat.specular;
    case 'SPECULARPOWER': return [mat.power];
    case 'TOONCOLOR': return mat.hasToon ? mat.toon : [1, 1, 1];  // トゥーンがなければ白
    case 'EDGECOLOR': return mat.edgeColor;
    case 'GROUNDSHADOWCOLOR': return mat.groundShadowColor;
    // 材質モーフ (この計画ではなし): 加算は 0、乗算は 1
    case 'ADDINGTEXTURE': case 'ADDINGSPHERETEXTURE': return [0, 0, 0, 0];
    case 'MULTIPLYINGTEXTURE': case 'MULTIPLYINGSPHERETEXTURE': return [1, 1, 1, 1];
    default: return null;
  }
}

// セマンティクスのない変数の、名前で決まる値
function namedValue(name: string, ctx: SemanticContext): number[] | null {
  const mat = ctx.material;
  const b = (x: boolean | undefined) => [x ? 1 : 0];
  switch (name) {
    case 'parthf': return b(ctx.selfShadow);
    case 'transp': return b(mat?.transparent);
    case 'spadd': return b(mat?.sphereAdd);
    case 'use_texture': return b(mat?.hasTexture);
    case 'use_spheremap': return b(mat?.hasSphere);
    case 'use_toon': return b(mat?.hasToon);
    case 'use_subtexture': case 'opadd': return [0];
    default: return null;
  }
}

function semanticNumbers(p: Param, ctx: SemanticContext): number[] | SemanticValue {
  if (p.semantic === null) return namedValue(p.name, ctx) ?? NONE;
  const sem = p.semantic.toUpperCase();
  if (UNSUPPORTED.has(sem)) return { kind: 'unsupported', what: sem };
  const mm = MATRIX_RE.exec(sem);
  if (mm) return matrixValue(mm, p, ctx);
  const obj = objectOf(p);
  const cam = ctx.camera;
  switch (sem) {
    case 'POSITION': case 'DIRECTION': {
      if (obj === 'light') return lightValue(sem, ctx) ?? NONE;
      if (obj !== null && obj !== 'camera') return NONE;
      const eye = toMmdVec(cam.position);
      return sem === 'POSITION' ? eye.toArray() : unit(toMmdVec(cam.target).sub(eye)).toArray();
    }
    case 'VIEWPORTPIXELSIZE': return [...ctx.screen];
    case 'TIME': return [ctx.time];
    case 'ELAPSEDTIME': return [ctx.elapsed];
  }
  if (obj === 'light') return lightValue(sem, ctx) ?? NONE;
  if (obj !== null && obj !== 'geometry') return NONE;
  return (ctx.material ? materialValue(sem, ctx.material) : null) ?? NONE;
}

// values は p.type の形に合わせた数 (行列は行ごと)
export function semanticValue(p: Param, ctx: SemanticContext): SemanticValue {
  const r = semanticNumbers(p, ctx);
  return Array.isArray(r) ? numbers(fit(r, p.type)) : r;
}

export function textureRole(t: TextureDecl): TextureRole {
  switch (t.semantic?.toUpperCase()) {
    case 'MATERIALTEXTURE': return 'material';
    case 'MATERIALSPHEREMAP': return 'sphere';
    case 'MATERIALTOONTEXTURE': return 'toon';
    case 'RENDERCOLORTARGET': return 'colorTarget';
    case 'RENDERDEPTHSTENCILTARGET': return 'depthTarget';
    case 'OFFSCREENRENDERTARGET': case 'ANIMATEDTEXTURE': return 'unsupported';
    case undefined: return annotation(t.annotations, 'ResourceName') ? 'file' : 'none';
    default: return 'none';
  }
}
