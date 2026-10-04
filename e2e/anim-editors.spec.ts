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

test('グラフエディター: キーの点を右へドラッグするとそのチャンネルのキーだけが後ろのフレームへ動き、押したキーのハンドルで補間曲線を変える', async ({ page }) => {
  await open(page);
  await keyedScene(page);
  await choose(page, 'エディターの種類', 'グラフエディター');
  for (const name of ['位置 Z', '回転', '大きさ']) await page.getByRole('list', { name: '曲線' }).getByRole('button', { name }).click();
  const canvas = page.locator('.graph-canvas');
  const box = (await canvas.boundingBox())!;
  // フレーム f・値 val の、キャンバスの中の位置 (値の範囲は、位置 X の 0〜2 を ±12% 広げたもの)
  const at = (f: number, val: number) => page.evaluate(([f, val, w, h]) => {
    const { engine } = window as Win, s = engine.clock.start, e = engine.clock.end;
    const f0 = s - (e - s) * 0.04, f1 = e + (e - s) * 0.04;
    const lo = 0 - 0.24, hi = 2 + 0.24, top = 22 + 14, bottom = h - 14;
    return { x: (f - f0) / (f1 - f0) * w, y: bottom - (val - lo) / (hi - lo) * (bottom - top) };
  }, [f, val, box.width, box.height]);
  const xKeys = () => page.evaluate(() => [...(window as Win).engine.world.objects[0].anim.props.get(0).keys()].sort((a: number, b: number) => a - b));
  // フレーム 40 の点を、フレーム 60 の所まで右へ (値はそのまま)
  const p40 = await at(40, 2), p60 = await at(60, 2);
  await page.mouse.move(box.x + p40.x, box.y + p40.y);
  await page.mouse.down();
  await page.mouse.move(box.x + p60.x, box.y + p40.y, { steps: 6 });
  await page.mouse.up();
  expect(await xKeys()).toEqual([0, 60]);
  expect(await page.evaluate(() => [...(window as Win).engine.world.objects[0].anim.props.get(1).keys()].sort((a: number, b: number) => a - b))).toEqual([0, 40]); // (ほかのチャンネルはそのまま)
  // 押したキー (60) の 2 つ目のハンドル (直線: 0.75 の所) を左へ
  const curve = () => page.evaluate(() => [...(window as Win).engine.world.objects[0].anim.props.get(0).get(60).curve]);
  expect(await curve()).toEqual([0.25, 0.25, 0.75, 0.75]);
  const v60 = await page.evaluate(() => (window as Win).engine.world.objects[0].anim.props.get(0).get(60).v);
  const h2 = await at(0.75 * 60, 0.75 * v60);
  await page.mouse.move(box.x + h2.x, box.y + h2.y);
  await page.mouse.down();
  await page.mouse.move(box.x + h2.x - 40, box.y + h2.y, { steps: 4 });
  await page.mouse.up();
  const [x1, y1, x2] = await curve();
  expect([x1, y1]).toEqual([0.25, 0.25]);
  expect(x2).toBeLessThan(0.7);
  // 元に戻すと、曲線 → フレームの順に戻る
  await page.keyboard.press('Control+z');
  await expect.poll(curve).toEqual([0.25, 0.25, 0.75, 0.75]);
  await page.keyboard.press('Control+z');
  await expect.poll(xKeys).toEqual([0, 40]);
});
