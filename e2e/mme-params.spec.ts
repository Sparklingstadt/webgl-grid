import { expect, test, type Page } from './fixtures/test';
import { addPmx, assignFx, diff, objectFx, openMme, setCamera, shoot, type Vec3 } from './mme-helpers';
import type { Win } from './helpers';

// .fx のパラメータの値 (設計書「パラメータ」): 「.fx を当てた物」と「.fx」の組ごとの値で、描くたびに uniform を上書きする。
// 書き出しは 320×240 (openMme の既定)。テスト用の .pmx は 4×20×4 の四角柱 (置くと x, z が ±0.2、高さ 2)

const FACE: Vec3 = [0, 1, 0.2]; // 箱の前の面の真ん中
const COL_FX = objectFx('return float4(Col, 1.0);', 'float3 Col < string UIWidget = "Color"; > = {1, 0, 0};');

const rgb = (p: number[]) => p.slice(0, 3);
const warnings = (page: Page) => page.evaluate(() => (window as Win).engine.mme.renderer.allWarnings() as string[]);

// 箱を 1 つ置いて Col で色を出す .fx を当て、+z から見る
async function colBox(page: Page) {
  await setCamera(page, { yaw: Math.PI / 2, pitch: 0.05, dist: 4.5, ty: 1 });
  const i = await addPmx(page, { flags: 0 });
  expect(await assignFx(page, i, COL_FX, 'col.fx')).toBe(true);
  return i;
}

test('パラメータ Col (UIWidget = "Color") を setParam で緑にすると、物が緑になる', async ({ page }) => {
  const errors = await openMme(page);
  const i = await colBox(page);
  expect(rgb((await shoot(page, 'png', [FACE])).pixels[0])).toEqual([255, 0, 0]); // (初期値)
  const params = await page.evaluate(i => {
    const { engine } = window as Win;
    const obj = engine.world.objects[i];
    const [{ effect }] = engine.mme.paramsOf(obj);
    engine.mme.setParam(obj, effect.folder, effect.path, 'Col', [0, 1, 0]);
    return engine.mme.paramsOf(obj)[0].params;
  }, i);
  expect(params).toEqual([{ name: 'Col', label: 'Col', type: 'float3', init: [1, 0, 0], min: 0, max: 2, color: true, value: [0, 1, 0] }]);
  expect(rgb((await shoot(page, 'png', [FACE])).pixels[0])).toEqual([0, 255, 0]);
  expect(await warnings(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('パラメータのキーフレームで、書き出した動画の最初のコマと最後のコマの色が違う', async ({ page }) => {
  const errors = await openMme(page);
  const i = await colBox(page);
  const frames = await page.evaluate(async i => {
    const { engine } = window as Win;
    const obj = engine.world.objects[i];
    const [{ effect }] = engine.mme.paramsOf(obj);
    const channels = ['x', 'y', 'z'].map(c => `${effect.folder}/${effect.path}:Col:${c}`);
    engine.clock.setRange(0, 10);
    engine.clock.seekFrame(0); engine.mme.setParam(obj, effect.folder, effect.path, 'Col', [1, 0, 0]); engine.keyframes.insertMme(obj, 0, channels);
    engine.clock.seekFrame(10); engine.mme.setParam(obj, effect.folder, effect.path, 'Col', [0, 0, 1]); engine.keyframes.insertMme(obj, 10, channels);
    engine.clock.seekFrame(5);
    // 書き出す各コマの絵 (動画に入れる前の絵) の真ん中の画素
    const out = engine.output as Win;
    const flatten = out.flatten.bind(out);
    const colors: number[][] = [];
    out.flatten = (to: HTMLCanvasElement) => {
      flatten(to);
      const d = to.getContext('2d')!.getImageData(to.width >> 1, to.height >> 1, 1, 1).data;
      colors.push([d[0], d[1], d[2]]);
    };
    try {
      await engine.output.renderVideo();
    } finally {
      out.flatten = flatten;
    }
    return colors;
  }, i);
  expect(frames).toHaveLength(11);
  const first = frames[0], last = frames[frames.length - 1];
  expect(diff(first, [255, 0, 0]), `${first}`).toBeLessThanOrEqual(2);
  expect(diff(last, [0, 0, 255]), `${last}`).toBeLessThanOrEqual(2);
  expect(await warnings(page)).toEqual([]);
  expect(errors).toEqual([]);
});
