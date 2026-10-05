import type { Page } from '@playwright/test';
import { makePmx, type PmxOptions } from './fixtures/pmx';
import { open, type Win } from './helpers';

// MME 互換の e2e の道具: .fx を文字列から読む・テスト用の .pmx を置く・書き出した画像やビューポートの画素を読む

export type Rgba = [number, number, number, number];
export type Vec3 = [number, number, number];
export interface Camera { yaw: number; pitch: number; dist: number; tx?: number; ty?: number; tz?: number }

// 何も置かずに開き、レンダーエンジンを MME 互換にして、書き出しの大きさを決める
export async function openMme(page: Page, { width = 320, height = 240 } = {}) {
  const errors = await open(page, { cube: false });
  await page.evaluate(({ width, height }) => {
    const { engine } = window as Win;
    engine.mme.set({ engine: 'mme' });
    engine.output.set({ width, height });
  }, { width, height });
  return errors;
}

// カメラ (Blender の視点の回し方: yaw・pitch はラジアン、注視点 tx, ty, tz)
export async function setCamera(page: Page, c: Camera) {
  await page.evaluate(c => {
    const { engine } = window as Win;
    Object.assign(engine.camera.cam, { tx: 0, ty: 0, tz: 0, ...c });
    engine.viewport.requestDraw();
  }, c);
}

// 太陽 (場面の設定)。shadows は標準のエンジンの影
export async function setSun(page: Page, sun: { azimuthDeg?: number; elevationDeg?: number; shadows?: boolean }) {
  await page.evaluate(sun => (window as Win).engine.environment.set({ sun }), sun);
}

// テスト用の .pmx (makePmx) を、ほかのファイル (テクスチャなど) と一緒に engine.loadFiles で読み、(x, z) に置く。物の番号を返す。
// 面は MMD の決まりどおり外向きにする (outward)
export async function addPmx(page: Page, opts: PmxOptions & { name?: string; at?: [number, number]; files?: { name: string; base64: string }[] } = {}) {
  const { name = 'テスト人形', at = [0, 0], files = [], ...pmx } = opts;
  const bytes = Array.from(makePmx(name, { outward: true, ...pmx }));
  return page.evaluate(async ({ name, bytes, at, files }) => {
    const { engine } = window as Win;
    const list = [new File([new Uint8Array(bytes)], `${name}.pmx`)];
    for (const f of files) list.push(new File([Uint8Array.from(atob(f.base64), c => c.charCodeAt(0))], f.name));
    await engine.loadFiles(list, { askTextures: false });
    const i = engine.world.objects.length - 1;
    const o = engine.world.objects[i];
    [o.x, o.z] = at;
    engine.world.settle();
    for (const b of engine.world.objects) { b.py = b.y; b.vy = 0; } // (落ちてくるのを待たない)
    engine.viewport.requestDraw();
    return i;
  }, { name, bytes, at, files });
}

// 形 s を (x, z) に置く。物の番号を返す
export async function addShape(page: Page, s: number, at: [number, number], color = 0) {
  return page.evaluate(({ s, at, color }) => {
    const { engine } = window as Win;
    engine.world.addShape(s, at[0], at[1], color);
    for (const b of engine.world.objects) { b.py = b.y; b.vy = 0; }
    engine.viewport.requestDraw();
    return engine.world.objects.length - 1;
  }, { s, at, color });
}

// .fx の文字列を読んで (フォルダ fx の中の name)、物 i に割り当てる。コンパイルできたかを返す
export async function assignFx(page: Page, i: number, source: string, name = 'test.fx') {
  return page.evaluate(async ({ i, source, name }) => {
    const { engine } = window as Win;
    const file = new File([source], name);
    Object.defineProperty(file, 'webkitRelativePath', { value: `fx/${name}` });
    const e = await engine.mme.loadEffect([file], name);
    engine.mme.store.setObjectEffect(engine.world.objects[i].id, e);
    return e.result.ok as boolean;
  }, { i, source, name });
}

// ポストエフェクトの .fx の文字列を読んで (フォルダ post の中の name)、一覧の最後 (いちばん外側) に足す。コンパイルできたかを返す
export async function addPost(page: Page, source: string, name = 'post.fx') {
  return page.evaluate(async ({ source, name }) => {
    const { engine } = window as Win;
    const file = new File([source], name);
    Object.defineProperty(file, 'webkitRelativePath', { value: `post/${name}` });
    const e = await engine.mme.loadEffect([file], name);
    engine.mme.store.addPost(e);
    return e.result.ok as boolean;
  }, { source, name });
}

// 位置だけ変換して、決まった色を出す物の .fx (MMDPass = object だけ。ほかの pass は default.fx)
export const objectFx = (ps: string, decls = '') => `
float4x4 WVP : WORLDVIEWPROJECTION;
${decls}
struct VO { float4 Pos : POSITION; float2 Uv : TEXCOORD0; };
VO VS(float4 Pos : POSITION, float2 Uv : TEXCOORD0) { VO o; o.Pos = mul(Pos, WVP); o.Uv = Uv; return o; }
float4 PS(float2 Uv : TEXCOORD0) : COLOR0 { ${ps} }
technique T < string MMDPass = "object"; > { pass P { VertexShader = compile vs_3_0 VS(); PixelShader = compile ps_3_0 PS(); } }
`;

// 描いた絵と、そのときのカメラで世界の点を写した画素の位置の色。png: 書き出し (engine.output.renderPng)、viewport: ビューポートの canvas。
// image: 絵の全部の画素 (RGBA の並び) も返す
export async function shoot(page: Page, where: 'png' | 'viewport', points: Vec3[] = [], image = false) {
  return page.evaluate(async ({ where, points, image }) => {
    const w = window as Win, { engine, THREE } = w;
    const camera = engine.graph.camera;
    let proj: Win = null, view: Win = null;
    // (書き出しでは画角が変わるので、描いた直後のカメラを使う)
    const off = engine.viewport.onRender(() => { proj = camera.projectionMatrix.clone(); view = camera.matrixWorldInverse.clone(); });
    let src: CanvasImageSource, width: number, height: number;
    const c = document.createElement('canvas');
    try {
      if (where === 'png') {
        const bmp = await createImageBitmap(await engine.output.renderPng());
        [src, width, height] = [bmp, bmp.width, bmp.height];
      } else {
        engine.viewport.render();
        const canvas = engine.viewport.canvas as HTMLCanvasElement;
        [src, width, height] = [canvas, canvas.width, canvas.height];
      }
      Object.assign(c, { width, height });
      c.getContext('2d')!.drawImage(src, 0, 0); // (WebGL の絵は、描いた直後に写す)
    } finally {
      off();
    }
    const data = c.getContext('2d')!.getImageData(0, 0, width, height).data;
    const at = (x: number, y: number) => {
      const i = (Math.min(Math.max(y, 0), height - 1) * width + Math.min(Math.max(x, 0), width - 1)) * 4;
      return [data[i], data[i + 1], data[i + 2], data[i + 3]];
    };
    const pos = points.map(p => {
      const v = new THREE.Vector3(...p).applyMatrix4(view).applyMatrix4(proj);
      return [Math.floor((v.x + 1) / 2 * width), Math.floor((1 - v.y) / 2 * height)];
    });
    return {
      width, height, pos,
      pixels: pos.map(([x, y]) => at(x, y)),
      data: image ? Array.from(data) : [],
    };
  }, { where, points, image }) as Promise<{ width: number; height: number; pos: [number, number][]; pixels: Rgba[]; data: number[] }>;
}

// RGB の差の最大
export const diff = (a: number[], b: number[]) => Math.max(...[0, 1, 2].map(k => Math.abs(a[k] - b[k])));

// 上半分が赤・下半分が青の 64×64 の PNG (base64)
export async function redBluePng(page: Page) {
  return page.evaluate(async () => {
    const c = Object.assign(document.createElement('canvas'), { width: 64, height: 64 });
    const g = c.getContext('2d')!;
    g.fillStyle = '#ff0000';
    g.fillRect(0, 0, 64, 32);
    g.fillStyle = '#0000ff';
    g.fillRect(0, 32, 64, 32);
    const blob = await new Promise<Blob>(ok => c.toBlob(b => ok(b!), 'image/png'));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  });
}
