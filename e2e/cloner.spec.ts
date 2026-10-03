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
  expect(await page.evaluate(() => (window as Win).engine.world.objects.every((o: Win) => !(window as Win).engine.addons.exposed('cinema4d').cloner(o)))).toBe(true);
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
    engine.addons.exposed('cinema4d').setCloner({ mode: 'linear', count: 3, step: [2, 0, 0] });
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
    return { worst, moved, clones: engine.addons.exposed('cinema4d').count(m), hidden: !m.model.visible };
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
    engine.addons.exposed('cinema4d').setCloner({ mode: 'linear', count: 3, step: [2, 0, 0], effectors: [{ kind: 'delay', enabled: true, position: [0, 0, 0], rotationDeg: 0, scale: 1, frames: 8 }] });
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

test('デフォーマ: サイドバーで足すと形が変わり、外すと戻る', async ({ page }) => {
  const errors = await open(page);
  const p = await screenPosOf(page, 0);
  await page.mouse.click(p.x, p.y);
  const topWidth = () => page.evaluate(() => {
    const g = (window as Win).engine.world.objects[0].mesh.geometry;
    const pos = g.attributes.position;
    let w = 0;
    for (let i = 0; i < pos.count; i++) if (pos.getY(i) > 0.99) w = Math.max(w, Math.abs(pos.getX(i)));
    return +w.toFixed(2);
  });
  expect(await topWidth()).toBe(0.5);
  await page.getByRole('button', { name: '+ テーパー' }).click(); // 既定: -0.5 (上が半分)
  await expect.poll(topWidth).toBe(0.25);
  await page.getByRole('button', { name: 'テーパーを外す' }).click();
  await expect.poll(topWidth).toBe(0.5);
  expect(errors).toEqual([]);
});

test('MoGraph エフェクタ: ターゲットで向きを変え、フォーミュラは時刻で動く。アドオンを切ると効かず、設定は残る', async ({ page }) => {
  const errors = await open(page);
  const p = await screenPosOf(page, 0);
  await page.mouse.click(p.x, p.y);
  await page.getByRole('checkbox', { name: 'クローナーにする' }).click();
  await choose(page, 'クローナーの並べ方', '直線');
  const clones = (): Promise<[number, number][]> => page.evaluate(() => (window as Win).engine.world.objects[0].node.getObjectByName('__clones').children
    .map((g: Win) => [+g.position.y.toFixed(2), +g.rotation.y.toFixed(2)]));
  // ターゲット: 真横 (X 方向の遠く) を向く
  await page.getByRole('button', { name: '+ ターゲット' }).click();
  const target = page.getByRole('group', { name: 'エフェクタ 1 ターゲット' });
  await target.getByRole('spinbutton', { name: 'ターゲットのターゲット X' }).fill('1000');
  await page.keyboard.press('Enter');
  await target.getByRole('spinbutton', { name: 'ターゲットのターゲット Z' }).fill('0');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await clones()).every(([, ry]) => Math.abs(ry - 1.57) < 0.02)).toBe(true);
  // フォーミュラ: 時刻を進めると、上下の位置が変わる
  await page.getByRole('button', { name: '+ フォーミュラ' }).click();
  const at = async (frame: number) => { await page.evaluate(f => { (window as Win).engine.clock.seekFrame(f); }, frame); await page.waitForTimeout(50); return (await clones()).map(([y]) => y); };
  const y0 = await at(0), y1 = await at(8);
  expect(y0).not.toEqual(y1);
  // MoGraph エフェクタを切ると、効かなくなり (設定は残る)、パネルに知らせを出す
  await page.evaluate(() => (window as Win).engine.addons.disable('mograph'));
  await expect.poll(async () => (await clones()).every(([y, ry]) => y === 0 && ry === 0)).toBe(true);
  await expect(page.getByText('この種類のエフェクタは登録されていないので、働きません').first()).toBeVisible();
  await page.evaluate(() => (window as Win).engine.addons.enable('mograph'));
  await expect.poll(async () => (await clones()).every(([, ry]) => Math.abs(ry) > 0.5)).toBe(true);
  expect(errors).toEqual([]);
});

test('MoGraph フィールド: エフェクタに球のフィールドを足すと、範囲の中だけ効き、ビューポートに枠を出す (レンダリングには写らない)', async ({ page }) => {
  const errors = await open(page);
  const p = await screenPosOf(page, 0);
  await page.mouse.click(p.x, p.y);
  await page.getByRole('checkbox', { name: 'クローナーにする' }).click();
  await choose(page, 'クローナーの並べ方', '直線');
  await page.getByRole('button', { name: '+ プレーン' }).click();
  await page.getByRole('spinbutton', { name: 'プレーンの位置 Y' }).fill('1');
  await page.keyboard.press('Enter');
  const ys = () => page.evaluate(() => (window as Win).engine.world.objects[0].node.getObjectByName('__clones').children.map((g: Win) => +g.position.y.toFixed(2)));
  await expect.poll(ys).toEqual([1, 1, 1, 1, 1]);
  await page.getByText('フィールド (全体に効く)').click();
  await page.getByRole('button', { name: 'プレーンに球のフィールドを足す' }).click();
  // 球 (中心 0, 1, 0・半径 2・内側 0.5) の中のクローン (x = 0, 1.5) だけ持ち上がる (端に近いほど弱い)
  await expect.poll(ys).toEqual([1, 0.1, 0, 0, 0]);
  // (描かれる = 自分と親が全部見えている)
  await page.evaluate(() => { (window as Win).shown = (o: Win) => { for (let v = o; v; v = v.parent) if (!v.visible) return false; return true; }; });
  const wires = () => page.evaluate(() => { const { shown } = window as Win; let n = 0; (window as Win).engine.graph.scene.traverse((o: Win) => { if (o.userData.editorOnly && o.isLine && shown(o)) n++; }); return n; });
  await expect.poll(wires).toBeGreaterThan(0);
  const during = await page.evaluate(() => {
    const { engine } = window as Win;
    let seen = -1;
    const { shown } = window as Win;
    const off = engine.viewport.onRender(() => { if (engine.output.active) { seen = 0; engine.graph.scene.traverse((o: Win) => { if (o.userData.editorOnly && o.isLine && shown(o)) seen++; }); } });
    return engine.output.renderPng().then(() => { off(); return seen; });
  });
  expect(during).toBe(0);
  // 反転すると逆に
  await page.getByRole('checkbox', { name: 'プレーンのフィールド 1 球を反転' }).click();
  await expect.poll(ys).toEqual([0, 0.9, 1, 1, 1]);
  expect(errors).toEqual([]);
});

test('MoGraph 分割: 形をボロノイで破片に分け、エフェクタで破片を動かす。PolyFX にもでき、やめると戻る', async ({ page }) => {
  const errors = await open(page);
  const p = await screenPosOf(page, 0);
  await page.mouse.click(p.x, p.y);
  await page.getByRole('checkbox', { name: '分割する' }).click();
  await expect(page.getByText('破片 12 個')).toBeVisible();
  const top = () => page.evaluate(() => { const m = (window as Win).engine.world.objects[0].node.getObjectByName('__fracture'); m.geometry.computeBoundingBox(); return +m.geometry.boundingBox.max.y.toFixed(2); });
  expect(await top()).toBeLessThanOrEqual(1);
  const panel = page.locator('details.panel').filter({ has: page.getByRole('checkbox', { name: '分割する' }) });
  await panel.getByRole('button', { name: '+ ランダム' }).click();
  await panel.getByRole('spinbutton', { name: 'ランダムの位置 Y' }).fill('3');
  await page.keyboard.press('Enter');
  await expect.poll(top).toBeGreaterThan(1.5);
  await choose(page, '分け方', 'PolyFX (面ごと)');
  await expect(page.getByText('破片 12 個')).toBeVisible();
  await page.getByRole('checkbox', { name: '分割する' }).click();
  await expect.poll(() => page.evaluate(() => !(window as Win).engine.world.objects[0].node.getObjectByName('__fracture') && (window as Win).engine.world.objects[0].mesh.visible)).toBe(true);
  expect(errors).toEqual([]);
});

test('MoText: 追加メニューからテキストを置き、文字を変えると厚みのある文字になる (日本語も)。文字ごとにエフェクタがかかる', async ({ page }) => {
  const errors = await open(page);
  await page.getByRole('button', { name: '追加' }).click();
  await page.getByRole('menuitem', { name: 'テキスト (MoText)' }).click();
  const box = page.getByRole('textbox', { name: 'テキスト' });
  await box.fill('AO\nあ');
  await box.press('Control+Enter');
  const info = () => page.evaluate(() => {
    const { engine } = window as Win;
    const o = engine.selection.current, mt = engine.addons.exposed('mograph-text');
    const root = o.node.getObjectByName('__motext');
    const verts: number[] = [];
    root.traverse((c: Win) => { if (c.isMesh) verts.push(c.geometry.getAttribute('position').count); });
    return { units: mt.count(o), verts, hidden: !o.mesh.visible, h: +o.h.toFixed(2) };
  });
  await expect.poll(async () => (await info()).units).toBe(3);
  const i = await info();
  expect(i.hidden).toBe(true);
  expect(i.verts).toHaveLength(3);
  expect(i.verts.every(n => n > 30)).toBe(true); // 形がある (O は穴も)
  expect(i.h).toBeGreaterThan(2); // 2 行ぶんの高さ
  // 文字ごとのステップ: 後の文字ほど上へ
  await page.getByRole('button', { name: '+ ステップ' }).last().click();
  const ys = (): Promise<number[]> => page.evaluate(() => (window as Win).engine.selection.current.node.getObjectByName('__motext').children.map((g: Win) => +g.position.y.toFixed(2)));
  const before = await ys();
  await page.getByRole('spinbutton', { name: 'ステップの位置 Y' }).fill('1');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await ys()).map((y, k) => +(y - before[k]).toFixed(2))).toEqual([0, 0.5, 1]);
  expect(errors).toEqual([]);
});
