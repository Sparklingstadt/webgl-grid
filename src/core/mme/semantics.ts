// MMD が .fx のセマンティクスに渡す値 (設計書「MMD が .fx に渡す値」)。three.js の空間の状態から MMD (左手系・D3D) の値を作る。
import { Matrix4, Vector3 } from 'three';
import type { Param, TextureDecl } from '../fx/desc.ts';
import { annotation } from './annotations.ts';
import { controlRef, type ControlRef } from './controllers.ts';
import { groundShadowMatrix, perspectiveD3D, toMmd, toMmdVec, viewLH } from './coords.ts';
import { typeShape } from './typeShape.ts';

export type MmdPass = 'object' | 'object_ss' | 'zplot' | 'shadow' | 'edge';
// MME の空間 (MMD の単位。向きは three.js の右手系のままで、値を作るときに z を反転する)。fovY はラジアン
export interface CameraState { position: Vector3; target: Vector3; up: Vector3; fovY: number; aspect: number; near: number; far: number }
export interface LightState {
  direction: Vector3;                 // 光が進む向き (three.js の空間)
  color: [number, number, number];
  shadowView: Matrix4; shadowProjection: Matrix4; // セルフシャドウのライトのカメラ (MME の空間。左手系・D3D に直したもの)
}
export interface MaterialState {
  diffuse: [number, number, number, number]; ambient: [number, number, number]; specular: [number, number, number]; power: number;
  toon: [number, number, number]; edgeColor: [number, number, number, number]; groundShadowColor: [number, number, number, number];
  hasTexture: boolean; hasSphere: boolean; hasToon: boolean; sphereAdd: boolean; transparent: boolean;
}
export interface SemanticContext {
  // world: 物 → MME の空間 (右手系。MMD モデルは置き方を頂点に入れてあるので単位行列、ほかの物は Scale(k)·matrixWorld)
  camera: CameraState; light: LightState; world: Matrix4; material: MaterialState | null;
  pass: MmdPass | null /* null はポストエフェクト */; time: number; elapsed: number; screen: [number, number]; selfShadow: boolean;
  control?: (ref: ControlRef) => number[] | null; // CONTROLOBJECT の値 (null と、この関数がないときは 0)
  // いま描いているオフスクリーンの持ち主 ((OffscreenOwner)。engine の Obj。Main とポストエフェクト・持ち主のないオフスクリーンは null)
  owner?: object | null;
}
export type SemanticValue = { kind: 'numbers'; values: number[] } | { kind: 'unsupported'; what: string } | { kind: 'none' };
export type TextureRole = 'material' | 'sphere' | 'toon' | 'colorTarget' | 'depthTarget' | 'offscreen' | 'file' | 'unsupported' | 'none';

// 地面の影の既定の色 (MMD と同じ半透明の黒)
export const SHADOW_COLOR: [number, number, number, number] = [0, 0, 0, 0.5];

// ライトの位置は MME のエフェクトがほぼ使わないので、カメラの注視点から光の来る側へこの距離 (MMD の単位) だけ離した点にする
export const LIGHT_DISTANCE = 10000;

// MME の空間の遠い面の最小 (MMD の単位)。MMD と同じく遠くまで描く (Ray-MMD の空は半径 10000)
export const MME_FAR_MIN = 100000;

// three.js の場面のカメラを MME の空間 (k 倍。k = MMD の単位 ÷ 場面の単位) にする: 位置と注視点は k 倍、向きと画角はそのまま、
// 近い面は k 倍、遠い面は k 倍と MME_FAR_MIN の大きい方
export function mmeCamera(c: CameraState, k: number): CameraState {
  return {
    position: c.position.clone().multiplyScalar(k), target: c.target.clone().multiplyScalar(k), up: c.up.clone(),
    fovY: c.fovY, aspect: c.aspect, ...mmeDepthRange(c.near, c.far, k),
  };
}

// MME のカメラの近い面と遠い面 (mmeCamera と同じ)
export function mmeDepthRange(near: number, far: number, k: number): { near: number; far: number } {
  return { near: near * k, far: Math.max(far * k, MME_FAR_MIN) };
}

const MATRIX_RE = /^(WORLD|VIEW|PROJECTION|WORLDVIEW|VIEWPROJECTION|WORLDVIEWPROJECTION)(INVERSE|TRANSPOSE|INVERSETRANSPOSE)?$/;
const UNSUPPORTED = new Set(['MOUSEPOSITION', 'LEFTMOUSEDOWN', 'MIDDLEMOUSEDOWN', 'RIGHTMOUSEDOWN', 'TEXTUREVALUE']);

const numbers = (values: number[]): SemanticValue => ({ kind: 'numbers', values });
const NONE: SemanticValue = { kind: 'none' };

// 注釈 Object の値 (小文字)。なければ null
function objectOf(p: Param): string | null {
  const a = annotation(p.annotations, 'Object');
  return a && typeof a.value === 'string' ? a.value.toLowerCase() : null;
}

// 値を型の形に合わせる。行列は 4×4 (行ごと) から R 行 C 列を取り、ベクトル・スカラーは先の個数を取る。足りない成分は 1 (不透明度など)
function fit(values: number[], type: string): number[] {
  const s = typeShape(type);
  if (!s || s.array) return values.slice();
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

// CONTROLOBJECT の値。項目にならない宣言 (型が合わない・name がない) は control を呼ばずに 0
function controlValue(p: Param, ctx: SemanticContext): number[] {
  const ref = controlRef(p);
  const v = ref ? ctx.control?.(ref) ?? null : null;
  if (v) return v;
  const s = typeShape(p.type);
  return Array.from({ length: s ? s.rows * s.cols * s.elems : 1 }, () => 0);
}

function semanticNumbers(p: Param, ctx: SemanticContext): number[] | SemanticValue {
  if (p.semantic === null) return namedValue(p.name, ctx) ?? NONE;
  const sem = p.semantic.toUpperCase();
  if (sem === 'CONTROLOBJECT') return controlValue(p, ctx);
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
    case 'OFFSCREENRENDERTARGET': return 'offscreen';
    case 'ANIMATEDTEXTURE': return 'unsupported';
    case undefined: return annotation(t.annotations, 'ResourceName') ? 'file' : 'none';
    default: return 'none';
  }
}
