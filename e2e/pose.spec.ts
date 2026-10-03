import { expect, test } from './fixtures/test';
import { loadTestModel, open, type Win } from './helpers';

// ポーズモード: Tab で入り、関節を押してボーンを選び、ギズモで回す。物は選び直さず・消さない。元に戻せる
test('ポーズモード: 関節を押してボーンを選び、ギズモで回すと、ボーンの値になる', async ({ page }) => {
  const errors = await open(page);
  await loadTestModel(page);
  // (置いたモデルが床に落ち着くまで待つ)
  await page.waitForFunction(() => { const m = (window as Win).engine.world.models[0]; return m && m.py === m.y && m.vy === 0; });
  await page.locator('#c').hover();
  await page.keyboard.press('Tab');
  await expect.poll(() => page.evaluate(() => (window as Win).engine.ui.state.poseMode)).toBe(true);
  await expect(page.getByRole('combobox', { name: 'モード' })).toHaveText('ポーズモード');
  // 右腕の関節の画面の位置を押す
  const at = await page.evaluate(() => {
    const { engine, THREE } = window as Win;
    const m = engine.world.models[0];
    Object.assign(engine.camera.cam, { tx: m.x, ty: 1.2, tz: m.z, dist: 5 }); // (モデルを画面の真ん中に)
    engine.viewport.render();
    const i = m.model.skeleton.bones.findIndex((b: Win) => b.name === '右腕');
    const p = m.model.skeleton.bones[i].getWorldPosition(new THREE.Vector3()).project(engine.graph.camera);
    const r = engine.viewport.canvas.getBoundingClientRect();
    return { x: r.left + (p.x + 1) / 2 * r.width, y: r.top + (1 - p.y) / 2 * r.height, i };
  });
  await page.mouse.click(at.x, at.y);
  await expect.poll(() => page.evaluate(() => { const { engine } = window as Win; return engine.posing.boneSel(engine.world.models[0]); })).toBe(at.i);
  expect(await page.evaluate(() => (window as Win).engine.selection.current?.s)).toBe(3); // モデルを選んだまま
  // ギズモで回したことにする (掴んでいる物を回して、変わったと知らせる)
  const rz = await page.evaluate(() => {
    const { engine, THREE } = window as Win;
    const proxy = engine.graph.scene.getObjectByName('__pose_proxy');
    proxy.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 4));
    engine.pose.controls.dispatchEvent({ type: 'objectChange' });
    const m = engine.world.models[0];
    return engine.posing.boneValue(m, engine.posing.boneSel(m)).rz;
  });
  expect(Math.abs(rz)).toBeCloseTo(45, 0);
  // X では物を消さない。Alt+R で回転を戻す。Tab でやめる
  await page.keyboard.press('x');
  expect(await page.evaluate(() => (window as Win).engine.world.models.length)).toBe(1);
  await page.keyboard.press('Alt+r');
  await expect.poll(() => page.evaluate(() => { const { engine } = window as Win; const m = engine.world.models[0]; return engine.posing.boneValue(m, engine.posing.boneSel(m)).rz; })).toBe(0);
  await page.keyboard.press('Tab');
  await expect.poll(() => page.evaluate(() => (window as Win).engine.ui.state.poseMode)).toBe(false);
  // IK のないモデル
  await page.getByRole('tab', { name: 'ボーン' }).click();
  await expect(page.getByText('このモデルには IK がありません')).toBeVisible();
  expect(errors).toEqual([]);
});
