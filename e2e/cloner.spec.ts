import { expect, test, type Page } from './fixtures/test';
import { makeVmd } from './fixtures/vmd';
import { choose, loadTestModel, open, screenPosOf, type Win } from './helpers';

// クローナー (Cinema 4D のクローナー)
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const steps = (page: Page) => page.evaluate(() => (window as Win).engine.ui.state.history.labels.length);
const cloneCount = (page: Page) => page.evaluate(() => (window as Win).engine.world.objects[0].node.getObjectByName('__clones')?.children.length ?? 0);

test('形をクローナーにしてグリッドに並べ、クローンを押すと選ばれ、元に戻せ、1 つずつの物にできる', async ({ page }) => {
  const errors = await open(page);
  const p = await screenPosOf(page, 0);
  await page.mouse.click(p.x, p.y);
  await page.getByRole('checkbox', { name: 'クローナーにする' }).click();
  await expect(page.getByText('クローン 9 個')).toBeVisible(); // 既定: グリッド 3 × 1 × 3
  await expect.poll(() => steps(page)).toBe(2); // (続けて素早く変えると 1 手にまとまるので、手が積まれるのを待つ)
  expect(await cloneCount(page)).toBe(9);
  // 数を変える
  await page.getByRole('spinbutton', { name: '数 X' }).fill('2');
  await page.keyboard.press('Enter');
  await expect(page.getByText('クローン 6 個')).toBeVisible();
  await expect.poll(() => steps(page)).toBe(3);
  // 直線にする
  await choose(page, 'クローナーの並べ方', '直線');
  await expect(page.getByText('クローン 5 個')).toBeVisible();
  await expect.poll(() => steps(page)).toBe(4);
  // 何もない所を押して選択を外し、クローン (2 つめ) を押すと、元の物が選ばれる
  await page.mouse.click(60, 200);
  await expect.poll(() => page.evaluate(() => (window as Win).engine.ui.state.sel)).toBeNull();
  const second = await page.evaluate(() => {
    const { engine, THREE } = window as Win;
    const g = engine.world.objects[0].node.getObjectByName('__clones').children[1];
    const v = g.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.5, 0)).project(engine.graph.camera);
    const r = engine.viewport.canvas.getBoundingClientRect();
    return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
  });
  await page.mouse.click(second.x, second.y);
  await expect.poll(() => page.evaluate(() => (window as Win).engine.ui.state.sel?.name)).toBe('立方体');
  // 元に戻すと、クローナーにする前へ (並べ方の変更も 1 手ずつ)
  await page.keyboard.press(`${mod}+z`);
  await page.keyboard.press(`${mod}+z`);
  await page.keyboard.press(`${mod}+z`);
  await expect.poll(() => cloneCount(page)).toBe(0);
  await page.keyboard.press(`${mod}+Shift+z`);
  await expect.poll(() => cloneCount(page)).toBe(9);
  // 1 つずつの物にする
  await page.getByRole('button', { name: '1 つずつの物にする' }).click();
  await expect.poll(() => page.evaluate(() => (window as Win).engine.world.objects.length)).toBe(9);
  expect(await page.evaluate(() => (window as Win).engine.world.objects.every((o: Win) => !o.cloner))).toBe(true);
  expect(errors).toEqual([]);
});

test('MMD モデルをクローナーにすると、クローンも同じ動きをする (骨を写す)', async ({ page }) => {
  const errors = await open(page);
  const vmd = makeVmd([{ bone: 'センター', frame: 0, pos: [0, 0, 0] }, { bone: 'センター', frame: 30, pos: [0, 0, 6] }]);
  await loadTestModel(page, [{ name: 'テスト.vmd', mimeType: 'application/octet-stream', buffer: Buffer.from(vmd) }], { physics: true });
  await expect.poll(() => page.evaluate(() => (window as Win).engine.physics.entries.length), { timeout: 30_000 }).toBe(1);
  await page.evaluate(() => {
    const { engine } = window as Win;
    engine.clock.setPlaying(false);
    engine.setCloner({ mode: 'linear', count: 3, step: [2, 0, 0] });
    engine.clock.seekFrame(15);
  });
  // 描いたあと: どのクローンの骨も、元のモデルの骨と同じ (ローカルの) 位置・回転
  const diff = await page.evaluate(async () => {
    const { engine } = window as Win;
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const m = engine.world.models[0];
    const src = m.model.skeleton.bones;
    let worst = 0;
    for (const g of m.node.getObjectByName('__clones').children) {
      const bones = g.children[0].skeleton.bones;
      src.forEach((b: Win, i: number) => { worst = Math.max(worst, b.position.distanceTo(bones[i].position), 1 - Math.abs(b.quaternion.dot(bones[i].quaternion))); });
    }
    // 元のモデルの骨が、最初の姿勢から動いている (モーション) こと
    const rest = m.model.userData.rest;
    const moved = Math.max(...src.map((b: Win, i: number) => b.position.distanceTo(rest[i].p)));
    return { worst, moved, clones: engine.cloners.count(m), hidden: !m.model.visible };
  });
  expect(diff.clones).toBe(3);
  expect(diff.hidden).toBe(true);
  expect(diff.moved).toBeGreaterThan(0.5); // モーションで動いている (それがクローンにも写っている)
  expect(diff.worst).toBeLessThan(1e-6);
  // MMD モデルは 1 つずつの物にはできない (ボタンを出さない)
  await page.getByRole('tab', { name: 'オブジェクト' }).click();
  await expect(page.getByRole('button', { name: '1 つずつの物にする' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('エフェクタ: ステップで 1 つずつ大きく、ディレイで MMD モデルのクローンが遅れて動く', async ({ page }) => {
  const errors = await open(page);
  const p = await screenPosOf(page, 0);
  await page.mouse.click(p.x, p.y);
  await page.getByRole('checkbox', { name: 'クローナーにする' }).click();
  await choose(page, 'クローナーの並べ方', '直線');
  await page.getByRole('button', { name: '+ ステップ' }).click();
  const group = page.getByRole('group', { name: 'エフェクタ 1 ステップ' });
  await group.getByRole('spinbutton', { name: 'ステップの大きさ' }).fill('3');
  await page.keyboard.press('Enter');
  const scales = () => page.evaluate(() => (window as Win).engine.world.objects[0].node.getObjectByName('__clones').children.map((g: Win) => +g.scale.x.toFixed(2)));
  await expect.poll(scales).toEqual([1, 1.5, 2, 2.5, 3]);
  // オフにすると効かない
  await group.getByRole('checkbox', { name: 'ステップ' }).click();
  await expect.poll(scales).toEqual([1, 1, 1, 1, 1]);

  // MMD モデル + ディレイ: 再生すると、クローンごとに違う姿勢 (遅れ)
  const vmd = makeVmd([{ bone: 'センター', frame: 0, pos: [0, 0, 0] }, { bone: 'センター', frame: 30, pos: [0, 0, 6] }]);
  await loadTestModel(page, [{ name: 'テスト.vmd', mimeType: 'application/octet-stream', buffer: Buffer.from(vmd) }]);
  const spread = await page.evaluate(async () => {
    const { engine } = window as Win;
    const m = engine.world.models[0];
    engine.select(m);
    engine.setCloner({ mode: 'linear', count: 3, step: [2, 0, 0], effectors: [{ kind: 'delay', enabled: true, position: [0, 0, 0], rotationDeg: 0, scale: 1, frames: 8 }] });
    engine.clock.seekFrame(0);
    engine.clock.setPlaying(true);
    await new Promise<void>(r => { const f = () => (engine.clock.frame >= 20 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
    engine.clock.setPlaying(false);
    await new Promise(r => requestAnimationFrame(r));
    const i = m.model.skeleton.bones.findIndex((b: Win) => b.name === 'センター');
    return m.node.getObjectByName('__clones').children.map((g: Win) => +g.children[0].skeleton.bones[i].position.z.toFixed(2));
  });
  // 遅れているクローンほど、センターがまだ前へ出ていない (z の動きが小さい)
  expect(Math.abs(spread[0])).toBeGreaterThan(Math.abs(spread[1]));
  expect(Math.abs(spread[1])).toBeGreaterThan(Math.abs(spread[2]));
  expect(errors).toEqual([]);
});
