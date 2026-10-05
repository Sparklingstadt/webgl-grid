import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseDds } from '../src/core/mme/dds.ts';
import { makePmx } from './fixtures/pmx';
import { expect, test, type Page } from './fixtures/test';
import type { Win } from './helpers';
import { addPmx, diff, objectFx, openMme, setCamera, shoot } from './mme-helpers';

// 手元だけの e2e: 本物の Ray-MMD 1.5.2 (Git に入れない fx/ray-mmd-1.5.2/) を、標準の構成 + ライトとフォグで読み込んで描く。
// 「未対応」の警告・リンクの失敗が 0 で、書き出した絵が真っ黒でないことを確かめ、絵を test-results/ray-mmd/ に保存する (目で比べるため)。
// fx/ray-mmd-1.5.2/ray.fx がなければ (CI など) 飛ばす

const ROOT = path.resolve('fx/ray-mmd-1.5.2');
const OUT = path.resolve('test-results/ray-mmd');
const FOLDER = 'ray-mmd-1.5.2';
const W = 1280, H = 720;

test.skip(!existsSync(path.join(ROOT, 'ray.fx')), 'fx/ray-mmd-1.5.2 がない (Ray-MMD 1.5.2 を置いたときだけ動く)');

// フォルダの中のすべてのファイル (フォルダからの相対パス。'/' 区切り)
function listFiles(dir: string, base = ''): string[] {
  return readdirSync(dir).flatMap(name => {
    const rel = base ? `${base}/${name}` : name;
    return statSync(path.join(dir, name)).isDirectory() ? listFiles(path.join(dir, name), rel) : [rel];
  });
}

// ライト (Lighting の .pmx のすべての種類) と、その色 (モーフ R+・G+・B+)。x, z は置く場所
const LIGHTS: { file: string; at: [number, number]; rgb: [number, number, number] }[] = [
  { file: 'PointLight.pmx', at: [0.6, 0.5], rgb: [1, 0.6, 0.3] },
  { file: 'SpotLight.pmx', at: [-0.6, 0.5], rgb: [0.3, 0.6, 1] },
  { file: 'DirectionalLight.pmx', at: [1.8, -1.2], rgb: [1, 1, 1] },
  { file: 'PointLightIES.pmx', at: [-1.8, -1.2], rgb: [1, 1, 0.8] },
  { file: 'SpotLightIES.pmx', at: [2.4, -0.4], rgb: [0.8, 1, 0.8] },
  { file: 'DiskLight.pmx', at: [-2.4, -0.4], rgb: [1, 0.8, 0.8] },
  { file: 'SphereLight.pmx', at: [1.2, -2], rgb: [0.8, 0.8, 1] },
  { file: 'TubeLight.pmx', at: [-1.2, -2], rgb: [1, 0.9, 0.7] },
  { file: 'RectangleLight.pmx', at: [0, -2.6], rgb: [0.9, 0.9, 1] },
  { file: 'LED.pmx', at: [3, -2], rgb: [1, 1, 1] },
];
const FOGS: { file: string; at: [number, number] }[] = [
  { file: 'GroundFog.pmx', at: [-3, 1] },
  { file: 'AtmosphericFog.pmx', at: [3, 1] },
  { file: 'VolumetricCube.pmx', at: [-3, -2.5] },
  { file: 'VolumetricSphere.pmx', at: [3.6, -2.8] },
];
const SKY = 'Skybox/Time of day/Time of day.pmx';
const EDITOR = 'Materials/Editor/Standard/material_editor_1.pmx';
// 絞った絵に残すもの (点光源・スポットライト・グラウンドフォグ・空)。テスト用のモデルと材質のエディタはいつも残す
const FOCUS = new Set(['PointLight.pmx', 'SpotLight.pmx', 'GroundFog.pmx', 'Time of day.pmx']);

// テスト用のモデル (makePmx の四角柱) の面を 3 つの材質に分ける: 前と右の面・後ろと左の面・上と下
function threeParts() {
  const inward = [0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7, 4, 5, 6, 4, 6, 7, 0, 2, 1, 0, 3, 2];
  const outward = inward.map((_, k) => inward[k % 3 === 0 ? k : k % 3 === 1 ? k + 1 : k - 1]);
  return [outward.slice(0, 12), outward.slice(12, 24), outward.slice(24)].map(faces => ({ faces, edgeSize: 0 }));
}

// Ray-MMD のファイルをページに配り (/__ray/ の下)、ページの中で File の並びにして window.__ray に置く
async function serveRay(page: Page) {
  const paths = listFiles(ROOT);
  await page.route('**/__ray/**', route => {
    const rel = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\/__ray\//, ''));
    route.fulfill({ body: readFileSync(path.join(ROOT, rel)), contentType: 'application/octet-stream' });
  });
  await page.evaluate(async ({ paths, folder }) => {
    const w = window as Win;
    w.__ray = await Promise.all(paths.map(async (p: string) => {
      const blob = await (await fetch(`/__ray/${p.split('/').map(encodeURIComponent).join('/')}`)).blob();
      const f = new File([blob], p.slice(p.lastIndexOf('/') + 1));
      Object.defineProperty(f, 'webkitRelativePath', { value: `${folder}/${p}` });
      return f;
    }));
  }, { paths, folder: FOLDER });
  return paths.length;
}

// Ray-MMD の .pmx (フォルダからの相対パス) を読み込んで (x, z) に置く。物の番号を返す
async function placePmx(page: Page, rel: string, at: [number, number]) {
  return page.evaluate(async ({ rel, at, folder }) => {
    const w = window as Win, { engine } = w;
    const files = (w.__ray as File[]).filter(f => (f as Win).webkitRelativePath === `${folder}/${rel}`);
    const before = engine.world.objects.length;
    await engine.loadFiles(files, { askTextures: false });
    if (engine.world.objects.length === before) return -1; // (ステージになった)
    const i = engine.world.objects.length - 1;
    const o = engine.world.objects[i];
    [o.x, o.z] = at;
    engine.world.settle();
    for (const b of engine.world.objects) { b.py = b.y; b.vy = 0; }
    return i;
  }, { rel, at, folder: FOLDER });
}

// 空の .pmx (Time of day。直径 20000 の球) を置く。読み込む画面からだとステージになり、ステージには .fx を割り当てられないので、
// ステージの判定を通さずに置いた物にする。積み重ねに入れると、ほかの物が上に乗るか空が上に乗るので、ほかの物を置いたあとに足し、
// MMD と同じく球の中心を原点にして、いちばん先に描く (Time of day の README.png の「model disply order」)。物の番号を返す
// (TODO: ステージに割り当てられるようにするか、空をステージにしないかを決めたら、ふつうに読み込む。報告に書いた)
async function placeSky(page: Page) {
  return page.evaluate(async ({ rel, folder }) => {
    const w = window as Win, { engine } = w;
    const files = (w.__ray as File[]).filter(f => (f as Win).webkitRelativePath === `${folder}/${rel}`);
    const loaded = await engine.loader.load(files, { ask: false });
    const o = engine.world.addModel(loaded.mesh, 0, 0, loaded.slots);
    [o.x, o.z] = [0, 0];
    o.y = o.py = -o.h / 2; // (settle を呼ぶと地面の上に戻る)
    o.vy = 0;
    engine.world.reorder([o.id, ...engine.world.objects.filter((b: Win) => b !== o).map((b: Win) => b.id)]);
    engine.viewport.requestDraw();
    return engine.world.objects.indexOf(o);
  }, { rel: SKY, folder: FOLDER });
}

// テスト用のモデル (材質 3 つ) を (x, z) に置く
async function placeDoll(page: Page, at: [number, number]) {
  const bytes = Array.from(makePmx('テスト人形', { outward: true, flags: 0x01 | 0x02 | 0x04 | 0x08, parts: threeParts() }));
  return page.evaluate(async ({ bytes, at }) => {
    const { engine } = window as Win;
    await engine.loadFiles([new File([new Uint8Array(bytes)], 'テスト人形.pmx')], { askTextures: false });
    const i = engine.world.objects.length - 1;
    const o = engine.world.objects[i];
    [o.x, o.z] = at;
    engine.world.settle();
    for (const b of engine.world.objects) { b.py = b.y; b.vy = 0; }
    return i;
  }, { bytes, at });
}

// 物 i のモーフ (名前 → 値) を入れる
async function setMorphs(page: Page, i: number, values: Record<string, number>) {
  await page.evaluate(({ i, values }) => {
    const { engine } = window as Win;
    const o = engine.world.objects[i];
    for (const [name, v] of Object.entries(values)) {
      const k = o.model.morphTargetDictionary?.[name];
      if (k !== undefined) engine.posing.setMorph(o, k, v);
    }
  }, { i, values });
}

// 物 i のタブ tab の、物全体 (material が null) か材質に、Ray-MMD のフォルダの .fx を割り当てる
async function assign(page: Page, i: number, tab: string, material: number | null, fx: string) {
  await page.evaluate(({ i, tab, material, fx }) => {
    const { engine } = window as Win, { mme } = engine;
    const folder = mme.store.folders()[0];
    mme.assign(engine.world.objects[i], tab, material, { folder: folder.id, path: fx });
  }, { i, tab, material, fx });
}

// 書き出した PNG (name があれば保存する) と、その平均の明るさ (0〜1)
async function exportPng(page: Page, name: string | null) {
  const { base64, mean } = await page.evaluate(async () => {
    const { engine } = window as Win;
    const blob: Blob = await engine.output.renderPng();
    const bmp = await createImageBitmap(blob);
    const c = Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
    const g = c.getContext('2d')!;
    g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return { base64: btoa(s), mean: sum / (d.length / 4) / 255 };
  });
  if (name === null) return { file: '', mean };
  mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, name);
  writeFileSync(file, Buffer.from(base64, 'base64'));
  return { file, mean };
}

// 書き出しと同じ大きさ (W×H) で、1 フレームを描くのにかかる時間 (ms。n 回の平均。毎回 GPU が描き終えるまで待つ)
async function frameTime(page: Page, n = 20) {
  return page.evaluate(async n => {
    const { engine } = window as Win, out = engine.output;
    out.begin();
    try {
      const gl = engine.viewport.renderer.getContext();
      const px = new Uint8Array(4);
      engine.viewport.render();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const t0 = performance.now();
      for (let k = 0; k < n; k++) {
        engine.viewport.render();
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      }
      return (performance.now() - t0) / n;
    } finally {
      out.end();
    }
  }, n);
}

// 描いたときの警告とコンパイルの警告、止めたエフェクト (リンクの失敗・レンダーターゲットを作れない)、コンパイルできないエフェクト
async function problems(page: Page) {
  return page.evaluate(() => {
    const { engine } = window as Win, { mme } = engine;
    const drawn = mme.renderer.drawnEffects();
    return {
      warnings: mme.renderer.allWarnings() as string[],
      uiWarnings: engine.ui.state.mme.warnings as string[],
      compile: drawn.flatMap((e: Win) => e.result.warnings.map((d: Win) => `${e.name}: ${d.file}:${d.line} ${d.message}`)) as string[],
      failed: drawn.filter((e: Win) => !e.result.ok).map((e: Win) => `${e.name}: ${e.result.errors.slice(0, 3).map((d: Win) => `${d.file}:${d.line} ${d.message}`).join(' / ')}`) as string[],
      stopped: mme.renderer.stoppedEffects().map((e: Win) => e.name) as string[],
      drawn: drawn.map((e: Win) => e.name) as string[],
      tabs: mme.renderer.offscreenTabs().map((t: Win) => t.name) as string[],
    };
  });
}

test('Ray-MMD 1.5.2 の標準の構成 + ライト (すべての種類) とフォグ (4 種類): 未対応の警告とリンクの失敗が 0 で、書き出せる', async ({ page }) => {
  test.setTimeout(600_000);
  const errors = await openMme(page, { width: W, height: H });
  const count = await serveRay(page);
  expect(count).toBeGreaterThan(800);

  // 1. Ray-MMD のフォルダと、ポストエフェクトの ray.fx
  const rayOk = await page.evaluate(async folder => {
    const w = window as Win, { mme } = w.engine;
    const e = await mme.loadEffect(w.__ray, 'ray.fx');
    mme.store.addPost(e);
    return e.result.ok && e.folder.name === folder;
  }, FOLDER);
  expect(rayOk).toBe(true);

  // 2. モデル: テスト用のモデル (材質ごとに 肌・髪・material_2.0) と、材質のエディタの .pmx
  const doll = await placeDoll(page, [0, 0]);
  await assign(page, doll, 'Main', null, 'Main/main.fx');
  await assign(page, doll, 'MaterialMap', 0, 'Materials/Skin/material_skin.fx');
  await assign(page, doll, 'MaterialMap', 1, 'Materials/Hair/material_hair.fx');
  await assign(page, doll, 'MaterialMap', 2, 'Materials/material_2.0.fx');
  const editor = await placePmx(page, EDITOR, [1.6, 1.4]);
  expect(editor).toBeGreaterThanOrEqual(0);

  // 3. ライト (LightMap の DefaultEffect で決まる) とフォグ (FogMap の DefaultEffect で決まる)
  const placed = new Map<string, number>();
  for (const l of LIGHTS) {
    const i = await placePmx(page, `Lighting/${l.file}`, l.at);
    expect(i, l.file).toBeGreaterThanOrEqual(0);
    await setMorphs(page, i, { 'R+': l.rgb[0], 'G+': l.rgb[1], 'B+': l.rgb[2] });
    placed.set(l.file, i);
  }
  for (const f of FOGS) {
    const i = await placePmx(page, `Fog/${f.file}`, f.at);
    expect(i, f.file).toBeGreaterThanOrEqual(0);
    placed.set(f.file, i);
  }

  // 4. 空 (Time of day): Main・FogMap・EnvLightMap・MaterialMap (Time of day の README.png のとおり)。足すと物の番号が 1 つずつずれる
  const sky = await placeSky(page);
  expect(sky).toBe(0);
  for (const [name, i] of placed) placed.set(name, i + 1);
  placed.set('Time of day.pmx', sky);
  await assign(page, sky, 'Main', null, 'Skybox/Time of day/Time of day.fx');
  await assign(page, sky, 'EnvLightMap', null, 'Skybox/Time of day/Time of lighting.fx');
  await assign(page, sky, 'FogMap', null, 'Skybox/Time of day/Time of fog.fx');
  await assign(page, sky, 'MaterialMap', null, 'Materials/material_skybox.fx');

  await setCamera(page, { yaw: Math.PI / 2 + 0.35, pitch: 0.12, dist: 7, tx: 0, ty: 0.8, tz: -0.6 });
  // 2 回書き出す (1 回目でオフスクリーンのタブ・画像の読み込みがそろう)
  await exportPng(page, null);
  const all = await exportPng(page, 'ray-mmd-all.png');
  const p = await problems(page);
  console.log(JSON.stringify(p, null, 2));

  // 絞った絵: 点光源・スポットライト・グラウンドフォグ・空 (ほかのライトとフォグは書き出しで隠す)
  await page.evaluate(({ hide }) => {
    const { engine } = window as Win;
    for (const i of hide) engine.world.objects[i].hideRender = true;
  }, { hide: [...placed].filter(([name]) => !FOCUS.has(name)).map(([, i]) => i) });
  const focus = await exportPng(page, 'ray-mmd-point-spot-groundfog-sky.png');
  const ms = await frameTime(page);
  // 動画にも書き出せる (3 コマ)
  const video = await page.evaluate(async () => {
    const { engine } = window as Win;
    engine.clock.setRange(0, 2);
    const v = await engine.output.renderVideo();
    return { frames: v.frames as number, size: v.bytes.length as number };
  });
  console.log(`PNG: ${all.file} (平均の明るさ ${all.mean.toFixed(3)}), ${focus.file} (${focus.mean.toFixed(3)})`);
  console.log(`1 フレーム (${W}×${H}): ${ms.toFixed(1)} ms (${(1000 / ms).toFixed(1)} fps)`);

  const unsupported = (list: string[]) => list.filter(w => /対応|止め|使えない|見つからない|できない|読めない/.test(w));
  expect(unsupported([...p.warnings, ...p.uiWarnings, ...p.compile])).toEqual([]);
  expect(p.failed).toEqual([]);
  expect(p.stopped).toEqual([]);
  expect(all.mean).toBeGreaterThan(0.05);
  expect(focus.mean).toBeGreaterThan(0.05);
  expect(video.frames).toBe(3);
  expect(video.size).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('ミップを持つ .dds (Ray-MMD の skyspec_hdr.dds。1024×512・7 段) を GPU に送り、tex2Dlod で段ごとに .dds のその段の色を読む', async ({ page }) => {
  test.setTimeout(120_000);
  const rel = 'Lighting/SphereLight/Default IBL/texture/skyspec_hdr.dds';
  const bytes = readFileSync(path.join(ROOT, rel));
  const dds = parseDds(new Uint8Array(bytes)); // (Node の Buffer は写してから渡す)
  expect([dds.format, dds.width, dds.height, dds.faces[0].length]).toEqual(['bgra8', 1024, 512, 7]);
  const U = 0.3, V = 0.3; // (どの段でも画素の境目に乗らない)
  const expected = dds.faces[0].map(l => {
    const i = (Math.floor(V * l.height) * l.width + Math.floor(U * l.width)) * 4;
    const d = l.data as Uint8Array;
    return [d[i + 2], d[i + 1], d[i]]; // (BGRA)
  });
  const errors = await openMme(page);
  await setCamera(page, { yaw: Math.PI / 2, pitch: 0.05, dist: 4.5, ty: 1 });
  const doll = await addPmx(page, { flags: 0 });
  for (let lod = 0; lod < expected.length; lod++) {
    const fx = objectFx(`return float4(tex2Dlod(Smp, float4(${U}, ${V}, 0, ${lod})).rgb, 1);`, `texture Tex < string ResourceName = "skyspec_hdr.dds"; >;
sampler Smp = sampler_state { texture = <Tex>; MinFilter = POINT; MagFilter = POINT; MipFilter = POINT; AddressU = CLAMP; AddressV = CLAMP; };`);
    const ok = await page.evaluate(async ({ doll, fx, lod, base64 }) => {
      const { engine } = window as Win;
      const files = [new File([fx], `lod${lod}.fx`), new File([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], 'skyspec_hdr.dds')];
      for (const f of files) Object.defineProperty(f, 'webkitRelativePath', { value: `ddscheck/${f.name}` });
      const e = await engine.mme.loadEffect(files, `lod${lod}.fx`);
      engine.mme.assign(engine.world.objects[doll], 'Main', null, { folder: e.folder.id, path: e.entry });
      await engine.mme.whenReady();
      return e.result.ok as boolean;
    }, { doll, fx, lod, base64: bytes.toString('base64') });
    expect(ok).toBe(true);
    const [px] = (await shoot(page, 'png', [[0, 1, 0.2]])).pixels;
    expect(diff(px, expected[lod]), `段 ${lod}: ${px} ≈ ${expected[lod]}`).toBeLessThanOrEqual(1);
  }
  expect(await page.evaluate(() => (window as Win).engine.mme.renderer.allWarnings())).toEqual([]);
  expect(errors).toEqual([]);
});
