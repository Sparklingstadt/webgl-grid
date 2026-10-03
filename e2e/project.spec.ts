import { readFile } from 'node:fs/promises';
import { strFromU8, unzipSync } from 'fflate';
import { expect, test, type Page } from './fixtures/test';
import { makePmx } from './fixtures/pmx';
import { makeVmd } from './fixtures/vmd';
import { loadTestModel, open, uiState, type Win } from './helpers';

// プロジェクト (.wgp): いまの場面 (モデル・配置・マテリアル・キーフレーム・モーション・視点・タイムライン) を保存して開き直す

// 場面の中身を、比べられる形で取り出す
const snapshot = (page: Page) => page.evaluate(() => {
  const { engine } = window as Win, lib = engine.library;
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  type O = Win;
  return {
    objects: engine.world.objects.map((o: O) => ({
      s: o.s, x: r3(o.x), y: r3(o.y), z: r3(o.z), r: r3(o.r),
      slots: o.slots.map((id: string | null) => (id ? lib.materials.get(id).name : null)),
      name: o.s === 3 ? o.model.name : null,
      keys: o.keys ? [...o.keys.keys()].sort((a: number, b: number) => a - b) : null,
      keyMorph: o.keys?.get(20)?.morphs?.[0] ?? null,
      motion: o.motionFile?.name ?? null,
      hairHang: o.s === 3 ? engine.physics.hairHang(o) : null,
    })),
    materials: [...lib.materials.values()].filter((m: O) => lib.users(m.id) > 0).map((m: O) => ({
      name: m.name,
      nodes: m.tree.nodes.map((n: O) => n.type).sort(),
      base: m.tree.nodes.find((n: O) => n.type === 'principled').values.baseColor.map(r3),
      outline: m.outline.enabled,
    })).sort((a: O, b: O) => a.name.localeCompare(b.name)),
    clock: { start: engine.clock.start, end: engine.clock.end, frame: engine.clock.frame },
    cam: Object.fromEntries(Object.entries(engine.camera.cam).map(([k, v]) => [k, r3(v as number)])),
    selected: engine.world.objects.indexOf(engine.selection.current),
    physics: engine.physics.entries.length,
  };
});

// テスト用の場面: モデル (物理演算つき)・ダンス・キーフレーム・髪・マテリアル・積んだ形・視点・タイムライン
const VMD = Buffer.from(makeVmd([{ bone: 'センター', frame: 0, pos: [0, 0, 0] }, { bone: 'センター', frame: 60, pos: [0, 0, 5] }]));
const PMX = Buffer.from(makePmx('テスト人形', { physics: true }));
async function buildScene(page: Page) {
  await loadTestModel(page, [{ name: 'テスト.vmd', mimeType: 'application/octet-stream', buffer: VMD }], { physics: true });
  await expect.poll(() => page.evaluate(() => (window as Win).engine.physics.entries.length), { timeout: 30_000 }).toBe(1);
  await page.evaluate(() => {
    const { engine } = window as Win;
    const model = engine.selection.current;
    engine.clock.setPlaying(false); // (モーションを読むと再生が始まる)
    // キーフレーム (20 フレームは表情つき) と、髪を垂らす
    engine.clock.seekFrame(0); engine.insertKey();
    model.model.morphTargetInfluences[0] = 0.5;
    engine.clock.seekFrame(20); engine.insertKey();
    engine.setHairHang(true);
    // 立方体のマテリアルを変え、その上に球を積む
    const cube = engine.world.objects[0];
    engine.select(cube);
    engine.renameMaterial('木');
    engine.setNodeValue(engine.surfaceShader().id, 'baseColor', [1, 0, 0]);
    engine.setMaterialOutline({ enabled: true });
    engine.addShape(1);
    engine.placeShape(cube.x, cube.z);
    // 視点とタイムライン
    Object.assign(engine.camera.cam, { yaw: 1.2, pitch: 0.4, dist: 30 });
    engine.clock.setRange(5, 90);
    engine.clock.seekFrame(25);
    engine.select(model);
  });
}

test('保存したプロジェクトを開き直すと、同じ場面に戻る', async ({ page }) => {
  test.setTimeout(90_000);
  let errors = await open(page);
  await buildScene(page);
  const before = await snapshot(page);
  expect(before.objects.map((o: Win) => o.s)).toEqual([0, 3, 1, 1]);
  expect(before.objects[3].y).toBeGreaterThan(0); // 積んである

  // ファイル > プロジェクトを保存
  await page.getByRole('button', { name: 'ファイル' }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'プロジェクトを保存' }).click()]);
  expect(download.suggestedFilename()).toBe('プロジェクト.wgp');
  const path = (await download.path())!;
  // 中身: project.json と、読み込んだファイルそのもの
  const entries = unzipSync(new Uint8Array(await readFile(path)));
  const data = JSON.parse(strFromU8(entries['project.json']));
  expect(data.format).toBe('webgl-grid-project');
  expect(data.assets.map((a: { name: string }) => a.name).sort()).toEqual(['テスト.vmd', 'テスト人形.pmx']);
  expect(errors).toEqual([]);

  // まっさらなページで開き直す
  errors = await open(page);
  // (ダウンロードしたファイルは別の名前で置かれるので、保存した名前で選ぶ)
  await page.locator('input[type=file][accept=".wgp,.wgpj"]').setInputFiles({ name: download.suggestedFilename(), mimeType: 'application/zip', buffer: await readFile(path) });
  await page.waitForFunction(() => (window as Win).engine.ui.state.projectName === 'プロジェクト', undefined, { timeout: 30_000 });
  expect(await snapshot(page)).toEqual(before);
  await expect(page.locator('.title')).toHaveText('プロジェクト — webgl-grid');
  expect(errors).toEqual([]);
});

test('プロジェクトでないファイルは開かず、今の場面はそのまま', async ({ page }) => {
  await open(page);
  await page.locator('input[type=file][accept=".wgp,.wgpj"]').setInputFiles({ name: 'ちがう.wgp', mimeType: 'application/octet-stream', buffer: Buffer.from('not a zip') });
  await expect.poll(async () => (await uiState(page)).toast).toMatch(/^ちがう\.wgp を開けませんでした: プロジェクトのファイル/);
  expect(await page.evaluate(() => (window as Win).engine.world.objects.length)).toBe(1);
});

test('ファイルは参照だけ (.wgpj) で保存し、開くときに足りないファイルを選ぶ', async ({ page }) => {
  test.setTimeout(90_000);
  let errors = await open(page);
  await buildScene(page);
  const before = await snapshot(page);
  // ファイル > ファイルは参照だけで保存 (.wgpj): 小さな JSON で、ファイルの中身は入らない
  await page.getByRole('button', { name: 'ファイル' }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /参照だけで保存/ }).click()]);
  expect(download.suggestedFilename()).toBe('プロジェクト.wgpj');
  const json = await readFile((await download.path())!);
  const data = JSON.parse(json.toString('utf8'));
  expect(data.storage).toBe('reference');
  expect(data.assets.map((a: { name: string; size: number; path?: string }) => [a.name, a.size, a.path])).toEqual([
    ['テスト人形.pmx', PMX.length, undefined], ['テスト.vmd', VMD.length, undefined],
  ]);
  expect(json.length).toBeLessThan(20_000);
  const wgpj = { name: 'プロジェクト.wgpj', mimeType: 'application/json', buffer: json };

  // 同じページで開き直すときは、読み込んだファイルを覚えているので、そのまま開ける
  await page.locator('input[type=file][accept=".wgp,.wgpj"]').setInputFiles(wgpj);
  await expect.poll(async () => (await uiState(page)).toast).toBe('プロジェクト.wgpj を開きました');
  expect(await snapshot(page)).toEqual(before);

  // まっさらなページでは、足りないファイルを聞かれる。違う名前のファイルを選んでも対応づかず、もう一度聞かれる
  errors = await open(page);
  await page.locator('input[type=file][accept=".wgp,.wgpj"]').setInputFiles(wgpj);
  const dialog = page.getByRole('dialog', { name: 'ファイルを探す' });
  await expect(dialog.getByRole('list', { name: '見つからないファイル' }).getByRole('listitem')).toHaveCount(2);
  await dialog.getByLabel('ファイルを選ぶ').setInputFiles([{ name: 'テスト.vmd', mimeType: 'application/octet-stream', buffer: VMD }]);
  await expect(dialog.getByRole('listitem')).toHaveCount(1);
  await expect(dialog.getByRole('listitem')).toContainText('テスト人形.pmx');
  await dialog.getByLabel('ファイルを選ぶ').setInputFiles([{ name: 'テスト人形.pmx', mimeType: 'application/octet-stream', buffer: PMX }]);
  await expect(dialog).toHaveCount(0);
  await page.waitForFunction(() => (window as Win).engine.ui.state.projectName === 'プロジェクト', undefined, { timeout: 30_000 });
  expect(await snapshot(page)).toEqual(before);
  expect(errors).toEqual([]);

  // 「やめる」と、いまの場面はそのまま
  errors = await open(page);
  await page.locator('input[type=file][accept=".wgp,.wgpj"]').setInputFiles(wgpj);
  await page.getByRole('dialog', { name: 'ファイルを探す' }).getByRole('button', { name: /やめる/ }).click();
  await expect.poll(async () => (await uiState(page)).toast).toBe('プロジェクトを開くのをやめました');
  expect(await page.evaluate(() => (window as Win).engine.world.objects.length)).toBe(1);
  expect(errors).toEqual([]);
});
