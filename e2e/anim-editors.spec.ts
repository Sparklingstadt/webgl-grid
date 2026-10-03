import { expect, test, type Page } from './fixtures/test';
import { choose, open, type Win } from './helpers';

// ドープシート (キーのある物すべて) とグラフエディター (チャンネルの値の曲線)
async function keyedScene(page: Page) {
  await page.evaluate(() => {
    const { engine } = window as Win;
    engine.addShape(1);
    const [a, b] = engine.world.objects;
    for (const [o, x] of [[a, 2], [b, -2]] as [Win, number][]) {
      engine.select(o);
      engine.clock.seekFrame(0); engine.insertKey();
      engine.clock.seekFrame(40); engine.setObjProp('x', o.x + x); engine.insertKey();
    }
    engine.clock.seekFrame(0);
    engine.select(a);
  });
}

test('ドープシート: キーのある物をすべて並べ、ほかの物の ◆ を押すとその物を選ぶ。アニメーションのワークスペースで出る', async ({ page }) => {
  await open(page);
  await keyedScene(page);
  await page.getByRole('tablist', { name: 'ワークスペース' }).getByRole('tab', { name: 'アニメーション' }).click();
  await expect(page.getByRole('region', { name: 'ドープシート' })).toBeVisible();
  expect(await page.evaluate(() => (window as Win).engine.timelineRows(true).map((r: Win) => [r.label, r.keys, r.active]))).toEqual([['立方体', [0, 40], true], ['トーラス', [0, 40], false]]);
  // トーラスの行のフレーム 40 の ◆ を押す
  const canvas = page.locator('#tl-canvas');
  const box = (await canvas.boundingBox())!;
  const at = await page.evaluate(([w]) => {
    // (タイムラインと同じ式: 見えている範囲は開始〜終了に合わせてある)
    const { engine } = window as Win, f0 = engine.clock.start - (engine.clock.end - engine.clock.start) * 0.04, f1 = engine.clock.end + (engine.clock.end - engine.clock.start) * 0.04;
    return (40 - f0) / (f1 - f0) * w;
  }, [box.width]);
  await page.mouse.click(box.x + at, box.y + 30 + 22 + 11);
  await expect.poll(() => page.evaluate(() => (window as Win).engine.ui.state.sel?.name)).toBe('トーラス');
});

test('グラフエディター: アクティブな物のチャンネルを曲線で描き、キーの点を上にドラッグすると値が増える', async ({ page }) => {
  await open(page);
  await keyedScene(page);
  await choose(page, 'エディターの種類', 'グラフエディター');
  await expect(page.getByRole('region', { name: 'グラフエディター' })).toBeVisible();
  await expect(page.getByRole('list', { name: '曲線' }).getByRole('button')).toHaveText(['位置 X', '位置 Z', '回転', '大きさ']);
  // 位置 X だけを出す
  for (const name of ['位置 Z', '回転', '大きさ']) await page.getByRole('list', { name: '曲線' }).getByRole('button', { name }).click();
  const key40 = () => page.evaluate(() => (window as Win).engine.world.objects[0].anim.props.get(0).get(40).v);
  const before = await key40();
  // フレーム 40 の点 (グラフの縦の上端の近く: 値の範囲の上の端) を探して、上へドラッグ
  const canvas = page.locator('.graph-canvas');
  const box = (await canvas.boundingBox())!;
  const pt = await page.evaluate(([w, h]) => {
    const { engine } = window as Win, s = engine.clock.start, e = engine.clock.end;
    const f0 = s - (e - s) * 0.04, f1 = e + (e - s) * 0.04;
    const x = (40 - f0) / (f1 - f0) * w;
    // 値は 0 → 2: 範囲は ±12% 広げてある
    const lo = 0 - 0.24, hi = 2 + 0.24, top = 22 + 14, bottom = h - 14;
    return { x, y: bottom - (2 - lo) / (hi - lo) * (bottom - top) };
  }, [box.width, box.height]);
  await page.mouse.move(box.x + pt.x, box.y + pt.y);
  await page.mouse.down();
  await page.mouse.move(box.x + pt.x, box.y + pt.y - 25, { steps: 3 });
  await page.mouse.up();
  expect(await key40()).toBeGreaterThan(before + 0.1);
});
