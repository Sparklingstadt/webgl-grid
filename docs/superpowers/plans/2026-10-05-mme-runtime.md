# MME 互換モード 第 2 の計画: MME ランタイム 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** レンダーエンジン「MME 互換」で、MMD モデルに当てた .fx（`object`/`object_ss`/`zplot`/`shadow`/`edge`）と、その上に重ねたポストエフェクトを、ビューポートと書き出しに描けるようにする。

**Architecture:** 計算（セマンティクス・座標・technique の選び方・Script の実行・レンダーターゲットの大きさ・CPU の変形）は `src/core/mme/` の純粋な関数にし、three.js を使う部分（変形した形・材質・フレームバッファ・1 フレームの順番）は `src/engine/mme/` のクラスにする。描画は three.js の `RawShaderMaterial` と `renderer.renderBufferDirect` で行い、いまの `Viewport.drawOverride` に差し込む。

**Tech Stack:** TypeScript 7・three.js 0.186・vitest・Playwright（Chromium。CI は SwiftShader）・React（画面）

**Spec:** `docs/superpowers/specs/2026-10-05-mme-runtime-design.md`（実装する人は必ず両方を読む）。コンパイラの設計書 `docs/superpowers/specs/2026-10-05-mme-fx-compiler-design.md` と `ARCHITECTURE.md` の core/fx の注意書きも前提。

## Global Constraints

- 標準のエンジンの絵と動きを変えない。MME の処理は、レンダーエンジンが `'mme'` のときだけ動く（CPU の変形も）。いまある e2e はそのまま通ること。
- `src/core/mme/` は three.js の数学（`Matrix4`・`Vector3`・`Quaternion`）だけを使い、場面・DOM・WebGL には触らない。import は拡張子 `.ts` まで書き、消せる TypeScript の書き方だけを使う（`scripts/` から Node で直接読むため）。
- 画面やお知らせの文は `t('日本語')` で書き、同じタスクで `src/i18n/en.ts`・`zh-Hans.ts`・`zh-Hant.ts` に訳を足す。
- **色の空間**: MME の描画は DX9 と同じくガンマ空間のまま行う。.fx が読むテクスチャはすべて `colorSpace = THREE.NoColorSpace`・`flipY = false` にする（`MaterialLibrary` の画像は、MME 用にその設定の写しを作る。元は変えない）。シェーダーの出力は canvas にそのまま書く。
- **`RawShaderMaterial` の作り方**: `Program.vertex`/`fragment` の 1 行目（`#version 300 es`）を取り除き、`glslVersion: THREE.GLSL3` を付ける（three.js は生の GLSL の先頭に `#define` を足すので、`#version` を二重にしない）。`defines` は空。値を変えたら描く前に `material.uniformsNeedUpdate = true`。
- **行列の値**: `core/mme/coords.ts` の `toMmd(m)`（列ベクトルの書き方で `S·m·S`、`S = diag(1, 1, −1)`）の `elements`（列ごとの並び）をそのまま D3D の行ごとの 16 個の数として渡す。
- **上下と面の向き**: canvas に描くとき `mme_flipY = 1`、レンダーターゲット（深度マップを含む）に描くとき `mme_flipY = −1`。`mme_halfPixel = [−1 / 幅, mme_flipY / 高さ]`（幅・高さはいまの描画先の画素数）。面を消す向きは下の表（Task 10 の `cullSide`）。
- コメントはまわりと同じく日本語で短く。各タスクの終わりに `npx vitest run`、`npx tsc -b`、`npm run lint` を通し、e2e を足したタスクは `npx playwright test <そのファイル>` と `E2E_GL=software npx playwright test <そのファイル>` も通す。コミットは日本語の 1 行の要約と、末尾にコミットしたモデルの `Co-Authored-By` 行。

## 仕様の補足（設計書からの具体化）

1. **背景**: MME 互換では空（`Environment.drawBackground`）を描かない。場面の描画先を、いまの `renderer.getClearColor()`（ビューポートの灰色。書き出しでは `beginOutput` が決めた色）で消す。MME のエフェクトは空を自分で描くため。
2. **`object_ss` の technique がないとき**: 同じエフェクトの `object` の technique を使い、それもなければ `default.fx` の `object_ss` を使う。
3. **セルフシャドウの深度マップ**: `R32F`（`EXT_color_buffer_float` が要る）。描けない環境では、設計書の「RGBA8 に詰める」の代わりに **セルフシャドウを切って警告を出す**（`default.fx` の詰め方の分岐を作らないため。CI の SwiftShader と主なデスクトップは描ける）。
4. **UV モーフ**: MMDLoader は UV モーフを読まず、表情の一覧（`morphTargetDictionary`）にも出ないので、この計画では扱わない（設計書からの変更。第 5 の計画へ）。頂点モーフは three.js の `morphAttributes.position`（相対）と `morphTargetInfluences` を使う。
5. **輪郭線の広げ方**: いまの標準のエンジン（three.js の OutlineEffect。`thickness = 輪郭線の太さ / 300` を画面の割合で広げる）とほぼ同じ太さになるよう、物の空間で `位置 + 法線 × (頂点の輪郭線の太さ / 300) × カメラからの距離 × tan(視野の縦の半分)` とする。頂点の輪郭線の太さ = 材質の輪郭線の太さ × 頂点の輪郭線の倍率（その頂点を最初に使う材質の値）。
6. **非正方の行列の uniform**（three.js には `mat4x3` などの uniform を入れる関数がない）: コンパイラが `uniform mat4 名前;` として宣言し、読むところで `mat{R}x{C}(名前)` に直す（Task 1）。ランタイムは 16 個の数にして渡す: HLSL の r 行 c 列を `r * 4 + c` 番目に置き、残りは 0。
7. **フレームバッファ**: MME は 1 つの深度・ステンシルのターゲットを、いくつもの色のターゲットと組み合わせる。色のターゲットの組み合わせ（最大 4 つ）と深度のターゲットごとに、`gl` で作ったフレームバッファを `renderer.setRenderTargetFramebuffer` で three.js の `WebGLRenderTarget` に付けて使う（Task 12）。色のテクスチャは three.js の `Texture` として作り、`renderer.initTexture` のあと `renderer.properties.get(tex).__webglTexture` を取り付ける。深度・ステンシルは自分で作る renderbuffer（`DEPTH24_STENCIL8`）。
8. **ファイルの選び方**: 「読み込む…」はフォルダを選ばせる（`webkitdirectory`）。中に .fx が 1 つならそれを、いくつかあれば、見つかった .fx（フォルダからの相対パス）の一覧から選んでもらう。ドラッグ＆ドロップのフォルダも同じ。

## Review Focus

1. **レンダーエンジンを行き来する**（MME 互換 → 標準 → MME 互換）と、標準に戻した絵がはじめと同じで、MME の資源は戻すときに片付く → Task 13 のエンジンのテストと e2e「標準に戻すと絵が元どおり」。
2. **隠した物・レンダリングに写さない物**（`hidden`・`hideRender`）は、MME 互換でもビューポート・書き出しに同じ決まりで出ない → Task 11 の e2e。
3. **書き出しの大きさがビューポートと違う**（`ViewportRatio` のレンダーターゲットと `VIEWPORTPIXELSIZE` が書き出しの大きさに合う） → Task 12 の e2e「大きさを変えて 2 回書き出す」。
4. **SDEF のデータをまだ読み終えていない最初のフレーム**でも止まらず、読み終えたら描き直してモデルが出る → Task 11 の e2e。
5. **エフェクトのフォルダのサブフォルダのテクスチャ**（`ResourceName = "tex\\Face.PNG"`。`\` と大文字小文字が違う）が読める → Task 10 のテスト。

---

## ファイルの地図

| ファイル | 役割 | タスク |
|---|---|---|
| `src/core/fx/{parser,check,emit,entry,desc,index}.ts` | `register`・`mme_halfPixel`・非正方の行列の uniform | 1 |
| `src/core/mme/coords.ts` | 右手系 ↔ 左手系、D3D の視野・投影・正射影、地面の影の行列 | 2 |
| `src/core/mme/semantics.ts` | `SemanticContext` からパラメータの値、テクスチャのセマンティクスの種類 | 3 |
| `src/core/mme/technique.ts` | technique の選び方 | 4 |
| `src/core/mme/targets.ts` | レンダーターゲットの大きさと形式 | 4 |
| `src/core/mme/script.ts` | technique と pass の Script の実行 | 5 |
| `src/core/mme/skinning.ts` | CPU の変形（BDEF1/2/4・SDEF・QDEF）、頂点モーフ、輪郭線の広げ方 | 6 |
| `src/core/testing/pmx.ts` | テスト用の .pmx を作る（`e2e/fixtures/pmx.ts` から移す） | 7 |
| `src/engine/mme/mmdData.ts` | .pmx を読み直して変形の情報・材質のフラグを取り出す | 7 |
| `src/engine/materials/fromMmd.ts` | トゥーン・スフィアのテクスチャを残す | 7 |
| `src/engine/mme/Skinner.ts` | 変形した形（MME 用の属性の名前・左手系）を持つ | 8 |
| `src/engine/mme/default.fx` | MMD 標準の描き方をまねた .fx | 9 |
| `src/engine/mme/EffectStore.ts` | .fx の読み込み・コンパイル・割り当て | 9 |
| `src/engine/mme/EffectInstance.ts` | pass ごとの材質・テクスチャ・uniform の値 | 10 |
| `src/engine/mme/MmeRenderer.ts` | 1 フレームの順番（場面・ポストエフェクト・編集用の表示） | 11・12 |
| `src/engine/mme/Framebuffers.ts` | レンダーターゲットとフレームバッファ | 12 |
| `src/engine/mme/MmeEngine.ts` | レンダーエンジンの設定・切り替え・組み立て | 11・13 |
| `src/engine/Engine.ts`・`src/engine/addons/builtins.ts`・`src/engine/UiChannel.ts` | 組み立て・場面の値 `mme` の保存・画面の状態 | 11・13 |
| `src/ui/components/sidebar/OutputPage.tsx`・`FxPage.tsx`・`src/ui/components/MmeEffectPicker.tsx` | 画面 | 13 |
| `e2e/mme-*.spec.ts`・`e2e/mme-helpers.ts` | e2e | 11・12・13 |
| `scripts/mme-skin-bench.ts` | CPU の変形の速さを測る | 14 |

---

### Task 1: コンパイラの 3 つの変更

**Files:**
- Modify: `src/core/fx/ast.ts`（`VarDecl.register`）、`parser.ts`、`check.ts`（必要なら）、`desc.ts`（`SamplerDecl.register`・`UniformRef.upload`）、`entry.ts`、`emit.ts`、`index.ts`
- Test: `src/core/fx/parser.test.ts`・`entry.test.ts`・`index.test.ts`、`e2e/fx-webgl.spec.ts`（値のテスト 1 つ）

**Interfaces:**
- Produces:

```ts
// ast.ts
interface VarDecl { /* 既存の欄 */ register: string | null }   // 'register(s0)' → 's0' (小文字)
// desc.ts
interface SamplerDecl { /* 既存の欄 */ register: string | null }
interface UniformRef { /* 既存の欄 */ upload?: 'mat4' }        // 非正方の行列 (とその配列) は mat4 として渡す
// uniforms の builtin に { name: 'mme_halfPixel', glslName: 'mme_halfPixel', type: 'float2', kind: 'builtin', stages: ['vertex'] } が加わる
```

決まり:
- `gl_Position = vec4(p.x + mme_halfPixel.x * p.w, p.y * mme_flipY + mme_halfPixel.y * p.w, 2.0 * p.z - p.w, p.w);`。`mme_halfPixel` は頂点ではいつも宣言し、`uniformVectors` に 1 足す。
- 非正方の行列の uniform（R ≠ C、配列も）: 宣言は `uniform mat4 名前;`（配列は `uniform mat4 名前[n];`）。読むところ（識別子、配列なら添え字の式）は `mat{R}x{C}(名前)`・`mat{R}x{C}(名前[i])`。`UniformRef.type` は HLSL の書き方のまま、`upload: 'mat4'` を付ける。`uniformVectors` は 1 つにつき 4。

- [ ] **Step 1: 失敗するテストを書く**

```ts
it('register(s0) をサンプラーに残す', () => {
  const r = compile('sampler DefSampler : register(s0); sampler S2 : register( S1 ) = sampler_state { texture = <T>; };' + PS_USING('tex2D(DefSampler, 0) + tex2D(S2, 0)'));
  expect(r.effect.samplers.map(s => [s.name, s.register])).toEqual([['DefSampler', 's0'], ['S2', 's1']]);
});
it('gl_Position に半画素のずれを入れ、mme_halfPixel を uniform に出す', () => {
  const p = programOf(MINIMAL);
  expect(p.vertex).toContain('gl_Position = vec4(p.x + mme_halfPixel.x * p.w, p.y * mme_flipY + mme_halfPixel.y * p.w, 2.0 * p.z - p.w, p.w);');
  expect(p.uniforms.find(u => u.name === 'mme_halfPixel')).toEqual({ name: 'mme_halfPixel', glslName: 'mme_halfPixel', type: 'float2', kind: 'builtin', stages: ['vertex'] });
});
it('非正方の行列の uniform は mat4 で宣言し、読むところで直す', () => {
  const p = programOf('float4x3 M; float3x4 A[2]; …' /* PS が mul(v, M) と A[1] を使う */);
  expect(p.fragment).toContain('uniform mat4 M;'); expect(p.fragment).toContain('uniform mat4 A[2];');
  expect(p.fragment).toContain('mat4x3(M)'); expect(p.fragment).toContain('mat3x4(A[1])');
  expect(p.uniforms.find(u => u.name === 'M')).toMatchObject({ type: 'float4x3', upload: 'mat4' });
});
```

e2e（`e2e/fx-webgl.spec.ts`。`runPixel` は `upload: 'mat4'` の uniform を 16 個の数に詰めて渡すよう直す）: いまの「uniform の行列」のテスト（`float4x3 M` に `[1..12]`、`[[25, 29, 33, 0]]`）が、詰め方を変えたあとも同じ値で通ること。

- [ ] **Step 2: 落ちることを確かめる** — Run: `npx vitest run src/core/fx` / Expected: 新しいテストが FAIL
- [ ] **Step 3: 実装する** — `register(...)` は、いまは読み飛ばしている所で名前を取っておく。Ray-MMD の見本（`corpus.test.ts`）のエラー 0 を保つ。
- [ ] **Step 4: 通ることを確かめる** — Run: `npx vitest run src/core/fx` と `npx playwright test e2e/fx-webgl.spec.ts`（GPU とソフトウェア） / Expected: PASS（見本は 515 + 52 がエラー 0、e2e の数の下限も通る）
- [ ] **Step 5: コミット** — `git commit -m "FX コンパイラ: register・半画素のずれ・非正方の行列の uniform (MME ランタイムのため)"`

---

### Task 2: 座標（`core/mme/coords.ts`）

**Files:**
- Create: `src/core/mme/coords.ts`
- Test: `src/core/mme/coords.test.ts`

**Interfaces:**
- Produces:

```ts
export function toMmd(m: Matrix4): Matrix4;                    // S·m·S (新しい行列)
export function toMmdVec(v: Vector3): Vector3;                 // (x, y, −z)
export function viewLH(eye: Vector3, target: Vector3, up: Vector3): Matrix4;   // 左手系の世界 → 視野 (視線が +z)
export function perspectiveD3D(fovY: number, aspect: number, near: number, far: number): Matrix4; // 視野の z を [near, far] → NDC の z を [0, 1]
export function orthoD3D(left: number, right: number, bottom: number, top: number, near: number, far: number): Matrix4;
export function groundShadowMatrix(lightDir: Vector3, y?: number): Matrix4;  // lightDir: 光が進む向き (左手系)。y = 0 の面に潰し、高さ y + 0.01 に置く
// 行列はすべて列ベクトルの書き方。elements がそのまま D3D の行ごとの並び
```

- [ ] **Step 1: 失敗するテストを書く**

```ts
it('elements は D3D の行ごとの並び (mul(v, D) = 列ベクトルの M·v)', () => {
  const m = new Matrix4().makeRotationY(0.3).setPosition(1, 2, 3);
  const v = [0.5, -1, 2, 1], d = m.elements;
  const hlsl = [0, 1, 2, 3].map(c => v.reduce((s, vi, r) => s + vi * d[r * 4 + c], 0));  // mul(v, D): D[r][c] = d[r*4+c]
  expect(hlsl).toEqual(close(new Vector4(...v).applyMatrix4(m).toArray()));
});
it('toMmd: three.js の (0, 0, 1) は MMD の z = −1、平行移動の z も反転', () => {
  expect(toMmdVec(new Vector3(0, 0, 1)).z).toBe(-1);
  expect(new Vector3(0, 0, 0).applyMatrix4(toMmd(new Matrix4().makeTranslation(1, 2, 3))).toArray()).toEqual([1, 2, -3]);
});
it('perspectiveD3D: near → z/w = 0、far → 1、右が +x', () => { /* (0,0,near,1)・(0,0,far,1)・(1,0,near,1) を通す */ });
it('viewLH: 目の前の点は視野の +z', () => { /* eye (0,0,-10)、target 原点 → 原点は z = 10 */ });
it('groundShadowMatrix: 光の向きに沿って y = 0.01 に潰れる', () => {
  const p = new Vector3(1, 2, 3).applyMatrix4(groundShadowMatrix(new Vector3(-1, -1, 0).normalize()));
  expect(p.toArray()).toEqual(close([-1, 0.01, 3]));
});
```

- [ ] **Step 2: 落ちることを確かめる** — Run: `npx vitest run src/core/mme/coords.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確かめる** — 同じコマンド / Expected: PASS
- [ ] **Step 5: コミット** — `git commit -m "MME ランタイム: 座標と D3D の行列"`

---

### Task 3: セマンティクス（`core/mme/semantics.ts`）

**Files:**
- Create: `src/core/mme/semantics.ts`
- Test: `src/core/mme/semantics.test.ts`

**Interfaces:**
- Consumes: `toMmd`・`toMmdVec`・`viewLH`・`perspectiveD3D`・`groundShadowMatrix`（Task 2）、`Param`・`TextureDecl`（`src/core/fx/desc.ts`）
- Produces:

```ts
export type MmdPass = 'object' | 'object_ss' | 'zplot' | 'shadow' | 'edge';
export interface CameraState { position: Vector3; target: Vector3; up: Vector3; fovY: number; aspect: number; near: number; far: number } // three.js の空間
export interface LightState {
  direction: Vector3;                 // 光が進む向き (three.js の空間)
  color: [number, number, number];
  shadowView: Matrix4; shadowProjection: Matrix4; // セルフシャドウのライトのカメラ (左手系・D3D に直したもの)
}
export interface MaterialState {
  diffuse: [number, number, number, number]; ambient: [number, number, number]; specular: [number, number, number]; power: number;
  toon: [number, number, number]; edgeColor: [number, number, number, number]; groundShadowColor: [number, number, number, number];
  hasTexture: boolean; hasSphere: boolean; hasToon: boolean; sphereAdd: boolean; transparent: boolean;
}
export interface SemanticContext {
  camera: CameraState; light: LightState; world: Matrix4 /* three.js の物 → 世界 */; material: MaterialState | null;
  pass: MmdPass | null /* null はポストエフェクト */; time: number; elapsed: number; screen: [number, number]; selfShadow: boolean;
}
export type SemanticValue = { kind: 'numbers'; values: number[] } | { kind: 'unsupported'; what: string } | { kind: 'none' };
export function semanticValue(p: Param, ctx: SemanticContext): SemanticValue;   // values は p.type の形に合わせた数 (行列は行ごと)
export type TextureRole = 'material' | 'sphere' | 'toon' | 'colorTarget' | 'depthTarget' | 'file' | 'unsupported' | 'none';
export function textureRole(t: TextureDecl): TextureRole;
export const SHADOW_COLOR: [number, number, number, number];  // 地面の影の既定の色 = [0, 0, 0, 0.5]
```

決まり（設計書の「MMD が .fx に渡す値」の表をそのまま。加えて）:
- 行列は `/^(WORLD|VIEW|PROJECTION|WORLDVIEW|VIEWPROJECTION|WORLDVIEWPROJECTION)(INVERSE|TRANSPOSE|INVERSETRANSPOSE)?$/`。`Object` の注釈（大文字小文字を無視）が `Light` ならライトのカメラ、それ以外はカメラ。`WORLD` は `toMmd(world)`、`pass === 'shadow'` のときは `groundShadowMatrix(ライトの向き) · toMmd(world)`。
- `POSITION`・`DIRECTION` は `Object` がなければカメラ。`DIFFUSE` などの色は `Object` がなければ材質（`Geometry`）。
- 値を返す形: 型が `float4x4` なら 16 個、`float4x3` などは行ごとに R×C 個、`float3` に 4 成分の値なら先の 3 個、スカラーなら 1 個。
- 名前で決まる変数（セマンティクスなし、名前は大文字小文字を区別）: `parthf`・`transp`・`spadd`・`use_texture`・`use_spheremap`・`use_toon` は bool（`[1]`/`[0]`）、`use_subtexture`・`opadd` は `[0]`。
- `CONTROLOBJECT`・`MOUSEPOSITION`・`LEFTMOUSEDOWN`・`MIDDLEMOUSEDOWN`・`RIGHTMOUSEDOWN`・`TEXTUREVALUE` は `unsupported`。そのほかの知らないセマンティクスは `none`（既定の値のまま）。
- `textureRole`: `MATERIALTEXTURE`→`material`、`MATERIALSPHEREMAP`→`sphere`、`MATERIALTOONTEXTURE`→`toon`、`RENDERCOLORTARGET`→`colorTarget`、`RENDERDEPTHSTENCILTARGET`→`depthTarget`、`OFFSCREENRENDERTARGET`・`ANIMATEDTEXTURE` は `unsupported`（`ANIMATEDTEXTURE` も、`ResourceName` があれば呼ぶ側が最初のフレームを読む）、セマンティクスがなく `ResourceName` の注釈があれば `file`、それ以外 `none`。

- [ ] **Step 1: 失敗するテストを書く**（決まったカメラ・ライト・物の `ctx` を作る小さな関数を置く）

```ts
it('WORLDVIEWPROJECTION で物の原点が手で計算した位置に写る', () => { /* 物を (0, 0, 5) に置き、カメラは (0, 10, -30) から原点を見る。mul(float4(0,0,0,1), M) を計算して、toMmd と viewLH と perspectiveD3D から作った期待値と比べる */ });
it('INVERSE・TRANSPOSE・INVERSETRANSPOSE', () => { /* WORLDINVERSE × WORLD = 単位行列。WORLDTRANSPOSE[r*4+c] = WORLD[c*4+r] */ });
it('Object = "Light" の行列はライトのカメラ', ...);
it('材質の値は MME の決まり (AMBIENT は拡散色、EMISSIVE は環境色)', () => {
  const m = { ...MAT, diffuse: [0.9, 0.7, 0.5, 1], ambient: [0.4, 0.3, 0.2] };
  expect(val('float3 A : AMBIENT;', m)).toEqual([0.9, 0.7, 0.5]);
  expect(val('float3 E : EMISSIVE;', m)).toEqual([0.4, 0.3, 0.2]);
  expect(val('float4 D : DIFFUSE;', m)).toEqual([0.9, 0.7, 0.5, 1]);
});
it('ライトの値 (DIFFUSE は 0、AMBIENT・SPECULAR は色、DIRECTION は左手系)', ...);
it('shadow の pass では WORLD に地面の影の行列が掛かる', ...);
it('名前で決まる変数・TIME・VIEWPORTPIXELSIZE', ...);
it('CONTROLOBJECT は unsupported、知らないものは none', ...);
it('textureRole', ...);
```

- [ ] **Step 2: 落ちることを確かめる** — Run: `npx vitest run src/core/mme/semantics.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装する** — テストの `Param` は、小さな HLSL を `compileEffect` にかけて取り出す（手で組み立てない）。
- [ ] **Step 4: 通ることを確かめる** — 同じコマンド / Expected: PASS
- [ ] **Step 5: コミット** — `git commit -m "MME ランタイム: セマンティクスの値"`

---

### Task 4: technique の選び方とレンダーターゲットの大きさ

**Files:**
- Create: `src/core/mme/technique.ts`, `src/core/mme/targets.ts`
- Test: `src/core/mme/technique.test.ts`, `src/core/mme/targets.test.ts`

**Interfaces:**
- Consumes: `EffectDesc`・`Technique`・`TextureDecl`（desc.ts）、`MmdPass`（Task 3）
- Produces:

```ts
// technique.ts
export interface TechniqueQuery { pass: MmdPass; subset: number; useTexture: boolean; useSphereMap: boolean; useToon: boolean; selfShadow: boolean }
export function pickTechnique(effect: EffectDesc, q: TechniqueQuery): Technique | null;  // null = この pass の technique がない
export function subsetMatcher(spec: string): (i: number) => boolean;   // "0-3,5"・"6-" も
// targets.ts
export type TargetFormat = 'rgba8' | 'rgba16f' | 'rgba32f' | 'r16f' | 'r32f' | 'rg16f' | 'rg32f' | 'depth24stencil8';
export interface TargetSpec { width: number; height: number; format: TargetFormat; mipmaps: boolean; warnings: string[] }
export function targetSpec(t: TextureDecl, screen: [number, number], depth: boolean): TargetSpec;
```

決まり:
- `pickTechnique`: 宣言の順に見て、すべての条件に合う最初の technique。`MMDPass`（文字列。なければ `"object"`）が `q.pass` と同じ、`Subset`（あれば）が `q.subset` を含む、`UseTexture`・`UseSphereMap`・`UseToon`・`UseSelfShadow`（bool。あれば）が `q` と同じ。`q.pass === 'object_ss'` で合うものがなければ、`pass: 'object'` で探し直す（補足 2）。中身が空の technique もそのまま返す（呼ぶ側が「描かない」と読む）。
- `targetSpec`: 注釈 `Dimensions`（2 つの数）か `Width`・`Height` があればその大きさ、なければ `ViewportRatio`（既定 1, 1）× `screen` を四捨五入（最小 1）。`Format` は大文字小文字と `D3DFMT_` の有無を無視して、`A8R8G8B8`・`X8R8G8B8`・`A8B8G8R8` → `rgba8`、`A16B16G16R16F` → `rgba16f`、`A32B32G32R32F` → `rgba32f`、`R16F` → `r16f`、`R32F` → `r32f`、`G16R16F` → `rg16f`、`G32R32F` → `rg32f`、`D24S8`・`D24X8`・`D16` → `depth24stencil8`。なければ色は `rgba8`、深度は `depth24stencil8`。知らない形式は既定にして `warnings` に足す。`MipLevels` が 1 なら `mipmaps: false`、0 か 2 以上なら `true`（深度はいつも `false`）。

- [ ] **Step 1: 失敗するテストを書く**

```ts
it('MMDPass・Subset・UseTexture で選ぶ', () => {
  // technique T0<MMDPass="object"; bool UseTexture=false;>, T1<MMDPass="object"; bool UseTexture=true; string Subset="0-1";>, T2<MMDPass="edge">{}
  expect(pick({ pass: 'object', subset: 0, useTexture: true })?.name).toBe('T1');
  expect(pick({ pass: 'object', subset: 2, useTexture: true })).toBeNull();
  expect(pick({ pass: 'edge' })?.passes).toEqual([]);
  expect(pick({ pass: 'object_ss', subset: 0, useTexture: false })?.name).toBe('T0');  // object_ss がなければ object
});
it('subsetMatcher', () => { const m = subsetMatcher('0-3,5,8-'); expect([0, 3, 4, 5, 7, 8, 99].map(m)).toEqual([true, true, false, true, false, true, true]); });
it('ViewportRatio・Dimensions・Format・MipLevels', () => {
  expect(spec('texture2D T : RENDERCOLORTARGET < float2 ViewportRatio = {0.5, 0.5}; string Format = "D3DFMT_A16B16G16R16F"; >;', [801, 600]))
    .toEqual({ width: 401, height: 300, format: 'rgba16f', mipmaps: false, warnings: [] });  // MipLevels がなければ 1 とみなす
  expect(spec('texture2D T : RENDERCOLORTARGET < int2 Dimensions = {256, 128}; int MipLevels = 0; >;', [800, 600])).toMatchObject({ width: 256, height: 128, mipmaps: true });
  expect(spec('texture2D D : RENDERDEPTHSTENCILTARGET;', [800, 600], true)).toMatchObject({ format: 'depth24stencil8' });
});
```

（注: `MipLevels` の既定は D3DX と同じく「なし → 1」とし、テストで固定する。）

- [ ] **Step 2: 落ちることを確かめる** — Run: `npx vitest run src/core/mme` / Expected: FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確かめる** — 同じコマンド / Expected: PASS
- [ ] **Step 5: コミット** — `git commit -m "MME ランタイム: technique の選び方とレンダーターゲットの大きさ"`

---

### Task 5: Script の実行（`core/mme/script.ts`）

**Files:**
- Create: `src/core/mme/script.ts`
- Test: `src/core/mme/script.test.ts`

**Interfaces:**
- Consumes: `Technique`・`Pass`・`ScriptCommand`（desc.ts）
- Produces:

```ts
export interface ScriptBackend {
  setColorTarget(index: number, name: string | null): void;  // '' は null (既定の描画先)
  setDepthTarget(name: string | null): void;
  setClearColor(param: string): void; setClearDepth(param: string): void; setClearStencil(param: string): void;
  clear(what: 'color' | 'depth' | 'stencil'): void;
  drawPass(pass: Pass, mode: 'geometry' | 'buffer'): void;
  drawExternal(): void;                          // ScriptExternal=Color
  loopCount(param: string): number;              // LoopByCount の回数 (パラメータの値を整数に)
  setLoopIndex(param: string, i: number): void;  // LoopGetIndex
  warn(message: string): void;
}
export function runTechnique(tech: Technique, kind: 'object' | 'post', backend: ScriptBackend): void;
```

決まり:
- technique の `script` が空なら、pass を宣言の順にすべて描く。ポストエフェクトで `script` が空なら、`warn` してから同じようにする（`ScriptExternal` は呼ばない）。
- `Pass=名前` は、その technique の中の pass を名前で探し、その pass の `script` を実行する。pass の `script` に `Draw` がなければ、物では `Draw=Geometry`、ポストエフェクトでは `Draw=Buffer` として 1 回描く。pass の `script` の中の `RenderColorTarget` などもそのまま実行する。
- `LoopByCount=p` から `LoopEnd` までをくり返し（入れ子も）、`LoopGetIndex=q` はその時点の回数（0 から）を入れる。
- `ScriptExternal=Color` は `kind === 'post'` のときだけ `drawExternal()`、物では `warn` して無視。知らない命令・名前のない `Pass` は `warn`。

- [ ] **Step 1: 失敗するテストを書く**（呼ばれた順を文字列の配列に記録する偽の backend）

```ts
it('ポストエフェクト: 描画先・消す・ScriptExternal・pass の順', () => {
  expect(log(POST_FX)).toEqual(['color0=ScnMap', 'depth=DepthBuffer', 'clearColor=ClearColor', 'clear:color', 'external', 'color0=', 'pass:Blur:buffer']);
});
it('LoopByCount と LoopGetIndex (入れ子)', () => {
  // "LoopByCount=N; LoopGetIndex=I; Pass=P; LoopEnd=;" で N = 3 → index 0,1,2 と pass 3 回
});
it('script が空の物の technique は pass を順に Draw=Geometry で描く', ...);
it('物の ScriptExternal は warn して無視', ...);
```

- [ ] **Step 2: 落ちることを確かめる** — Run: `npx vitest run src/core/mme/script.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確かめる** — 同じコマンド / Expected: PASS
- [ ] **Step 5: コミット** — `git commit -m "MME ランタイム: Script の実行"`

---

### Task 6: CPU の変形（`core/mme/skinning.ts`）

**Files:**
- Create: `src/core/mme/skinning.ts`
- Test: `src/core/mme/skinning.test.ts`

**Interfaces:**
- Produces:

```ts
export const SKIN = { BDEF1: 0, BDEF2: 1, BDEF4: 2, SDEF: 3, QDEF: 4 } as const; // (enum は使わない)
export interface SkinData {
  count: number;
  type: Uint8Array;        // 頂点ごとの SKIN の値
  bones: Int32Array;       // 頂点ごとに 4 つ (使わない所は 0)
  weights: Float32Array;   // 頂点ごとに 4 つ
  sdef: Float32Array;      // 頂点ごとに 9 つ (C, R0, R1。左手系)。SDEF 以外は 0
}
// base: 左手系の位置 (count×3)。deltas: 頂点モーフの差分 (左手系、相対)。weights と同じ数
export function applyMorphs(base: Float32Array, deltas: Float32Array[], weights: ArrayLike<number>, out: Float32Array): void;
// bones: 骨ごとの変形の行列 (左手系、列ベクトルの書き方の elements、16 個ずつ)。位置と法線は左手系
export function skin(data: SkinData, positions: Float32Array, normals: Float32Array, bones: Float32Array, outPos: Float32Array, outNrm: Float32Array): void;
// 補足 5 の式。eye は物の空間のカメラの位置、edgeSize は頂点ごとの輪郭線の太さ
export function expandEdges(pos: Float32Array, nrm: Float32Array, edgeSize: Float32Array, eye: [number, number, number], tanHalfFovY: number, out: Float32Array): void;
```

SDEF の式（MMD と同じ。テストの値はこの式で手計算する）:

```text
w0, w1 = 重み; M0, M1 = 骨の変形行列; q0, q1 = M0, M1 の回転の四元数
rw  = R0 * w0 + R1 * w1
r0  = C + R0 - rw ;  r1 = C + R1 - rw
cr0 = (C + r0) / 2;  cr1 = (C + r1) / 2
q   = slerp(q0, q1, w1)           (q0 と q1 の内積が負なら q1 を反転してから)
位置 = rotate(q, P - C) + (M0 · cr0) * w0 + (M1 · cr1) * w1
法線 = rotate(q, N)
```

BDEF1/2/4・QDEF（BDEF4 として）: 位置 = Σ wᵢ (Mᵢ · P)、法線 = normalize(Σ wᵢ (Mᵢ の 3×3 · N))。

- [ ] **Step 1: 失敗するテストを書く**

```ts
it('BDEF は three.js の applyBoneTransform と同じ (左手系に直して比べる)', () => {
  // three.js の SkinnedMesh (骨 2 本、2 本目を z まわりに 30°) を作り、頂点ごとに applyBoneTransform した位置を toMmdVec で直す。
  // 同じ骨の行列を toMmd で直して skin() に渡した結果と、1e-5 で一致
});
it('SDEF は上の式どおり (手で作った 1 頂点)', ...);
it('SDEF で重みが 0/1 のときは BDEF1 と同じ', ...);
it('頂点モーフは重み付きで足す', ...);
it('expandEdges: 法線 × (太さ / 300) × 距離 × tan(半分の視野)', () => {
  // 位置 (0,0,0)、法線 (1,0,0)、太さ 300、eye (0,0,-10)、tan = 0.5 → (5, 0, 0)
});
```

- [ ] **Step 2: 落ちることを確かめる** — Run: `npx vitest run src/core/mme/skinning.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装する** — 毎フレーム呼ぶので、関数の中で配列や `Vector3` を作らない（行列の数を直接読む）。
- [ ] **Step 4: 通ることを確かめる** — 同じコマンド / Expected: PASS
- [ ] **Step 5: コミット** — `git commit -m "MME ランタイム: CPU の変形 (BDEF・SDEF・QDEF・頂点モーフ・輪郭線)"`

---

### Task 7: MMD のデータを残す（テスト用の .pmx・`mmdData.ts`・トゥーンとスフィア）

**Files:**
- Create: `src/core/testing/pmx.ts`（`e2e/fixtures/pmx.ts` の中身を移す）、`src/engine/mme/mmdData.ts`
- Modify: `e2e/fixtures/pmx.ts`（`export * from '../../src/core/testing/pmx.ts';` だけにする）、`src/engine/materials/fromMmd.ts`
- Test: `src/engine/mme/mmdData.test.ts`、`src/engine/materials/materials.test.ts`（足す）

**Interfaces:**
- Consumes: `SkinData`・SKIN の値（Task 6）
- Produces:

```ts
// src/core/testing/pmx.ts (makePmx に選択肢を足す。既定は今までと同じバイト列)
export function makePmx(name?: string, opts?: { physics?: boolean; texture?: string; flags?: number /* 既定 0x01 | 0x10 */; sdef?: boolean /* 上の 4 頂点を SDEF にする */ }): Uint8Array;
// mmdData.ts
export interface MmdMaterialInfo { flags: number; sphereMode: 0 | 1 | 2 | 3; edgeSize: number }   // flags: 0x02 地面の影・0x04 セルフシャドウの深度に描く・0x08 セルフシャドウを受ける・0x10 輪郭線
export interface MmdData { skin: SkinData; materials: MmdMaterialInfo[]; vertexEdgeSize: Float32Array /* 補足 5 */ }
export async function readMmdData(pmx: Blob | ArrayBuffer): Promise<MmdData>;
// fromMmd.ts: convertMmdMesh が mesh.userData.mmeTextures を残す
//   mesh.userData.mmeTextures: { toon: THREE.Texture | null; sphere: THREE.Texture | null }[]  (材質ごと。MMDToonMaterial の gradientMap と matcap)
```

決まり:
- `readMmdData` は手元の `mmdparser`（`src/vendor/three-mmd/mmdparser.module.js`）で、**左手系のまま**（`parsePmx(buffer, false)`）読む。`mmdparser` は SDEF を BDEF2 に書き換えるが `skinC`・`skinR0`・`skinR1` は残すので、それがある頂点を SDEF にする。QDEF（`type === 4`）は QDEF。
- `vertexEdgeSize[i]` = その頂点を最初に使う材質の輪郭線の太さ × 頂点の `edgeRatio`。
- `convertMmdMesh` は、材質を捨てる前に `gradientMap` と `matcap` を `mmeTextures` に入れる（材質の `dispose` はテクスチャを捨てないので、そのまま残る）。

- [ ] **Step 1: 失敗するテストを書く**

```ts
it('makePmx の既定のバイト列は今までと同じ', () => { /* 移す前のファイルから作ったバイト列のハッシュを、テストの中の定数と比べる */ });
it('readMmdData: 変形の種類・骨・重み・材質のフラグ・輪郭線', async () => {
  const d = await readMmdData(makePmx('t', { flags: 0x01 | 0x02 | 0x04 | 0x08 | 0x10, sdef: true }).buffer);
  expect(d.skin.count).toBe(8);
  expect([...d.skin.type]).toEqual([0, 0, 0, 0, 3, 3, 3, 3]);
  expect(d.materials).toEqual([{ flags: 0x1f, sphereMode: 0, edgeSize: 1 }]);
  expect(d.vertexEdgeSize[0]).toBe(1);
  expect(d.skin.sdef.slice(36, 39)).not.toEqual(new Float32Array(3));  // 5 番目の頂点の C
});
it('convertMmdMesh はトゥーンとスフィアのテクスチャを残す', ...);   // materials.test.ts
```

- [ ] **Step 2: 落ちることを確かめる** — Run: `npx vitest run src/engine` / Expected: FAIL
- [ ] **Step 3: 実装する** — `src/core/testing/` は i18n のテストの対象外にしなくてよい（`t()` を使わない）。
- [ ] **Step 4: 通ることを確かめる** — Run: `npx vitest run` と `npx playwright test e2e/mmd.spec.ts e2e/physics.spec.ts`（.pmx の作り方を移したため） / Expected: PASS
- [ ] **Step 5: コミット** — `git commit -m "MME ランタイム: .pmx の変形の情報・材質のフラグ・トゥーンとスフィアを残す"`

---

### Task 8: 変形した形（`engine/mme/Skinner.ts`）

**Files:**
- Create: `src/engine/mme/Skinner.ts`
- Test: `src/engine/mme/Skinner.test.ts`

**Interfaces:**
- Consumes: `skin`・`applyMorphs`・`expandEdges`（Task 6）、`readMmdData`・`MmdData`（Task 7）、`toMmd`・`toMmdVec`（Task 2）
- Produces:

```ts
export interface MmeGeometry {
  geometry: THREE.BufferGeometry; // 属性: a_POSITION・a_NORMAL (左手系)・a_TEXCOORD0 (UV)・a_TEXCOORD1.. (追加 UV) と、a_POSITION と同じものを position にも。index と groups は元の形のもの
  edge: THREE.BufferGeometry | null; // a_POSITION を輪郭線の分だけ広げたもの (ほかの属性・index・groups は geometry と共有)。MMD モデルだけ
}
export class Skinner {
  // MMD モデル: 初めて呼ばれたら .pmx を読み始めて null を返し、読み終えたら onReady を呼ぶ。読み終えていれば、変形して返す
  mmd(mesh: THREE.SkinnedMesh, eyeWorld: THREE.Vector3, tanHalfFovY: number, onReady: () => void): MmeGeometry | null;
  // MMD でない物 (形・ステージの静的な部分): 左手系の写し。元の形の uuid と version が同じあいだは作り直さない
  plain(mesh: THREE.Mesh): MmeGeometry;
  data(mesh: THREE.SkinnedMesh): MmdData | null;   // 読み終えた変形の情報 (材質のフラグに使う)
  dispose(): void;
}
```

決まり:
- 骨の行列は、`mesh.skeleton.update()` のあとの `skeleton.boneMatrices` と `bindMatrix`・`bindMatrixInverse` から `bindMatrixInverse · boneMatrix · bindMatrix` を作り、`toMmd` で左手系に直す。頂点モーフは `geometry.morphAttributes.position`（相対）× `morphTargetInfluences` を、z を反転して `applyMorphs` に渡す。
- 骨の行列・モーフの重み・カメラ（輪郭線用）が前の計算と同じなら計算し直さない（数の並びを比べる）。
- .pmx は `mesh.userData.sourceFile`（`File`）から読む。同じ `File` は 1 回だけ読む（クローンも共有）。
- 作り直した属性は `needsUpdate = true` にする。

- [ ] **Step 1: 失敗するテストを書く**（WebGL なし。three.js の `SkinnedMesh` を手で組む）

```ts
it('MMD モデル: a_POSITION は applyBoneTransform を左手系に直した値', async () => {
  // makePmx を MMDLoader なしで扱えるよう、SkinnedMesh を手で組み、userData.sourceFile に makePmx の File を入れる。
  // 1 回目は null と onReady、2 回目に形が返り、骨を曲げた位置が applyBoneTransform → toMmdVec と 1e-5 で一致
});
it('骨もカメラも変わらなければ作り直さない (属性の version が変わらない)', ...);
it('形 (MMD でない) は z を反転した写しで、位置を変えるまで同じものを返す', ...);
it('輪郭線の形は法線の向きに広がっている', ...);
```

- [ ] **Step 2: 落ちることを確かめる** — Run: `npx vitest run src/engine/mme/Skinner.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確かめる** — 同じコマンド / Expected: PASS
- [ ] **Step 5: コミット** — `git commit -m "MME ランタイム: 変形した形を持つ Skinner"`

---

### Task 9: `default.fx` と `EffectStore`

**Files:**
- Create: `src/engine/mme/default.fx`, `src/engine/mme/EffectStore.ts`
- Test: `src/engine/mme/EffectStore.test.ts`

**Interfaces:**
- Consumes: `compileEffect`・`EffectResult`（core/fx）、`normalizePath`（core/fx/source.ts）
- Produces:

```ts
export interface EffectFiles { name: string; entry: string; files: Map<string, File> }  // files のキーはフォルダからの相対パス ('/' 区切り)
export interface LoadedEffect {
  id: string; name: string; entry: string;
  result: EffectResult;                 // ok でなければ描かない
  bytes: Map<string, Uint8Array>;       // 読んだファイルの中身 (テクスチャもここから)
}
export class EffectStore {
  constructor(ui: UiChannel);
  readonly events: Emitter<{ changed: [] }>;
  readonly defaultEffect: LoadedEffect;                     // default.fx (import の ?raw)。コンパイルに失敗したら例外 (テストで防ぐ)
  static fxFilesIn(files: File[]): string[];               // フォルダの中の .fx の相対パス (webkitRelativePath から。先頭のフォルダ名は取る)
  async load(files: File[], entry: string): Promise<LoadedEffect>;  // 失敗しても LoadedEffect を返し、最初のエラーをお知らせに出す
  objectEffect(objId: number): LoadedEffect | null;
  setObjectEffect(objId: number, e: LoadedEffect | null): void;
  readonly posts: { effect: LoadedEffect; enabled: boolean }[];
  addPost(e: LoadedEffect): void; movePost(i: number, d: -1 | 1): void; setPostEnabled(i: number, on: boolean): void; removePost(i: number): void;
  forgetObject(objId: number): void;                        // 物を消したとき
}
```

`default.fx` の中身（MME の `full.fx` の考え方を自分で書く。ライセンスのあるファイルを写さない）:
- `object`・`object_ss`（`UseTexture`・`UseSphereMap`・`UseToon` の有無の組み合わせは、bool の uniform 引数で 1 つの関数にまとめる）: `色 = saturate(MaterialAmbient * LightAmbient + MaterialEmissive)`、`拡散 = (MaterialDiffuse * LightDiffuse)`（MME の決まりでライトの DIFFUSE は 0 なので、アルファだけが効く）。テクスチャ・スフィア（`spadd` で加算か乗算）・トゥーン（法線とライトの向きの内積で `MATERIALTOONTEXTURE` を引く）・反射（`pow(max(0, dot(半ベクトル, 法線)), SpecularPower) * MaterialSpecular * LightSpecular`）。`object_ss` は `register(s0)` のサンプラー（セルフシャドウの深度）と `Object = "Light"` の行列で影の中か調べ、影ならトゥーンの暗い側の色にする。
- `zplot`: ライトの行列で変換し、`z / w` を `R` に書く。
- `shadow`: `WorldViewProjection` を掛けて `GroundShadowColor` を書く（`AlphaBlendEnable = TRUE`、`SrcBlend = SRCALPHA`、`DestBlend = INVSRCALPHA`）。
- `edge`: `WorldViewProjection` を掛けて `EdgeColor` を書く（`CullMode = CW`）。

- [ ] **Step 1: 失敗するテストを書く**

```ts
it('default.fx はエラーも警告もなくコンパイルでき、5 つの MMDPass の technique がある', () => {
  const r = new EffectStore(fakeUi()).defaultEffect.result;
  expect(r).toMatchObject({ ok: true, warnings: [] });
  // object・object_ss・zplot・shadow・edge それぞれに pickTechnique が technique を返す
});
it('fxFilesIn は webkitRelativePath の先頭のフォルダを取り、.fx だけを返す', ...);
it('load: サブフォルダの #include を大文字小文字を無視して読む', ...);
it('load に失敗しても LoadedEffect を返し、お知らせに最初のエラーを出す', ...);
it('物の割り当て・ポストエフェクトの並べ替え・オン・オフ・外す・物を消したら割り当ても消える', ...);
```

- [ ] **Step 2: 落ちることを確かめる** — Run: `npx vitest run src/engine/mme/EffectStore.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装する** — `.fx` を `?raw` で import するため、必要なら `src/vite-env.d.ts` などに `declare module '*.fx?raw'` を足す。
- [ ] **Step 4: 通ることを確かめる** — 同じコマンド / Expected: PASS
- [ ] **Step 5: コミット** — `git commit -m "MME ランタイム: default.fx と EffectStore"`

---

### Task 10: pass ごとの材質（`engine/mme/EffectInstance.ts`）

**Files:**
- Create: `src/engine/mme/EffectInstance.ts`
- Test: `src/engine/mme/EffectInstance.test.ts`

**Interfaces:**
- Consumes: `LoadedEffect`（Task 9）、`semanticValue`・`textureRole`・`SemanticContext`（Task 3）、`RenderState`・`Program`・`SamplerDecl`（desc.ts）、`resolveFile`（core/fx/source.ts）
- Produces:

```ts
export function cullSide(cull: string /* 'NONE' | 'CW' | 'CCW' */, flipY: 1 | -1): THREE.Side;
export function applyStates(m: THREE.Material, states: RenderState[], flipY: 1 | -1): string[];  // 警告
export interface DrawBuiltins { flipY: 1 | -1; halfPixel: [number, number]; viewport: [number, number] }
export interface TextureSource {
  role(name: string): THREE.Texture | null;   // 'material' | 'sphere' | 'toon' | 'selfShadow' と、レンダーターゲットの名前 (Task 12 が渡す)
}
export class EffectInstance {
  constructor(effect: LoadedEffect, requestDraw: () => void);
  material(pass: Pass, flipY: 1 | -1): THREE.RawShaderMaterial | null;   // program がない pass は null。flipY ごとに面の向きを変えた材質
  bind(m: THREE.RawShaderMaterial, pass: Pass, ctx: SemanticContext, builtins: DrawBuiltins, textures: TextureSource): void;
  param(name: string): number[] | null; setParam(name: string, values: number[]): void;  // Script の LoopGetIndex・ClearSetColor などが使う
  readonly warnings: string[];   // 値を入れないセマンティクス・無視したステート・読めないテクスチャ (同じものは 1 回)
  dispose(): void;
}
```

`cullSide` の表（three.js は `frontFace` を CCW にしているので、`FrontSide` は「CW を消す」）:

| `CullMode` | `flipY = 1` | `flipY = −1` |
|---|---|---|
| `NONE` | `DoubleSide` | `DoubleSide` |
| `CCW`（既定） | `BackSide` | `FrontSide` |
| `CW` | `FrontSide` | `BackSide` |

決まり:
- uniform の値: 宣言の初期値（`Param.init`）→ セマンティクス（`semanticValue`。`unsupported` は警告）→ 名前で決まる変数の順。`upload: 'mat4'` は補足 6 の詰め方。builtin の `mme_flipY`・`mme_halfPixel`・`mme_viewport` は `builtins` から。
- サンプラー: `texture` が `textureRole` で `material`/`sphere`/`toon`/`colorTarget` なら `textures.role(...)`（`colorTarget` はレンダーターゲットの名前）、`file` なら `ResourceName` をエフェクトのファイルから `resolveFile` で探して読む（png・jpg・bmp・gif・webp は `createImageBitmap`、tga は `TGALoader`、dds は `DDSLoader`。読み終えたら `requestDraw`）、`texture` がなく `register` が `s0` ならセルフシャドウの深度（`textures.role('selfShadow')`）。読めない・見つからないものは赤紫 (1, 0, 1, 1) の 1×1 で、警告。サンプラーごとに `Texture` の写し（`source` は共有）を作って、`MinFilter`・`MagFilter`・`MipFilter`・`AddressU/V/W`・`MaxAnisotropy` を移す。`BORDER` は `CLAMP` にして警告。すべて `NoColorSpace`・`flipY = false`。
- ステート: 設計書の「描画ステート」の節どおり。`AlphaTestEnable` が true なら警告。

- [ ] **Step 1: 失敗するテストを書く**（WebGL なし。材質と uniform の値だけを見る）

```ts
it('cullSide の表', () => { expect([cullSide('CCW', 1), cullSide('CCW', -1), cullSide('CW', 1), cullSide('NONE', -1)]).toEqual([THREE.BackSide, THREE.FrontSide, THREE.FrontSide, THREE.DoubleSide]); });
it('ステート: ブレンド・深度・色の書き込み・ステンシル', ...);
it('材質は #version の行を除いた GLSL と GLSL3', () => { const m = inst.material(pass, 1)!; expect(m.vertexShader.startsWith('#version')).toBe(false); expect(m.glslVersion).toBe(THREE.GLSL3); });
it('bind: WORLDVIEWPROJECTION・MATERIALDIFFUSE・builtin・非正方の行列の詰め方', ...);
it('ResourceName のテクスチャをサブフォルダから大文字小文字と \\ を無視して探す (読めなければ赤紫と警告)', ...);  // Review Focus 5
it('同じテクスチャを違うサンプラーで使うと、設定の違う写しになる', ...);
```

- [ ] **Step 2: 落ちることを確かめる** — Run: `npx vitest run src/engine/mme/EffectInstance.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装する** — 画像を読む部分は、テストでは差し替えられるよう `decode(bytes, path): Promise<THREE.Texture>` を引数で受け取れるようにする（既定は本物）。
- [ ] **Step 4: 通ることを確かめる** — 同じコマンド / Expected: PASS
- [ ] **Step 5: コミット** — `git commit -m "MME ランタイム: pass ごとの材質とテクスチャ"`

---

### Task 11: 場面を描く（`MmeRenderer` の物の部分・`MmeEngine`・編集用の表示）

**Files:**
- Create: `src/engine/mme/MmeRenderer.ts`, `src/engine/mme/MmeEngine.ts`, `e2e/mme-helpers.ts`, `e2e/mme-scene.spec.ts`
- Modify: `src/engine/Engine.ts`（`readonly mme = new MmeEngine(...)`。`Effects` のあとに作る）
- Test: `src/engine/mme/MmeEngine.test.ts`、`e2e/mme-scene.spec.ts`

**Interfaces:**
- Consumes: Task 2〜10 のすべて、`Viewport`・`SceneGraph`・`World`・`Selection`・`Clock`
- Produces:

```ts
export interface MmeSettings { engine: 'standard' | 'mme'; selfShadow: boolean; shadowDistance: number; groundShadow: boolean }
export const MME_DEFAULTS: MmeSettings;   // { engine: 'standard', selfShadow: true, shadowDistance: 8875, groundShadow: true }
export class MmeEngine {
  readonly store: EffectStore;
  readonly settings: MmeSettings;
  set(patch: Partial<MmeSettings>): void;   // 変えたら描き直し。'standard' に戻したら資源を片付ける
  async loadEffect(files: File[], entry: string): Promise<LoadedEffect>;  // store.load の窓口 (画面と e2e が使う)
}
export class MmeRenderer {
  render(): boolean;                        // canvas に描く。false: 描けなかった (呼ぶ側が標準で描く)
}
```

決まり:
- `MmeEngine` は作るときに、いまの `viewport.drawOverride` を覚えて、`() => settings.engine === 'mme' ? renderer.render() : 前の?.() ?? false` に差し替える。`render` が例外を出したら、`console.error` とお知らせ（同じ文は 1 回）を出して `false` を返す。
- 描く物: `world.objects` の `node` の中の見えている `Mesh`（祖先まで `visible`。`userData.editorOnly` は除く）とステージ。書き出し中（`viewport.outputting`）は `hideRender` の物を除く。`SkinnedMesh` で `userData.sourceFile` があれば MMD モデル（`skinner.mmd`）、それ以外は `skinner.plain`。MMD モデルの .pmx を読み終えていなければ、そのフレームは飛ばす（読み終えたら `requestDraw`）。
- 材質の値（`MaterialState`）: MMD モデルは `MaterialLibrary` の `mmd`（`MmdSource`）と `mmeTextures`・`readMmdData` のフラグから、形は設計書の「形の材質」の式から。`TOONCOLOR` はトゥーンのテクスチャのいちばん下の行の色（1 回だけ読む）。
- 1 フレームの順番は設計書の「1 フレームの流れ」の 2（場面）。セルフシャドウの深度は補足 3。ライト（`LightState`）は `SceneGraph` の太陽から（色の式は設計書のとおり。影のカメラは `sun.shadow.camera` を `toMmd`/`orthoD3D` で直したもの。その縦横の広さに `shadowDistance / 8875` を掛ける（既定の 8875 で標準のエンジンと同じ範囲、数を大きくすると広い範囲に影が落ちる）。`groundShadow` が false なら `shadow` の pass を描かず、`selfShadow` が false なら `zplot` を描かずに `object` を使う）。
- 描く呼び出し: `renderer.renderBufferDirect(camera, null, geometry, material, mesh, group)`（`group` は材質の部分）。描く前に `EffectInstance.bind`。
- 場面の背景は補足 1。描き終えたら、書き出し中でなければ編集用の表示を重ねる: グリッドと `userData.editorOnly` の物を、ほかを隠した状態で `renderer.render(scene, camera)`（`autoClear = false`、深度は MME の描画のものを使う）。選んでいる物の輪郭線は、いまの `OutlineEffect` の `renderOutline` で、選んでいる物だけを見せて描く。
- `window.engine.mme` から e2e が使えるようにする（`?debug` のときの `window.engine` に含まれる）。

- [ ] **Step 1: 失敗するテストを書く**

エンジンのテスト（描画先なし）:
```ts
it('engine を mme にすると drawOverride が MME の描画を呼び、standard に戻すと前の描画に戻る', ...);
it('render が例外を出したら false を返し、お知らせを 1 回だけ出す', ...);
```

e2e（`e2e/mme-helpers.ts` に、文字列から `File` を作って `engine.mme.loadEffect` に渡す関数と、PNG を書き出して決まった画素を読む関数を置く。テスト用の .pmx は `makePmx` を `engine.loadFiles` で読む）:
```ts
test('default.fx: 材質の色・輪郭線・地面の影', ...);   // 色は MMD の式 saturate(拡散色 × ライトの色 + 環境色) で計算した値と ±3/255
test('default.fx: セルフシャドウで片方の箱にもう片方の影が落ちる', ...);
test('物の .fx: 単色の .fx でその色、MATERIALDIFFUSE を出す .fx で材質の色 (ちょうど)', ...);
test('上が赤・下が青の画像を貼ると上が赤 (テクスチャの向きとガンマ空間)', ...);  // 色がちょうど (255, 0, 0) と (0, 0, 255)
test('片面の四角は表からだけ見える (CullMode = CCW)', ...);
test('骨を曲げたモデルの輪郭が標準のエンジンとほぼ同じ (違う画素が 1% 未満)、輪郭線の太さも ±1 画素', ...);
test('hidden の物はビューポートに出ず、hideRender の物は書き出しに出ない', ...);   // Review Focus 2
test('.pmx を読み終える前の最初のフレームでも止まらず、あとでモデルが出る', ...);  // Review Focus 4
test('壊れた .fx を当てるとお知らせが出て、モデルは default.fx で描かれる', ...);
test('選んでいる物の輪郭線がビューポートに出る (書き出しには出ない)', ...);
```

- [ ] **Step 2: 落ちることを確かめる** — Run: `npx vitest run src/engine/mme` と `npx playwright test e2e/mme-scene.spec.ts` / Expected: FAIL
- [ ] **Step 3: 実装する** — `default.fx` の見た目の調整はこのタスクで行ってよい（Task 9 のテストは保つ）。
- [ ] **Step 4: 通ることを確かめる** — Run: `npx vitest run`、`npx playwright test e2e/mme-scene.spec.ts`、`E2E_GL=software npx playwright test e2e/mme-scene.spec.ts`、`npx playwright test`（標準の絵が変わらないこと） / Expected: すべて PASS
- [ ] **Step 5: コミット** — `git commit -m "MME ランタイム: 物の .fx で場面を描く"`

---

### Task 12: ポストエフェクトとレンダーターゲット（`Framebuffers.ts`・`MmeRenderer` のポストエフェクトの部分）

**Files:**
- Create: `src/engine/mme/Framebuffers.ts`, `e2e/mme-post.spec.ts`
- Modify: `src/engine/mme/MmeRenderer.ts`
- Test: `e2e/mme-post.spec.ts`

**Interfaces:**
- Consumes: `runTechnique`・`ScriptBackend`（Task 5）、`targetSpec`（Task 4）、`EffectInstance`（Task 10）
- Produces:

```ts
export class Framebuffers {
  constructor(renderer: THREE.WebGLRenderer);
  // エフェクトの RENDERCOLORTARGET・RENDERDEPTHSTENCILTARGET を、いまの画面の大きさで用意する (大きさが変われば作り直す)
  prepare(effect: LoadedEffect, screen: [number, number]): string[];   // 警告
  colorTexture(effect: LoadedEffect, name: string): THREE.Texture | null;   // サンプラーに渡すテクスチャ
  // 色のターゲット (最大 4 つ。null は既定) と深度のターゲット (null は既定) を描画先にする。既定の色が canvas なら canvas
  bind(effect: LoadedEffect | null, colors: (string | null)[], depth: string | null): { flipY: 1 | -1; size: [number, number] };
  clear(color: [number, number, number, number] | null, depth: number | null, stencil: number | null): void;
  afterDraw(): void;   // mipmaps のあるターゲットのミップを作る
  dispose(): void;
}
```

決まり:
- 補足 7 のやり方でフレームバッファを作り、組み合わせごとに覚えておく。浮動小数の形式に描けなければ `rgba8` にして警告。MRT は `gl.drawBuffers`。
- 入れ子: ポストエフェクトがあれば、いちばん外側から順に `runTechnique(..., 'post', backend)`。`drawExternal()` で 1 つ内側を描く。いちばん内側（場面）を描く描画先は、その時点の描画先（Script が `RenderColorTarget` で選んだもの）。ポストエフェクトが「既定の描画先」と言ったときの描画先は、いちばん外側では canvas、内側では 1 つ外側のエフェクトがそのとき選んでいる描画先。
- `Draw=Buffer` は描画先いっぱいの四角（`a_POSITION` = (±1, ±1, 0, 1)、`a_TEXCOORD0` = (u, v) で v = 0 が上）を描く。`ClearSetColor` などはパラメータの値を使う。
- `VIEWPORTPIXELSIZE` と `ViewportRatio` の基準は、いまの描画先の canvas の大きさ（書き出し中は書き出しの大きさ）。

- [ ] **Step 1: 失敗するテストを書く**（e2e。ポストエフェクトは `e2e/mme-helpers.ts` の文字列から読む）

```ts
test('色の反転: 1 − 元の色', ...);
test('ViewportRatio = 0.5 の中間のレンダーターゲットを使う 2 pass のぼかし', ...);   // 縦横の線がにじんで、真ん中の値が期待どおり
test('LoopByCount と LoopGetIndex: 3 回足して 3 倍', ...);
test('MRT: COLOR0・COLOR1 を別のターゲットに書き、2 つ目を表示', ...);
test('レンダーターゲットの左上を読むと場面の左上', ...);
test('VPOS.y は上の行が 0', ...);
test('ViewportOffset を足して 1:1 で写すと、市松模様がにじまない (半ピクセル)', ...);
test('同じ深度のターゲットを 2 つの色のターゲットで使うと、奥の物が隠れる', ...);
test('大きさを変えて 2 回書き出しても、ViewportRatio と VIEWPORTPIXELSIZE が書き出しの大きさに合う', ...);  // Review Focus 3
test('ポストエフェクトの順番を入れ替えると結果が変わり、オフにすると飛ばされる', ...);
```

- [ ] **Step 2: 落ちることを確かめる** — Run: `npx playwright test e2e/mme-post.spec.ts` / Expected: FAIL
- [ ] **Step 3: 実装する** — 半ピクセルのテストが合わないときは、まず `mme_halfPixel` の符号（Global Constraints の式）を確かめ、直したら Global Constraints と設計書も直す。
- [ ] **Step 4: 通ることを確かめる** — Run: `npx playwright test e2e/mme-post.spec.ts`（GPU とソフトウェア）と `npx playwright test e2e/mme-scene.spec.ts` / Expected: PASS
- [ ] **Step 5: コミット** — `git commit -m "MME ランタイム: ポストエフェクトとレンダーターゲット"`

---

### Task 13: 設定の保存と画面

**Files:**
- Create: `src/ui/components/MmeEffectPicker.tsx`, `e2e/mme-ui.spec.ts`
- Modify: `src/engine/UiChannel.ts`（`UiState.mme`）、`src/engine/mme/MmeEngine.ts`、`src/engine/addons/builtins.ts`（場面の値 `mme`）、`src/ui/components/sidebar/OutputPage.tsx`、`src/ui/components/sidebar/FxPage.tsx`、`src/i18n/*.ts`
- Test: `src/engine/mme/MmeEngine.test.ts`（足す）、`e2e/mme-ui.spec.ts`

**Interfaces:**
- Consumes: `MmeEngine`・`EffectStore`（Task 9・11）
- Produces:

```ts
// UiChannel.ts
export interface MmeEffectUi { name: string; ok: boolean; errors: { code: string; where: string; message: string }[]; warnings: string[] }  // errors は最大 20
export interface MmeUiState { settings: MmeSettings; object: MmeEffectUi | null /* 選んでいる物の .fx */; posts: (MmeEffectUi & { enabled: boolean })[] }
// UiState に mme: MmeUiState
// builtins.ts: sceneData.add({ key: 'mme', label: msg('MME 互換'), save: () => ({ ...e.mme.settings }), load: raw => e.mme.set(normalizeMme(raw)), reset: () => e.mme.set({ ...MME_DEFAULTS }) })
export function normalizeMme(raw: unknown): MmeSettings;   // 知らない値は既定、shadowDistance は 0〜9999
```

画面:
- 出力のタブの先頭に「レンダーエンジン」の `BSelect`（標準 / MME 互換）。MME 互換のときだけ、その下に「セルフシャドウ」（`BCheck`）・「影の距離」（`NumField`、0〜9999）・「地面の影」（`BCheck`）。
- 効果のタブに「MME 互換」の `Panel`（レンダーエンジンが MME 互換のときだけ）。中身は設計書の「画面」のとおり。「読み込む…」は隠した `<input type="file" webkitdirectory>` を押し、`MmeEffectPicker` が補足 8 のとおり .fx を選ばせる。エラーは `<details>` で開ける一覧。ポストエフェクトの行は名前・オン・オフ（`BCheck`）・上へ・下へ・外す。「割り当てはページを開き直すと消えます」と書く。
- 部品はいまの `ui/components/controls/` のものを使い、ブラウザ標準の部品は使わない（ARCHITECTURE の決まり）。

- [ ] **Step 1: 失敗するテストを書く**

エンジンのテスト:
```ts
it('レンダーエンジンの設定をプロジェクトの場面の値として保存し、開き直すと戻る', ...);
it('normalizeMme: 知らない値は既定、影の距離は 0〜9999', ...);
it('MME 互換 → 標準 → MME 互換と行き来しても、標準に戻したときに MME の資源を片付ける', ...);   // Review Focus 1
```

e2e（`e2e/mme-ui.spec.ts`）:
```ts
test('出力のタブでレンダーエンジンを MME 互換にでき、効果のタブに MME 互換の欄が出る', ...);
test('フォルダを選んで .fx を読み (2 つあれば選ばせる)、選んでいる物に当たる。エラーの一覧を開ける', ...);  // setInputFiles
test('ポストエフェクトを足し、上下に並べ替え、オフにし、外せる', ...);
test('標準に戻すと絵が元どおり (MME 互換にする前の書き出しと同じ画素)', ...);   // Review Focus 1
```

- [ ] **Step 2: 落ちることを確かめる** — Run: `npx vitest run src/engine/mme src/i18n` と `npx playwright test e2e/mme-ui.spec.ts` / Expected: FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確かめる** — Run: `npx vitest run`、`npx playwright test e2e/mme-ui.spec.ts`（GPU とソフトウェア）、`npx playwright test e2e/layout.spec.ts e2e/mobile.spec.ts e2e/project.spec.ts` / Expected: PASS
- [ ] **Step 5: コミット** — `git commit -m "MME ランタイム: レンダーエンジンの設定の保存と画面"`

---

### Task 14: 速さを測る・文書

**Files:**
- Create: `scripts/mme-skin-bench.ts`
- Modify: `package.json`（`"mme:bench": "node scripts/mme-skin-bench.ts"`）、`ARCHITECTURE.md`、`README.md`

`scripts/mme-skin-bench.ts`: `src/core/mme/skinning.ts` だけを使い、5 万頂点（BDEF2 が 7 割・BDEF4 が 2 割・SDEF が 1 割）、骨 200 本、頂点モーフ 30 個（うち 5 個の重みが 0 でない）の合成データで、`applyMorphs` → `skin` → `expandEdges` を 200 回くり返し、1 回の平均（ms、小数 2 桁）を出す。

- [ ] **Step 1: スクリプトを書いて動かす** — Run: `npm run mme:bench` / Expected: 1 回の平均が表示される。8 ms を超えていたら、その数字を報告に書く（テストにはしない）。
- [ ] **Step 2: 文書を書き足す**
  - `ARCHITECTURE.md`: engine の表に `MmeEngine`・`EffectStore`・`EffectInstance`・`Skinner`・`MmeRenderer`・`Framebuffers` の行（役割と使う相手）、core の説明に `core/mme`、「毎フレームの流れ」に「レンダーエンジンが MME 互換なら、描画を `MmeEngine` が受け持つ」を足す。core/fx の注意書きは、この計画で決めたこと（`mme_halfPixel`・非正方の行列の `upload: 'mat4'`・`register`）に合わせて直す。
  - `README.md`: 「MME 互換モード（作っている途中）」の小節を、使い方（出力のタブのレンダーエンジン、効果のタブでフォルダを選ぶ、ポストエフェクトの一覧）、いまできること、できないこと（`OFFSCREENRENDERTARGET`・.x・`CONTROLOBJECT`・保存・パラメータの画面・UV モーフ・アルファテスト・Ray-MMD）に書き直し、測った CPU の変形の速さを書く。テストの一覧に `e2e/mme-*.spec.ts` を足す。
- [ ] **Step 3: 全体を確かめる** — Run: `npm run test:all` / Expected: 「すべて成功」
- [ ] **Step 4: コミット** — `git add scripts/mme-skin-bench.ts package.json ARCHITECTURE.md README.md && git commit -m "MME ランタイム: CPU の変形の速さを測るスクリプトと説明"`
