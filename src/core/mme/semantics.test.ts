import { describe, expect, it } from 'vitest';
import { Matrix4, PerspectiveCamera, Vector3, Vector4 } from 'three';
import { compileEffect } from '../fx/index.ts';
import type { EffectDesc } from '../fx/index.ts';
import { perspectiveD3D, toMmd, toMmdVec, viewLH } from './coords.ts';
import { LIGHT_DISTANCE, semanticValue, SHADOW_COLOR, textureRole, type MaterialState, type SemanticContext } from './semantics.ts';

const FUNCS = 'float4 VS(float4 p : POSITION) : POSITION { return p; } float4 PS() : COLOR0 { return 1; }';
const TECH = ` ${FUNCS} technique T { pass P { VertexShader = compile vs_3_0 VS(); PixelShader = compile ps_3_0 PS(); } }`;

// 小さな HLSL を compileEffect にかけて、宣言を取り出す
function compile(decl: string): EffectDesc {
  const r = compileEffect('a.fx', p => (p === 'a.fx' ? new TextEncoder().encode(decl + TECH) : null));
  if (!r.ok) throw new Error(r.errors.map(e => `${e.code}: ${e.message}`).join('\n'));
  return r.effect;
}
const paramOf = (decl: string) => compile(decl).params[0];

const MAT: MaterialState = {
  diffuse: [0.9, 0.7, 0.5, 0.8], ambient: [0.4, 0.3, 0.2], specular: [0.1, 0.2, 0.3], power: 12,
  toon: [0.6, 0.6, 0.6], edgeColor: [0, 0, 0, 1], groundShadowColor: SHADOW_COLOR,
  hasTexture: true, hasSphere: false, hasToon: true, sphereAdd: false, transparent: false,
};

// 物は (0, 0, 5)、カメラは (0, 10, -30) から原点を見る
function makeCtx(over: Partial<SemanticContext> = {}): SemanticContext {
  const cam = new PerspectiveCamera();
  cam.position.set(0, 10, -30);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld();
  return {
    camera: {
      position: new Vector3(0, 10, -30), target: new Vector3(0, 0, 0), up: new Vector3().setFromMatrixColumn(cam.matrixWorld, 1),
      fovY: 0.8, aspect: 1.5, near: 0.1, far: 500,
    },
    light: {
      direction: new Vector3(1, -1, 0.5).normalize(), color: [0.5, 0.6, 0.7],
      shadowView: new Matrix4().makeTranslation(1, 2, 3), shadowProjection: new Matrix4().makeScale(2, 3, 4),
    },
    world: new Matrix4().makeTranslation(0, 0, 5), material: MAT, pass: 'object', time: 1.5, elapsed: 0.25, screen: [640, 480], selfShadow: true,
    ...over,
  };
}

function val(decl: string, over: Partial<SemanticContext> = {}): number[] {
  const r = semanticValue(paramOf(decl), makeCtx(over));
  if (r.kind !== 'numbers') throw new Error(`numbers ではない: ${r.kind}`);
  return r.values;
}
const withMat = (m: Partial<MaterialState>) => ({ material: { ...MAT, ...m } });
const close = (a: number[]) => a.map(n => expect.closeTo(n, 5));
// HLSL の mul(v, M): M[r][c] = elements[r * 4 + c]
const mulRow = (v: number[], m: number[]) => [0, 1, 2, 3].map(c => v.reduce((s, vi, r) => s + vi * m[r * 4 + c], 0));

describe('MME のセマンティクスの値', () => {
  it('WORLDVIEWPROJECTION で物の原点が手で計算した位置に写る', () => {
    const m = val('float4x4 M : WORLDVIEWPROJECTION;');
    expect(m).toHaveLength(16);
    const ctx = makeCtx();
    const c = mulRow([0, 0, 0, 1], m);
    // 別々の行列を順に掛けた値 (MMD の世界: 物 (0, 0, −5)、目 (0, 10, 30)、原点を見る)
    const v = new Vector4(0, 0, 0, 1).applyMatrix4(toMmd(ctx.world))
      .applyMatrix4(viewLH(new Vector3(0, 10, 30), new Vector3(0, 0, 0), new Vector3(0, 1, 0)))
      .applyMatrix4(perspectiveD3D(0.8, 1.5, 0.1, 500));
    expect(c).toEqual(close(v.toArray()));
    // 手計算: 視線は (0, −10, −30)/√1000、目 → 物は (0, −10, −35) なので奥行き = 1150/√1000。x = 0 の平面上
    expect(c[3]).toBeCloseTo(1150 / Math.sqrt(1000), 5);
    expect(c[0]).toBeCloseTo(0, 5);
  });

  it('WORLD・VIEW・PROJECTION・合成の行列が、順に掛けたものと合う', () => {
    const ctx = makeCtx();
    const w = toMmd(ctx.world);
    const v = viewLH(new Vector3(0, 10, 30), new Vector3(0, 0, 0), new Vector3(0, 1, 0));
    const p = perspectiveD3D(0.8, 1.5, 0.1, 500);
    expect(val('float4x4 M : WORLD;')).toEqual(close(w.elements));
    expect(val('float4x4 M : VIEW;')).toEqual(close(v.elements));
    expect(val('float4x4 M : PROJECTION;')).toEqual(close(p.elements));
    expect(val('float4x4 M : WORLDVIEW;')).toEqual(close(new Matrix4().multiplyMatrices(v, w).elements));
    expect(val('float4x4 M : VIEWPROJECTION;')).toEqual(close(new Matrix4().multiplyMatrices(p, v).elements));
  });

  it('INVERSE・TRANSPOSE・INVERSETRANSPOSE', () => {
    const w = val('float4x4 M : WORLD;');
    const inv = val('float4x4 M : WORLDINVERSE;');
    const prod = new Matrix4().fromArray(inv).multiply(new Matrix4().fromArray(w));
    expect(prod.elements).toEqual(close(new Matrix4().identity().elements));
    const wvp = val('float4x4 M : WORLDVIEWPROJECTION;');
    const t = val('float4x4 M : WORLDVIEWPROJECTIONTRANSPOSE;');
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) expect(t[r * 4 + c]).toBeCloseTo(wvp[c * 4 + r], 6);
    const it2 = val('float4x4 M : WORLDVIEWINVERSETRANSPOSE;');
    const wv = val('float4x4 M : WORLDVIEW;');
    const wvInv = val('float4x4 M : WORLDVIEWINVERSE;');
    expect(new Matrix4().fromArray(wvInv).multiply(new Matrix4().fromArray(wv)).elements).toEqual(close(new Matrix4().identity().elements));
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) expect(it2[r * 4 + c]).toBeCloseTo(wvInv[c * 4 + r], 6);
  });

  it('Object = "Light" の行列はライトのカメラ (大文字小文字を問わない)', () => {
    const ctx = makeCtx();
    expect(val('float4x4 M : VIEW < string Object = "Light"; >;')).toEqual(close(ctx.light.shadowView.elements));
    expect(val('float4x4 M : PROJECTION < string Object = "light"; >;')).toEqual(close(ctx.light.shadowProjection.elements));
    // 物 (0, 0, −5) → 視野 (1, 2, −2) → 射影 (2, 6, −8)
    const wvp = val('float4x4 M : WORLDVIEWPROJECTION < string Object = "LIGHT"; >;');
    expect(mulRow([0, 0, 0, 1], wvp)).toEqual(close([2, 6, -8, 1]));
    // Camera の指定は省略と同じ
    expect(val('float4x4 M : VIEW < string Object = "Camera"; >;')).toEqual(val('float4x4 M : VIEW;'));
  });

  it('材質の値は MME の決まり (AMBIENT は拡散色、EMISSIVE は環境色)', () => {
    const m = { ...MAT, diffuse: [0.9, 0.7, 0.5, 1] as MaterialState['diffuse'], ambient: [0.4, 0.3, 0.2] as MaterialState['ambient'] };
    expect(val('float3 A : AMBIENT;', { material: m })).toEqual([0.9, 0.7, 0.5]);
    expect(val('float3 E : EMISSIVE;', { material: m })).toEqual([0.4, 0.3, 0.2]);
    expect(val('float4 D : DIFFUSE;', { material: m })).toEqual([0.9, 0.7, 0.5, 1]);
    expect(val('float4 D : DIFFUSE < string Object = "Geometry"; >;', { material: m })).toEqual([0.9, 0.7, 0.5, 1]);
    // 4 成分の値を float3 で受けると先の 3 つ
    expect(val('float3 D : DIFFUSE;')).toEqual([0.9, 0.7, 0.5]);
    expect(val('float3 S : SPECULAR;')).toEqual([0.1, 0.2, 0.3]);
    expect(val('float P : SPECULARPOWER;')).toEqual([12]);
    expect(val('float3 T : TOONCOLOR;')).toEqual([0.6, 0.6, 0.6]);
    // トゥーンがなければ白
    expect(val('float3 T : TOONCOLOR;', withMat({ hasToon: false }))).toEqual([1, 1, 1]);
    expect(val('float4 E : EDGECOLOR;')).toEqual([0, 0, 0, 1]);
    expect(val('float4 G : GROUNDSHADOWCOLOR;')).toEqual([0, 0, 0, 0.5]);
    expect(val('float4 A : ADDINGTEXTURE;')).toEqual([0, 0, 0, 0]);
    expect(val('float4 A : MULTIPLYINGSPHERETEXTURE;')).toEqual([1, 1, 1, 1]);
  });

  it('ライトの値 (DIFFUSE は 0、AMBIENT・SPECULAR は色、DIRECTION は左手系)', () => {
    const ctx = makeCtx();
    expect(val('float3 D : DIFFUSE < string Object = "Light"; >;')).toEqual([0, 0, 0]);
    expect(val('float3 A : AMBIENT < string Object = "Light"; >;')).toEqual([0.5, 0.6, 0.7]);
    expect(val('float3 S : SPECULAR < string Object = "Light"; >;')).toEqual([0.5, 0.6, 0.7]);
    const d = ctx.light.direction;
    expect(val('float3 L : DIRECTION < string Object = "Light"; >;')).toEqual(close([d.x, d.y, -d.z]));
    // 位置は注視点から光の来る側 (−向き) へ離れた点 (左手系)
    const p = val('float3 L : POSITION < string Object = "Light"; >;');
    const dir = toMmdVec(d).normalize();
    expect(p).toEqual(close(toMmdVec(ctx.camera.target).sub(dir.multiplyScalar(LIGHT_DISTANCE)).toArray()));
  });

  it('3 成分の値を float4 で受けると 4 つ目は 1、値は MaterialState の配列と別物', () => {
    expect(val('float4 P : POSITION;')).toEqual([0, 10, 30, 1]);
    expect(val('float4 A : AMBIENT < string Object = "Light"; >;')).toEqual([0.5, 0.6, 0.7, 1]);
    const r = semanticValue(paramOf('float4 D : DIFFUSE;'), makeCtx());
    expect(r.kind === 'numbers' && r.values).toEqual(MAT.diffuse);
    expect(r.kind === 'numbers' && r.values).not.toBe(MAT.diffuse);
  });

  it('カメラの POSITION・DIRECTION (左手系)', () => {
    expect(val('float3 P : POSITION;')).toEqual([0, 10, 30]);
    expect(val('float3 P : POSITION < string Object = "Camera"; >;')).toEqual([0, 10, 30]);
    expect(val('float3 D : DIRECTION;')).toEqual(close([0, -10 / Math.sqrt(1000), -30 / Math.sqrt(1000)]));
  });

  it('shadow の pass では WORLD に地面の影の行列が掛かる', () => {
    const world = new Matrix4().makeTranslation(1, 3, 2);
    // 光 (1, −1, 0.5) → 左手系で (1, −1, −0.5)。物の原点 (1, 3, −2) を y = 0 に潰すと t = 3 で (4, 0, −3.5)、持ち上げて y = 0.01
    const ctx = { world, light: { ...makeCtx().light, direction: new Vector3(1, -1, 0.5) } };
    const shadow = val('float4x4 M : WORLD;', { ...ctx, pass: 'shadow' });
    const c = mulRow([0, 0, 0, 1], shadow);
    expect(c.map(x => x / c[3])).toEqual(close([4, 0.01, -3.5, 1]));
    // 別の pass では普通の WORLD
    expect(mulRow([0, 0, 0, 1], val('float4x4 M : WORLD;', { ...ctx, pass: 'object' }))).toEqual(close([1, 3, -2, 1]));
    // 合成の行列にも影の行列が入る
    const wv = mulRow([0, 0, 0, 1], val('float4x4 M : WORLDVIEW;', { ...ctx, pass: 'shadow' }));
    const v = viewLH(new Vector3(0, 10, 30), new Vector3(0, 0, 0), new Vector3(0, 1, 0));
    expect(wv).toEqual(close(new Vector4(4, 0.01, -3.5, 1).applyMatrix4(v).toArray()));
  });

  it('名前で決まる変数・TIME・VIEWPORTPIXELSIZE', () => {
    expect(val('bool parthf;')).toEqual([1]);
    expect(val('bool parthf;', { selfShadow: false })).toEqual([0]);
    expect(val('bool transp;', withMat({ transparent: true }))).toEqual([1]);
    expect(val('bool spadd;', withMat({ sphereAdd: true }))).toEqual([1]);
    expect(val('bool use_texture;')).toEqual([1]);
    expect(val('bool use_spheremap;')).toEqual([0]);
    expect(val('bool use_toon;')).toEqual([1]);
    expect(val('bool use_subtexture;')).toEqual([0]);
    expect(val('bool opadd;')).toEqual([0]);
    expect(val('bool use_texture;', { material: null })).toEqual([0]);
    expect(val('float t : TIME;')).toEqual([1.5]);
    expect(val('float t : ELAPSEDTIME;')).toEqual([0.25]);
    expect(val('float2 s : VIEWPORTPIXELSIZE;')).toEqual([640, 480]);
    // 名前は大文字小文字を区別する
    expect(semanticValue(paramOf('bool Parthf;'), makeCtx())).toEqual({ kind: 'none' });
  });

  it('非正方の行列は行ごとに R×C 個、材質がないとき (ポストエフェクト) は none', () => {
    const w = val('float4x4 M : WORLD;');
    const m43 = val('float4x3 M : WORLD;');
    expect(m43).toHaveLength(12);
    expect(m43.slice(3, 6)).toEqual(w.slice(4, 7));
    const m33 = val('float3x3 M : WORLD;');
    expect(m33).toEqual([...w.slice(0, 3), ...w.slice(4, 7), ...w.slice(8, 11)]);
    expect(semanticValue(paramOf('float4 D : DIFFUSE;'), makeCtx({ material: null, pass: null }))).toEqual({ kind: 'none' });
    // 行列はポストエフェクトでも計算できる
    expect(val('float4x4 M : VIEW;', { pass: null })).toHaveLength(16);
  });

  it('CONTROLOBJECT は control の値、なければ型の大きさの 0', () => {
    const decl = 'float mMultiLightP : CONTROLOBJECT<string name = "ray_controller.pmx"; string item = "MultiLight+";>;';
    const seen: unknown[] = [];
    const control = (ref: unknown) => { seen.push(ref); return [0.25]; };
    expect(val(decl, { control })).toEqual([0.25]);
    expect(seen).toEqual([{ param: 'mMultiLightP', name: 'ray_controller.pmx', item: 'MultiLight+', type: 'float' }]);
    expect(val(decl)).toEqual([0]);
    expect(val(decl, { control: () => null })).toEqual([0]);
    expect(val('float3 P : CONTROLOBJECT<string name = "(self)"; string item = "Position";>;')).toEqual([0, 0, 0]);
    expect(val('float3 P : CONTROLOBJECT<string name = "(self)"; string item = "Position";>;', { control: () => [1, 2, 3] })).toEqual([1, 2, 3]);
    expect(val('float4x4 M : CONTROLOBJECT<string name = "a.pmx";>;')).toEqual(Array.from({ length: 16 }, () => 0));
    // 型が合わない宣言 (float2 など) は項目にならず、control も呼ばれず、0 のまま
    expect(val('float2 P : CONTROLOBJECT<string name = "a.pmx";>;', { control })).toEqual([0, 0]);
    expect(seen).toHaveLength(1);
  });

  it('知らないものは none、マウスなどは unsupported', () => {
    const c = makeCtx();
    for (const s of ['MOUSEPOSITION', 'LEFTMOUSEDOWN', 'MIDDLEMOUSEDOWN', 'RIGHTMOUSEDOWN', 'TEXTUREVALUE']) {
      expect(semanticValue(paramOf(`float4 P : ${s};`), c).kind).toBe('unsupported');
    }
    expect(semanticValue(paramOf('float P : FOOBAR;'), c)).toEqual({ kind: 'none' });
    expect(semanticValue(paramOf('float P = 3;'), c)).toEqual({ kind: 'none' });
    expect(semanticValue(paramOf('float4 P : DIFFUSE < string Object = "Camera"; >;'), c)).toEqual({ kind: 'none' });
  });

  it('textureRole', () => {
    const role = (decl: string) => textureRole(compile(decl).textures[0]);
    expect(role('texture T : MATERIALTEXTURE;')).toBe('material');
    expect(role('texture T : MATERIALSPHEREMAP;')).toBe('sphere');
    expect(role('texture T : MATERIALTOONTEXTURE;')).toBe('toon');
    expect(role('texture2D T : RENDERCOLORTARGET < float2 ViewportRatio = {1, 1}; >;')).toBe('colorTarget');
    expect(role('texture2D T : RENDERDEPTHSTENCILTARGET < float2 ViewportRatio = {1, 1}; >;')).toBe('depthTarget');
    expect(role('texture2D T : OFFSCREENRENDERTARGET < float2 ViewportRatio = {1, 1}; >;')).toBe('unsupported');
    expect(role('texture2D T : ANIMATEDTEXTURE < string ResourceName = "a.gif"; >;')).toBe('unsupported');
    expect(role('texture2D T < string ResourceName = "a.png"; >;')).toBe('file');
    expect(role('texture2D T;')).toBe('none');
  });
});
