import { expect, test, type Page } from '@playwright/test';
import { makeVmd } from './fixtures/vmd';
import { loadTestModel, open, type Win } from './helpers';

// MMD の物理演算: モーションのあるモデルで、タイムラインを飛んだり繰り返したりしても、剛体がボーンから離れないこと。
// (剛体を置き直すときに、縮小したモデルの座標のまま置いて遠くへ飛ばし、髪とスカートが絡まって巻き上がる不具合があった)

// 物理演算で動く剛体と、そのボーンとの、モデルの座標 (MMD の単位) での一番大きな距離
const worstGap = (page: Page) => page.evaluate(() => {
  const { engine, THREE } = window as Win;
  const p = engine.physics.entries[0];
  const mesh = p.obj.model, parent = mesh.parent, scale = mesh.scale.clone();
  mesh.parent = null;
  mesh.scale.set(1, 1, 1);
  mesh.updateMatrixWorld(true);
  let worst = 0;
  for (const b of p.physics.bodies) {
    if (b.params.type === 0) continue;
    const o = b.body.getCenterOfMassTransform().getOrigin();
    const bone = b.bone.getWorldPosition(new THREE.Vector3());
    worst = Math.max(worst, Math.hypot(o.x() - bone.x, o.y() - bone.y, o.z() - bone.z));
  }
  mesh.parent = parent;
  mesh.scale.copy(scale);
  p.obj.node.updateMatrixWorld(true);
  return worst;
});

test('タイムラインを飛んでも・繰り返しても、物理演算の剛体がボーンから離れない', async ({ page }) => {
  test.slow(); // 物理エンジン (Ammo.js) を CDN から読む
  const errors = await open(page);
  // センターを前後に大きく動かすモーション (0 → 30 フレームで 10 進み、60 フレームで戻る)
  const vmd = makeVmd([
    { bone: 'センター', frame: 0, pos: [0, 0, 0] },
    { bone: 'センター', frame: 30, pos: [0, 0, 10] },
    { bone: 'センター', frame: 60, pos: [0, 0, 0] },
  ]);
  await loadTestModel(page, [{ name: 'テスト.vmd', mimeType: 'application/octet-stream', buffer: Buffer.from(vmd) }], { physics: true });
  await expect.poll(() => page.evaluate(() => (window as Win).engine.physics.entries.length), { timeout: 30_000 }).toBe(1);
  await expect.poll(() => page.evaluate(() => (window as Win).engine.clock.end)).toBe(60);
  // 右腕の剛体は、ボーンから 2 (MMD の単位) 離れた所に付いている。関節で少し揺れても 5 より離れない
  const LIMIT = 5;
  expect(await worstGap(page)).toBeLessThan(LIMIT);
  for (const f of [30, 0, 45, 15]) {
    await page.evaluate(f => { const { engine } = window as Win; engine.clock.setPlaying(false); engine.clock.seekFrame(f); }, f);
    expect(await worstGap(page), `フレーム ${f} へ飛んだあと`).toBeLessThan(LIMIT);
  }
  // 最後 (60 フレーム) の少し前から再生して、最初に戻ったあと
  await page.evaluate(() => { const { engine } = window as Win; engine.clock.seekFrame(55); engine.clock.setPlaying(true); });
  await expect.poll(() => page.evaluate(() => (window as Win).engine.clock.frame), { timeout: 20_000 }).toBeLessThan(30);
  expect(await worstGap(page), '繰り返したあと').toBeLessThan(LIMIT);
  expect(errors).toEqual([]);
});

// 髪の剛体の横の位置 (モデルの座標。頭が 0)
const hairX = (page: Page) => page.evaluate(() => {
  const { engine } = window as Win;
  const b = engine.physics.entries[0].physics.bodies.find((b: { params: { name: string } }) => b.params.name === '髪剛体');
  return b.body.getCenterOfMassTransform().getOrigin().x();
});

test('「髪を重力で垂らす」で、髪の錘を外して垂らし、オフで元の形に戻す', async ({ page }) => {
  test.slow(); // 物理エンジン (Ammo.js) を CDN から読む
  const errors = await open(page);
  await loadTestModel(page, [], { physics: true });
  const toggle = page.getByRole('checkbox', { name: '髪を重力で垂らす' });
  await expect(toggle).toBeVisible({ timeout: 30_000 }); // 錘のある髪が見つかったら出る
  await expect(toggle).not.toBeChecked();
  // 錘があるあいだは、髪は頭から 45° 外へ伸びたまま (x = 3)
  await page.waitForTimeout(1000);
  expect(await hairX(page)).toBeGreaterThan(2.5);
  // 錘を外すと、関節の動ける範囲 (0.6 ラジアン) まで垂れる
  await toggle.check();
  await expect.poll(() => hairX(page), { timeout: 10_000 }).toBeLessThan(1.5);
  expect(await page.evaluate(() => (window as Win).engine.ui.state.hairHang)).toBe(true);
  // 錘を戻すと、元の形に戻る
  await toggle.uncheck();
  await expect.poll(() => hairX(page), { timeout: 10_000 }).toBeGreaterThan(2.5);
  expect(errors).toEqual([]);
});

test('髪の形を保つ錘がないモデルには、スイッチを出さない', async ({ page }) => {
  await open(page);
  await loadTestModel(page); // 剛体のないモデル
  await expect(page.locator('.prop')).toContainText('テスト人形');
  await expect(page.getByRole('checkbox', { name: '髪を重力で垂らす' })).toHaveCount(0);
});
