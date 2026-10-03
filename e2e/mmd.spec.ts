import { expect, test } from './fixtures/test';
import { readFile } from 'node:fs/promises';
import { choose, keyFramesOf, loadTestModel, open, uiState, type Win } from './helpers';

// MMD モデル: 読み込み・表情・ボーン・キーフレーム・ポーズファイル (テスト用に組み立てた小さな PMX を使う)
const rightArmRz = (page: import('@playwright/test').Page) => page.evaluate(() => {
  const o = (window as Win).engine.selection.current;
  const i = o.model.skeleton.bones.findIndex((b: { name: string }) => b.name === '右腕');
  return o.pose?.get(i)?.rz ?? 0;
});

test.describe('MMD モデル', () => {
  test('読み込むと選ばれた状態で置かれ、オブジェクトのパネルに名前が出る', async ({ page }) => {
    const warnings: string[] = [];
    page.on('console', m => { if (m.type() === 'warning' && /THREE\./.test(m.text())) warnings.push(m.text()); });
    const errors = await open(page);
    await loadTestModel(page);
    expect((await uiState(page)).sel?.kind).toBe('model');
    await expect(page.locator('.prop')).toContainText('テスト人形');
    await expect(page.locator('.view-info')).toHaveText(/テスト人形/);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]); // (取り込んだ MMD の部品が「外される予定」の警告を出さない)
  });

  test('表情のスライダーでモーフを動かす', async ({ page }) => {
    await open(page);
    await loadTestModel(page);
    await page.getByRole('tab', { name: '表情' }).click();
    await expect(page.getByRole('tab', { name: '目' })).toHaveAttribute('aria-selected', 'true');
    const slider = page.getByRole('slider', { name: 'まばたき' });
    await slider.focus();
    await page.keyboard.press('Shift+ArrowRight');
    await expect(slider).toHaveAttribute('aria-valuenow', '0.1');
    expect(await page.evaluate(() => (window as Win).engine.selection.current.model.morphTargetInfluences[0])).toBeCloseTo(0.1);
    await page.getByRole('button', { name: '表情を戻す' }).click();
    await expect(slider).toHaveAttribute('aria-valuenow', '0');
  });

  test('ボーンを選んで回す', async ({ page }) => {
    await open(page);
    await loadTestModel(page);
    await page.getByRole('tab', { name: 'ボーン' }).click();
    const select = page.getByRole('combobox', { name: '動かすボーン' });
    await select.click();
    await expect(page.getByRole('listbox', { name: '動かすボーン' }).getByRole('option')).toHaveText(['センター', '右腕']);
    await page.getByRole('option', { name: '右腕', exact: true }).click();
    await expect(select).toHaveText('右腕');
    // 右腕は回転だけ (位置のスライダーはない)
    await expect(page.getByRole('slider', { name: '位置 X' })).toHaveCount(0);
    await page.getByRole('slider', { name: '回転 Z' }).focus();
    await page.keyboard.press('Shift+ArrowRight');
    expect(await rightArmRz(page)).toBe(10);
  });

  test('キーフレームを 2 つ打つと、あいだのフレームは補間され、Alt+I で消せる', async ({ page }) => {
    await open(page);
    await loadTestModel(page);
    await page.getByRole('tab', { name: 'ボーン' }).click();
    await choose(page, '動かすボーン', '右腕');
    const rz = page.getByRole('slider', { name: '回転 Z' });
    const frameField = page.getByRole('spinbutton', { name: 'いまのフレーム' });
    // フレーム 0 で 0°、フレーム 30 で 60°
    await page.getByRole('button', { name: '◆ キー挿入' }).click();
    await frameField.fill('30');
    await page.keyboard.press('Enter');
    await rz.focus();
    for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+ArrowRight');
    await page.locator('canvas#c').hover();
    await page.keyboard.press('i');
    expect(await keyFramesOf(page)).toEqual([0, 30]);
    // フレーム 15 では 30°
    await frameField.fill('15');
    await page.keyboard.press('Enter');
    await expect(rz).toHaveAttribute('aria-valuenow', /^(29\.9|30)/);
    expect(await rightArmRz(page)).toBeCloseTo(30, 3);
    // ↑ で次のキーフレーム (30) へ、そこで Alt+I で削除
    await page.locator('canvas#c').hover();
    await page.keyboard.press('ArrowUp');
    expect((await uiState(page)).frame).toBe(30);
    await page.keyboard.press('Alt+i');
    expect(await keyFramesOf(page)).toEqual([0]);
  });

  test('ボーンごとにキーを打ち、チャンネルの行と補間曲線で進み方を変える', async ({ page }) => {
    const errors = await open(page);
    await loadTestModel(page);
    await page.getByRole('tab', { name: 'ボーン' }).click();
    await choose(page, '動かすボーン', '右腕');
    const rz = page.getByRole('slider', { name: '回転 Z' });
    const frameField = page.getByRole('spinbutton', { name: 'いまのフレーム' });
    // 右腕だけに 0 と 30 のキー (30 では 60°)
    await page.getByRole('button', { name: '◆ このボーンにキー' }).click();
    await frameField.fill('30');
    await page.keyboard.press('Enter');
    await rz.focus();
    for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+ArrowRight');
    await page.getByRole('button', { name: '◆ このボーンにキー' }).click();
    expect(await page.evaluate(() => [...(window as Win).engine.selection.current.anim.bones.keys()].length)).toBe(1);
    // チャンネルの行を出す
    await page.getByRole('button', { name: /チャンネル/ }).click();
    expect(await page.evaluate(() => (window as Win).engine.timelineRows().map((r: { label: string }) => r.label))).toEqual(['テスト人形', '右腕']);
    // フレーム 30 のキーの補間曲線: 直線 → ゆっくり始まる。フレーム 15 の角度が小さくなる
    const panel = page.getByRole('group', { name: '補間曲線' });
    await expect(page.getByRole('combobox', { name: '補間曲線の形' })).toHaveText('直線');
    await frameField.fill('15');
    await page.keyboard.press('Enter');
    expect(await rightArmRz(page)).toBeCloseTo(30, 1);
    await frameField.fill('30');
    await page.keyboard.press('Enter');
    await choose(page, '補間曲線の形', 'ゆっくり始まる');
    await expect(panel).toBeVisible();
    await frameField.fill('15');
    await page.keyboard.press('Enter');
    expect(await rightArmRz(page)).toBeLessThan(20);
    // 曲線の点は矢印キーでも動く
    await frameField.fill('30');
    await page.keyboard.press('Enter');
    await page.getByRole('slider', { name: '補間曲線の点 1' }).focus();
    await page.keyboard.press('ArrowUp');
    expect(await page.evaluate(() => (window as Win).engine.selection.current.anim.bones.values().next().value.get(30).curve)).toEqual([0.42, 0.01, 1, 1]);
    expect(errors).toEqual([]);
  });

  test('ポーズを .vpd に保存し、読み込むと元に戻る', async ({ page }) => {
    await open(page);
    await loadTestModel(page);
    await page.getByRole('tab', { name: 'ボーン' }).click();
    await choose(page, '動かすボーン', '右腕');
    await page.getByRole('slider', { name: '回転 Z' }).focus();
    for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowRight');
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '保存', exact: true }).click()]);
    expect(download.suggestedFilename()).toBe('テスト人形.vpd');
    const bytes = await readFile((await download.path())!);
    const text = new TextDecoder('shift_jis').decode(bytes); // MMD と同じ Shift-JIS
    expect(text).toMatch(/^Vocaloid Pose Data file/);
    expect(text).toContain('Bone0{右腕');
    // 姿勢を戻してから、保存したファイルを読み込む
    await page.getByRole('button', { name: 'ポーズを戻す' }).click();
    expect(await rightArmRz(page)).toBe(0);
    await page.locator('input[accept=".vpd"]').setInputFiles({ name: 'pose.vpd', mimeType: 'application/octet-stream', buffer: bytes });
    await expect.poll(() => rightArmRz(page)).toBeCloseTo(30, 3);
  });

  test('ポーズファイルでないものは読み込まない', async ({ page }) => {
    await open(page);
    await loadTestModel(page);
    await page.locator('input[accept=".vpd"]').setInputFiles({ name: 'bad.vpd', mimeType: 'text/plain', buffer: Buffer.from('hello') });
    await expect.poll(async () => (await uiState(page)).toast).toContain('ポーズファイル (.vpd) ではない');
  });
});
