import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { listFx, resolveFxFile } from '../mcp/fx.ts';
import type { Page } from './fixtures/test';
import type { Win } from './helpers';

// 手元だけの e2e (本物の Ray-MMD 1.5.2。Git に入れない fx/ray-mmd-1.5.2/) の道具: 場所・テスト用のモデルの材質の分け方・
// fx/ の一覧をページに渡す・描いたときの警告など・書き出した PNG の明るさ

export const FX_ROOT = path.resolve('fx'); // (ふだんの fx/。e2e のサーバーは WEBGL_GRID_FX_DIR でテスト用のフォルダを渡している)
export const RAY_FOLDER = 'ray-mmd-1.5.2';
export const RAY_ROOT = path.join(FX_ROOT, RAY_FOLDER);
export const HAS_RAY = existsSync(path.join(RAY_ROOT, 'ray.fx'));
export const RAY_SKIP = 'fx/ray-mmd-1.5.2 がない (Ray-MMD 1.5.2 を置いたときだけ動く)';
export const RAY_OUT = path.resolve('test-results/ray-mmd'); // 絵の置き場所 (目で比べるため)

export const SKY = 'Skybox/Time of day/Time of day.pmx';

// テスト用のモデル (makePmx の四角柱) の面を 3 つの材質に分ける: 前と右の面・後ろと左の面・上と下
export function threeParts() {
  const inward = [0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7, 4, 5, 6, 4, 6, 7, 0, 2, 1, 0, 3, 2];
  const outward = inward.map((_, k) => inward[k % 3 === 0 ? k : k % 3 === 1 ? k + 1 : k - 1]);
  return [outward.slice(0, 12), outward.slice(12, 24), outward.slice(24)].map(faces => ({ faces, edgeSize: 0 }));
}

// ページが聞く fx/ の一覧とファイル (__fx・__fx/file) に、ふだんの fx/ から答える (サーバーと同じ mcp/fx.ts で)。
// (e2e のサーバーの WEBGL_GRID_FX_DIR はほかのテストと共有のテスト用のフォルダで、そのテストが消したり作ったりするので、そこには置かない)
export async function serveFx(page: Page, dir = FX_ROOT) {
  await page.route('**/__fx', async route => route.fulfill({ json: await listFx(dir) }));
  await page.route('**/__fx/file*', async route => {
    const file = await resolveFxFile(new URL(route.request().url()).searchParams.get('path') ?? '', dir);
    if (!file) return route.fulfill({ status: 404 });
    await route.fulfill({
      body: readFileSync(file), contentType: 'application/octet-stream',
      headers: { 'last-modified': statSync(file).mtime.toUTCString(), 'cache-control': 'no-store' },
    });
  });
}

// 描いたときの警告とコンパイルの警告、止めたエフェクト (リンクの失敗・レンダーターゲットを作れない)、コンパイルできないエフェクト
export async function problems(page: Page) {
  return page.evaluate(() => {
    const { engine } = window as Win, { mme } = engine;
    const drawn = mme.renderer.drawnEffects();
    return {
      warnings: mme.renderer.allWarnings() as string[],
      uiWarnings: engine.ui.state.mme.warnings as string[],
      compile: drawn.flatMap((e: Win) => e.result.warnings.map((d: Win) => `${e.name}: ${d.file}:${d.line} ${d.message}`)) as string[],
      failed: drawn.filter((e: Win) => !e.result.ok).map((e: Win) => `${e.name}: ${e.result.errors.slice(0, 3).map((d: Win) => `${d.file}:${d.line} ${d.message}`).join(' / ')}`) as string[],
      stopped: mme.renderer.stoppedEffects().map((e: Win) => e.name) as string[],
      drawn: drawn.map((e: Win) => e.name) as string[],
      tabs: mme.renderer.offscreenTabs().map((t: Win) => t.name) as string[],
    };
  });
}
// 「未対応」の警告 (対応していない・止めた・使えない・見つからない・できない・読めない)
export const unsupported = (list: string[]) => list.filter(w => /対応|止め|使えない|見つからない|できない|読めない/.test(w));

// PNG (base64) の平均の明るさ (0〜1) と、絵の上の位置 (幅・高さに対する割合) のまわり (r 画素四方) の平均の明るさと、赤と青の平均
export async function pngStats(page: Page, base64: string, image: [number, number][], r = 4) {
  return page.evaluate(async ({ base64, image, r }) => {
    const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], { type: 'image/png' }));
    const c = Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
    const g = c.getContext('2d')!;
    g.drawImage(bmp, 0, 0);
    const avg = (x: number, y: number, w: number, h: number) => {
      const d = g.getImageData(x, y, w, h).data;
      let red = 0, green = 0, blue = 0;
      for (let i = 0; i < d.length; i += 4) { red += d[i]; green += d[i + 1]; blue += d[i + 2]; }
      const n = d.length / 4 * 255;
      return { mean: (red + green + blue) / 3 / n, r: red / n, b: blue / n };
    };
    const patches = image.map(([fx, fy]) => avg(Math.max(Math.floor(fx * bmp.width) - r, 0), Math.max(Math.floor(fy * bmp.height) - r, 0), 2 * r + 1, 2 * r + 1));
    return { width: bmp.width, height: bmp.height, mean: avg(0, 0, bmp.width, bmp.height).mean, image: patches };
  }, { base64, image, r });
}
