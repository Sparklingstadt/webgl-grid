import { expect, test } from './fixtures/test';
import { addPmx, addShape, assignFx, diff, openMme, redBluePng, setCamera, setSun, shoot } from './mme-helpers';
import type { Win } from './helpers';

// MME 互換のレンダーエンジンで場面を描く (物の .fx・default.fx・編集用の表示)。
// テスト用の .pmx は 4×20×4 の四角柱 (MMD の単位。置くと 0.1 倍: x, z が ±0.2、高さ 2)。three.js の +z の面が MMD の前 (−z) の面

const BG = [0x3d, 0x3d, 0x3d]; // 書き出しの背景 (ビューポートの灰色)
const ALL_FLAGS = 0x1f; // 両面・地面の影・セルフシャドウ (落とす・受ける)・輪郭線
const LIGHT = 0.82; // 太陽の明るさの既定 (色は白)

// 位置だけ変換して、決まった色を出す物の .fx (MMDPass = object だけ。ほかの pass は default.fx)
const objectFx = (ps: string, decls = '') => `
float4x4 WVP : WORLDVIEWPROJECTION;
${decls}
struct VO { float4 Pos : POSITION; float2 Uv : TEXCOORD0; };
VO VS(float4 Pos : POSITION, float2 Uv : TEXCOORD0) { VO o; o.Pos = mul(Pos, WVP); o.Uv = Uv; return o; }
float4 PS(float2 Uv : TEXCOORD0) : COLOR0 { ${ps} }
technique T < string MMDPass = "object"; > { pass P { VertexShader = compile vs_3_0 VS(); PixelShader = compile ps_3_0 PS(); } }
`;

test('default.fx: 材質の色・輪郭線・地面の影', async ({ page }) => {
  const errors = await openMme(page);
  // 太陽は左手前の上から (影は右奥へ落ちる)。カメラは +z から水平に見る
  await setSun(page, { azimuthDeg: 150, elevationDeg: 45 });
  await setCamera(page, { yaw: Math.PI / 2, pitch: 0.05, dist: 4.5, ty: 1 });
  await addPmx(page, { flags: ALL_FLAGS, edgeSize: 10 });
  const face: [number, number, number] = [0, 0.8, 0.2];   // 光の当たる前の面
  const ground: [number, number, number] = [0.87, 0, -0.5]; // 影の中の地面
  const r = await shoot(page, 'png', [face, ground, [0, 1, 0.2]], true);
  // 材質の色: MMD の式 saturate(拡散色 × ライトの色 + 環境色) (トゥーンの明るい側は白・反射は 0)
  const expected = [[0.9, 0.4], [0.7, 0.3], [0.5, 0.2]].map(([d, a]) => Math.round(Math.min(1, d * LIGHT + a) * 255));
  expect(diff(r.pixels[0], expected), `${r.pixels[0]} ≈ ${expected}`).toBeLessThanOrEqual(3);
  // 地面の影: 半透明の黒 (不透明度 0.5) を背景に 1 回重ねた灰色 (この位置では三角形は重ならない。重なると濃くなる: ステンシルはまだ使わない)
  const g = r.pixels[1];
  expect(diff(g, [BG[0] * 0.5, BG[0] * 0.5, BG[0] * 0.5]), `${g}`).toBeLessThanOrEqual(2);
  // 輪郭線: 面の真ん中から左へたどると、背景の手前に黒い帯がある (法線が水平なので、上下には広がらない)
  const [cx, cy] = r.pos[2];
  const at = (x: number, y: number) => r.data.slice((y * r.width + x) * 4, (y * r.width + x) * 4 + 3);
  let x = cx;
  while (x > 0 && diff(at(x, cy), BG) > 8) x--;
  let dark = 0;
  for (let k = x + 1; k < cx && Math.max(...at(k, cy)) < 40; k++) dark++;
  expect(dark).toBeGreaterThanOrEqual(2);

  // 地面の影を切ると、そこは背景のまま
  await page.evaluate(() => (window as Win).engine.mme.set({ groundShadow: false }));
  const off = await shoot(page, 'png', [ground]);
  expect(diff(off.pixels[0], BG)).toBeLessThanOrEqual(2);
  expect(errors).toEqual([]);
});

test('default.fx: セルフシャドウで片方の箱にもう片方の影が落ちる', async ({ page }) => {
  const errors = await openMme(page);
  // 太陽はほぼ +z の側から。手前の箱 A の影が、奥の箱 B の前の面に落ちる。カメラは左手前から (A に隠れない所が見える)
  await setSun(page, { azimuthDeg: 80, elevationDeg: 35 });
  await setCamera(page, { yaw: Math.PI / 2 + 0.52, pitch: 0.05, dist: 5, ty: 1, tz: 0.4 });
  await addPmx(page, { name: 'B', flags: ALL_FLAGS, at: [0, 0] });
  await addPmx(page, { name: 'A', flags: ALL_FLAGS, at: [0.15, 0.9] });
  const on = await shoot(page, 'png', [], true);
  await page.evaluate(() => (window as Win).engine.mme.set({ selfShadow: false }));
  const off = await shoot(page, 'png', [], true);
  // 変わった画素は、影の中のトゥーンの色 (共有トゥーン 01 のいちばん下の行: 205) を掛けた色になる。
  // (箱の縁の画素は背景と混ざっている (アンチエイリアス) ので、暗くなる割合はその間)
  const toon = 205 / 255;
  let shadowed = 0, bad = 0;
  for (let i = 0; i < on.data.length; i += 4) {
    const a = on.data.slice(i, i + 3), b = off.data.slice(i, i + 3);
    if (diff(a, b) <= 4) continue;
    const ratios = [0, 1, 2].filter(k => b[k] >= 40).map(k => a[k] / b[k]);
    if (ratios.length === 0) continue; // (暗すぎて割合を比べられない)
    if (ratios.every(q => Math.abs(q - toon) < 0.03)) shadowed++;
    else if (!ratios.every(q => q > toon - 0.03 && q < 1)) bad++;
  }
  expect(shadowed).toBeGreaterThan(100);
  expect(bad).toBe(0);
  expect(errors).toEqual([]);
});

test('物の .fx: 単色の .fx でその色、MATERIALDIFFUSE を出す .fx で材質の色 (ちょうど)', async ({ page }) => {
  const errors = await openMme(page);
  await setCamera(page, { yaw: Math.PI / 2, pitch: 0.05, dist: 4.5, ty: 1 });
  const i = await addPmx(page, { flags: ALL_FLAGS, diffuse: [0.8, 0.6, 0.4, 1] });
  const face: [number, number, number] = [0, 1, 0.2];
  expect(await assignFx(page, i, objectFx('return float4(0.2, 0.4, 0.6, 1.0);'))).toBe(true);
  expect((await shoot(page, 'png', [face])).pixels[0]).toEqual([51, 102, 153, 255]);
  // MME には MATERIALDIFFUSE がないので、材質の DIFFUSE (Object = "Geometry") を出す
  expect(await assignFx(page, i, objectFx('return MaterialDiffuse;', 'float4 MaterialDiffuse : DIFFUSE < string Object = "Geometry"; >;'))).toBe(true);
  expect((await shoot(page, 'png', [face])).pixels[0]).toEqual([204, 153, 102, 255]);
  expect(errors).toEqual([]);
});

test('上が赤・下が青の画像を貼ると上が赤 (テクスチャの向きとガンマ空間)', async ({ page }) => {
  const errors = await openMme(page);
  await setCamera(page, { yaw: Math.PI / 2, pitch: 0.05, dist: 4.5, ty: 1 });
  // UV: 上の頂点は v = 0 (画像の上)、下の頂点は v = 1 (MMD の UV の向き)
  const uvs = Array.from({ length: 8 }, (_, k): [number, number] => [0.5, k < 4 ? 1 : 0]);
  const i = await addPmx(page, { flags: ALL_FLAGS, texture: 'tex.png', uvs, files: [{ name: 'tex.png', base64: await redBluePng(page) }] });
  const fx = objectFx('return tex2D(Smp, Uv);', `texture Tex : MATERIALTEXTURE;
sampler Smp = sampler_state { texture = <Tex>; MINFILTER = POINT; MAGFILTER = POINT; };`);
  expect(await assignFx(page, i, fx)).toBe(true);
  const r = await shoot(page, 'png', [[0, 1.5, 0.2], [0, 0.5, 0.2]]);
  expect(r.pixels).toEqual([[255, 0, 0, 255], [0, 0, 255, 255]]);
  expect(errors).toEqual([]);
});

test('片面の四角は表からだけ見える (CullMode = CCW)', async ({ page }) => {
  const errors = await openMme(page);
  // MMD の前 (−z) の側面の四角 1 枚 (片面・影なし・輪郭線なし)。外 (MMD の −z = three.js の +z) から見て時計回りが表
  await addPmx(page, { flags: 0, parts: [{ faces: [0, 5, 1, 0, 4, 5], edgeSize: 0 }] });
  const center: [number, number, number] = [0, 1, 0.2];
  const look = async (yaw: number) => {
    await setCamera(page, { yaw, pitch: 0.05, dist: 4, ty: 1 });
    return (await shoot(page, 'png', [center])).pixels[0];
  };
  expect(diff(await look(Math.PI / 2), BG)).toBeGreaterThan(30); // three.js の +z から (表)
  expect(diff(await look(-Math.PI / 2), BG)).toBeLessThanOrEqual(2); // three.js の −z から (裏)
  // 標準のエンジン (MMDLoader の材質) も同じ側だけを描く
  await page.evaluate(() => (window as Win).engine.mme.set({ engine: 'standard' }));
  expect(diff(await look(Math.PI / 2), BG)).toBeGreaterThan(30);
  expect(diff(await look(-Math.PI / 2), BG)).toBeLessThanOrEqual(2);
  expect(errors).toEqual([]);
});

test('骨を曲げたモデルの輪郭が標準のエンジンとほぼ同じ (違う画素が 1% 未満)、輪郭線の太さも ±1 画素', async ({ page }) => {
  const errors = await openMme(page, { width: 400, height: 400 });
  await setSun(page, { shadows: false });
  await setCamera(page, { yaw: Math.PI / 2, pitch: 0.05, dist: 3.5, ty: 1.1 });
  const i = await addPmx(page, { edgeSize: 6 });
  await page.evaluate(async i => {
    const { engine } = window as Win;
    engine.mme.set({ groundShadow: false });
    const m = engine.world.objects[i];
    engine.posing.setBone(m, 1, 'rz', 40); // 右腕 (上の 4 頂点) を曲げる
    await engine.posing.solve(m);
  }, i);
  const row: [number, number, number] = [0, 0.75, 0.2]; // 曲げていない下の部分
  const mme = await shoot(page, 'png', [row], true);
  await page.evaluate(() => (window as Win).engine.mme.set({ engine: 'standard' }));
  const std = await shoot(page, 'png', [row], true);
  // 背景でない画素 (輪郭)
  const mask = (d: number[]) => Array.from({ length: d.length / 4 }, (_, k) => diff(d.slice(k * 4, k * 4 + 3), BG) > 20);
  const a = mask(mme.data), b = mask(std.data);
  // (MME 互換は DX9 のラスタライズをまねて半画素ずらすので、縁の 1 画素は違ってよい)
  const shape = a.filter(v => v).length, differ = a.filter((v, k) => v !== b[k]).length;
  expect(shape).toBeGreaterThan(5000);
  expect(differ / a.length, `${differ} / ${a.length}`).toBeLessThan(0.01);
  // 輪郭線の太さ: 下の部分の行で、左の背景のすぐ右の黒い帯の幅
  const edgeWidth = (r: typeof mme) => {
    const y = r.pos[0][1];
    const px = (x: number) => r.data.slice((y * r.width + x) * 4, (y * r.width + x) * 4 + 3);
    let x = 0;
    while (x < r.width && diff(px(x), BG) <= 20) x++;
    let n = 0;
    while (x + n < r.width && Math.max(...px(x + n)) < 40) n++;
    return n;
  };
  const [we, ws] = [edgeWidth(mme), edgeWidth(std)];
  expect(ws).toBeGreaterThanOrEqual(2);
  expect(Math.abs(we - ws), `MME ${we} / 標準 ${ws}`).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});

test('hidden の物はビューポートに出ず、hideRender の物は書き出しに出ない', async ({ page }) => {
  const errors = await openMme(page);
  await setCamera(page, { yaw: Math.PI / 2, pitch: 0.3, dist: 6, ty: 0.5 });
  const a = await addShape(page, 0, [-1, 0], 0);
  const b = await addShape(page, 0, [1, 0], 1);
  const pts: [number, number, number][] = [[-1, 0.5, 0.5], [1, 0.5, 0.5]];
  const ref = await shoot(page, 'png', pts); // 両方が写る
  await page.evaluate(({ a, b }) => {
    const { engine } = window as Win;
    engine.world.objects[a].hidden = true;
    engine.world.objects[b].hideRender = true;
  }, { a, b });
  const view = await shoot(page, 'viewport', pts);
  const png = await shoot(page, 'png', pts);
  expect(diff(view.pixels[0], ref.pixels[0])).toBeGreaterThan(30); // 隠した物はビューポートにない
  expect(diff(view.pixels[1], ref.pixels[1])).toBeLessThanOrEqual(3);
  expect(diff(png.pixels[0], ref.pixels[0])).toBeLessThanOrEqual(3); // 書き出しには写る
  expect(diff(png.pixels[1], ref.pixels[1])).toBeGreaterThan(30); // レンダリングに写さない物は書き出しにない
  expect(errors).toEqual([]);
});

test('.pmx を読み終える前の最初のフレームでも止まらず、あとでモデルが出る', async ({ page }) => {
  const errors = await openMme(page);
  await setCamera(page, { yaw: Math.PI / 2, pitch: 0.05, dist: 4.5, ty: 1 });
  // 標準のエンジンで読んでおき (MME の変形はまだ .pmx を読んでいない)、MME 互換に切り替えたフレームをすぐ描く
  await page.evaluate(() => (window as Win).engine.mme.set({ engine: 'standard' }));
  const i = await addPmx(page, { flags: ALL_FLAGS });
  const first = await page.evaluate(i => {
    const w = window as Win, { engine } = w;
    const m = engine.world.objects[i].model;
    engine.mme.set({ engine: 'mme' });
    const before = engine.mme.renderer.skinner.data(m);
    engine.viewport.render(); // (例外を出さない)
    // 読み終えたあとの描画で、モデルの真ん中の画素を拾う (描き直しは onReady が頼む)
    w.__seen = null;
    const camera = engine.graph.camera;
    engine.viewport.onRender(() => {
      if (!engine.mme.renderer.skinner.data(m)) return;
      const canvas = engine.viewport.canvas as HTMLCanvasElement;
      const v = new w.THREE.Vector3(0, 1, 0.2).project(camera);
      const c = Object.assign(document.createElement('canvas'), { width: canvas.width, height: canvas.height });
      const g = c.getContext('2d')!;
      g.drawImage(canvas, 0, 0);
      w.__seen = Array.from(g.getImageData(Math.floor((v.x + 1) / 2 * c.width), Math.floor((1 - v.y) / 2 * c.height), 1, 1).data);
    });
    return { before, warnings: engine.mme.renderer.warnings.length };
  }, i);
  expect(first).toEqual({ before: null, warnings: 0 });
  // 拡散色 (0.9, 0.7, 0.5) の明るい側か暗い側。背景ではない
  await expect.poll(() => page.evaluate(() => (window as Win).__seen)).not.toBeNull();
  const seen = await page.evaluate(() => (window as Win).__seen as number[]);
  expect(seen[0] - seen[2]).toBeGreaterThan(40);
  expect(errors).toEqual([]);
});

test('壊れた .fx を当てるとお知らせが出て、モデルは default.fx で描かれる', async ({ page }) => {
  const errors = await openMme(page);
  await setCamera(page, { yaw: Math.PI / 2, pitch: 0.05, dist: 4.5, ty: 1 });
  const i = await addPmx(page, { flags: ALL_FLAGS });
  const face: [number, number, number] = [0, 1, 0.2];
  const before = (await shoot(page, 'png', [face])).pixels[0];
  expect(await assignFx(page, i, 'float4 PS( : COLOR0 {', 'broken.fx')).toBe(false);
  await expect(page.getByRole('status')).toContainText('broken.fx をコンパイルできませんでした');
  expect((await shoot(page, 'png', [face])).pixels[0]).toEqual(before);
  expect(errors).toEqual([]);
});

test('選んでいる物の輪郭線がビューポートに出る (書き出しには出ない)', async ({ page }) => {
  const errors = await openMme(page);
  await setCamera(page, { yaw: Math.PI / 4, pitch: 0.5, dist: 6, ty: 0.5 });
  const i = await addShape(page, 0, [0, 0], 2);
  await page.evaluate(i => { const { engine } = window as Win; engine.select(engine.world.objects[i]); }, i);
  // 選択の色 (オレンジ) の画素の数
  const orange = (d: number[]) => {
    let n = 0;
    for (let k = 0; k < d.length; k += 4) if (d[k] > 200 && d[k + 1] > 120 && d[k + 1] < 190 && d[k + 2] < 80) n++;
    return n;
  };
  expect(orange((await shoot(page, 'viewport', [], true)).data)).toBeGreaterThan(50);
  expect(orange((await shoot(page, 'png', [], true)).data)).toBe(0);
  expect(errors).toEqual([]);
});

test('リンクできない .fx はお知らせを 1 回出して止め、モデルは default.fx で描く', async ({ page }) => {
  const errors = await openMme(page);
  await setCamera(page, { yaw: Math.PI / 2, pitch: 0.05, dist: 4.5, ty: 1 });
  const i = await addPmx(page, { flags: ALL_FLAGS });
  const face: [number, number, number] = [0, 1, 0.2];
  const before = (await shoot(page, 'png', [face])).pixels[0];
  await page.evaluate(() => {
    const w = window as Win;
    w.__toasts = [];
    const toast = w.engine.ui.toast.bind(w.engine.ui);
    w.engine.ui.toast = (text: string, ms?: number) => { w.__toasts.push(text); toast(text, ms); };
  });
  // コンパイルはできるが、uniform が GPU の上限を超えるのでリンクできない
  expect(await assignFx(page, i, objectFx('return Big[int(Uv.x * 1000.0)];', 'float4 Big[20000];'), 'big.fx')).toBe(true);
  const after: number[][] = [];
  for (let k = 0; k < 3; k++) after.push((await shoot(page, 'png', [face])).pixels[0]);
  expect(after[2]).toEqual(before);
  const toasts = await page.evaluate(() => (window as Win).__toasts as string[]);
  expect(toasts.filter(x => x.includes('big.fx'))).toEqual(['fx/big.fx のシェーダーを GPU で使えないので止めました']);
  expect(await page.evaluate(i => {
    const { engine } = window as Win;
    return engine.mme.renderer.stopped(engine.mme.store.objectEffect(engine.world.objects[i].id));
  }, i)).toBe(true);
  // (three.js がリンクの失敗をコンソールに出す)
  expect(errors.filter(e => !/WebGLProgram|Shader Error/.test(e))).toEqual([]);
});

test('グリッドと編集用の物 (ライトの目印) はビューポートにだけ出て、書き出しには出ない', async ({ page }) => {
  const errors = await openMme(page);
  await setCamera(page, { yaw: Math.PI / 4, pitch: 0.5, dist: 6, ty: 0.5 });
  // 背景と違う画素の数
  const count = (d: number[]) => {
    let n = 0;
    for (let k = 0; k < d.length; k += 4) if (diff(d.slice(k, k + 3), BG) > 2) n++;
    return n;
  };
  const grid = count((await shoot(page, 'viewport', [], true)).data);
  await page.evaluate(() => {
    const { engine } = window as Win;
    engine.addLight('point');
    engine.select(null);
  });
  const withLight = count((await shoot(page, 'viewport', [], true)).data);
  expect(grid).toBeGreaterThan(100);
  expect(withLight).toBeGreaterThan(grid + 20); // ライトの目印が足される
  expect(count((await shoot(page, 'png', [], true)).data)).toBe(0);
  expect(errors).toEqual([]);
});
