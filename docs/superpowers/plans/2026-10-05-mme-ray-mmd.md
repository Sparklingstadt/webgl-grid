# MME 互換モード 第 4 の計画: Ray-MMD で合格 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ray-MMD 1.5.2 の標準の構成＋ライトとフォグを、レンダーエンジン「MME 互換」で描き、割り当てと設定をプロジェクトに保存できるようにする。

**Architecture:** `MmeRenderer` から「割り当て表とターゲットを受け取って場面を描く」`ScenePass` を取り出し、画面・オフスクリーン・入れ子のオフスクリーンで使い回す。割り当ては物ごとの値（`objectData` の `mme`）、フォルダ・ポストエフェクト・仮のコントローラーは場面の値（`sceneData` の `mme`）、読んだファイルはプロジェクトの assets に入れる。純粋な計算（`DefaultEffect`・コントローラーの項目・DDS）は `core/mme` に置き、WebGL なしで単体テストする。

**Tech Stack:** TypeScript、three.js 0.186（RawShaderMaterial・WebGL2）、vitest、Playwright（SwiftShader でも動く）、React（サイドバー）。

**Spec:** `docs/superpowers/specs/2026-10-05-mme-ray-mmd-design.md`（前の計画: `docs/superpowers/specs/2026-10-05-mme-runtime-design.md`、次に回したこと: `docs/superpowers/notes/2026-10-05-mme-runtime-followups.md`）

## Global Constraints

- ブランチ `claude/ray-mmd-webgl-grid-port-16f15d`（第 2 の計画のブランチ）の上に作る。
- 合格の線は「標準の構成＋ライトとフォグ」: ray.fx（ポストエフェクト）・材質の .fx（`material_2.0.fx` と材質ごと）・空（Time of day）・`LightMap`（Lighting フォルダのすべての種類、`Default` の .fx）・`FogMap`（Fog フォルダの 4 種類）。
- Ray-MMD のバイナリは Git に入れない `fx/ray-mmd-1.5.2/` に置く（`fx/` は `.gitignore` 済み）。**取ってくる前に、ファイル名・出所（GitHub ray-cast/ray-mmd のタグ 1.5.2、263 ファイル・約 84 MB）・大きさをユーザーに確認する**（Task 4 の前。コントローラーが行う）。CI は自作の小さなファイルだけで確かめる。
- `ray_controller.pmx`（`_plus`・`_minus`）と `ray.x` は読まない。場面にない `CONTROLOBJECT` の名前は「仮のコントローラー」で、MME の欄のスライダー（0〜1）で値を入れる。ray.fx は `ray.x` なしでポストエフェクトとして足す。
- ライト・フォグ・空の .pmx はいままでどおり読み込む（形を使う）。
- 物の名前: MMD のモデルは .pmx のファイル名、それ以外は物の名前（`obj.name`、なければ種類の名前）。大文字小文字を無視して照らし合わせる。同じ名前が複数なら最初の 1 つ。
- `DefaultEffect`: `hide` は描かない、`none` は `default.fx` で描く、どの規則にも合わない物は描かない。パスは、宣言しているエフェクトのエントリーの .fx があるフォルダからの相対（大文字小文字・`\` はコンパイラと同じく吸収）。
- オフスクリーンは、宣言の逆の順に、1 フレームに 1 回だけ描く（入れ子は持ち主ごとに 1 回）。
- `TIME`・`ELAPSEDTIME` はタイムラインの時間から（いまの `Clock` のまま。止まっているとき `ELAPSEDTIME` は 0）。
- `ANIMATEDTEXTURE` とアクセサリの項目は、警告を出して止める（0 を渡す）。
- 警告・画面の文はすべて `t()` を通し、日本語・英語・簡体字・繁体字の辞書をそろえる（`src/i18n/i18n.test.ts` が見張る）。
- `src/core/mme` は three.js の数学と `core/i18n` だけを使い、Node で直接動く（消せる TypeScript の書き方だけ: parameter properties・enum・namespace なし）。`scripts/` から import するため。
- 標準のレンダーエンジンの絵と、第 2 の計画までのテストを変えない。
- コミットは小さく、日本語で「MME Ray-MMD: …」。末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`（実際にコミットしたモデルの名前）。
- 確かめるコマンド: `npx vitest run <範囲>`、`npm run typecheck`、`npm run lint`、`npx playwright test e2e/<spec>`（ハードウェア GL がなければ `E2E_GL=software`）。素の `git stash` は使わない。

## Review Focus

1. 同じ Ray-MMD のフォルダを 2 回読み込む（開き直したあとに足りないファイルを補うときも）→ フォルダは 1 つにまとまり、割り当ては切れない（Task 6 のテスト）。
2. 保存してある材質の番号が、モデルの材質の数より大きい・割り当てた物を消した → 黙って無視し、ほかの割り当ては生きている（Task 9 のテスト）。
3. 同じ種類のライト（`PointLight.pmx`）を 2 つ置く → それぞれ自分の `(self)` の値と、自分の影のオフスクリーンを持つ（Task 10・11 のテスト）。
4. 割り当ててすぐ（まだ 1 回も描かずに）.wgp に保存する → 開き直すと画像も入っている（Task 14 のテスト）。
5. 第 2 の計画の形（`mme` が設定だけ）のプロジェクトを開く → 設定はそのまま読まれ、エラーにならない（Task 14 のテスト）。

---

## ファイルの構成

| ファイル | 役目 | タスク |
|---|---|---|
| `src/core/fx/desc.ts`・`src/core/fx/` の desc を作る所 | `TextureDecl.shared`・`Param.shared` | 1 |
| `src/core/mme/defaultEffect.ts`（新） | `DefaultEffect` を読む・照らし合わせる | 2 |
| `src/core/mme/controllers.ts`（新）・`semantics.ts` | `CONTROLOBJECT` の項目を集める・値を渡す | 3 |
| `src/core/mme/dds.ts`（新）・`scripts/ray-survey.ts`（新） | DDS を読む・Ray-MMD の形式を調べる | 4 |
| `src/engine/mme/textures.ts`（新。`EffectInstance.ts` の `decodeTexture` を移す） | DDS・.hdr・.tga・.bmp を three.js のテクスチャにする | 5 |
| `src/engine/mme/EffectStore.ts` | フォルダ（文字は先に、画像はあとで読む）・読んだファイルの記録・コンパイルの使い回し | 6 |
| `src/engine/mme/Framebuffers.ts`・`PostChain.ts`・`core/mme/script.ts`・`core/mme/targets.ts` | `shared` のターゲット・形式・ミップ・`Clear=Depth` のステンシル | 7 |
| `src/engine/mme/ScenePass.ts`（新）・`MmeRenderer.ts` | 場面を描く処理を取り出す | 8 |
| `src/engine/mme/Assignments.ts`（新）・`core/mme/settings.ts`・`types.ts`・`builtins.ts` | 物ごと・材質ごとの割り当てと、その決め方 | 9 |
| `src/engine/mme/Offscreen.ts`（新） | オフスクリーン・入れ子・`OffscreenOwner` | 10 |
| `src/engine/mme/Controllers.ts`（新）・`src/core/testing/pmx.ts` | `CONTROLOBJECT` の値（場面の物・仮のコントローラー） | 11 |
| `PostChain.ts`・`MmeRenderer.ts` | `ScriptOrder`（preprocess）・ポストエフェクトのテクニックの選び方 | 12 |
| `src/ui/components/sidebar/FxPage.tsx`・`src/ui/components/MmeAssignTabs.tsx`（新）・`MmeControllers.tsx`（新） | 割り当てのタブ・コントローラーの欄 | 13 |
| `src/engine/project/ProjectIO.ts`・`format.ts`・`core/mme/settings.ts` | 保存・開く | 14 |
| `e2e/ray-mmd-local.spec.ts`（新）・README・ARCHITECTURE | 本物の Ray-MMD で確かめる・書き残す | 15 |

---

### Task 1: コンパイラの desc に `shared` を出す

**Files:**
- Modify: `src/core/fx/desc.ts`（`TextureDecl`・`Param`）、desc を組み立てる所（`storage` に `'shared'` があるか）
- Test: desc のテストがあるファイル（`src/core/fx/*.test.ts` のうち `TextureDecl` を確かめているもの）

**Interfaces:**
- Produces: `TextureDecl { …; shared: boolean }`、`Param { …; shared: boolean }`（Task 7・10 が使う）

- [ ] **Step 1: 失敗するテストを書く** — `shared texture A : RENDERCOLORTARGET; texture B : RENDERCOLORTARGET; shared float x;` を変換し、`textures` の A は `shared: true`、B は `false`、`params` の x は `shared: true` を確かめる。
- [ ] **Step 2: 走らせて失敗を見る** — `npx vitest run src/core/fx`。
- [ ] **Step 3: 実装** — AST の `storage` に `'shared'` があれば `true`。
- [ ] **Step 4: 走らせて通るのを見る** — `npx vitest run src/core/fx src/core/mme src/engine/mme`（既存のテストの期待値に `shared: false` が要れば足す）。`npm run fx:check` がエラー 0 のまま。
- [ ] **Step 5: コミット**

### Task 2: `DefaultEffect` を読む・照らし合わせる

**Files:**
- Create: `src/core/mme/defaultEffect.ts`、`src/core/mme/defaultEffect.test.ts`

**Interfaces:**
- Produces:
  - `type DefaultAction = { kind: 'effect'; path: string } | { kind: 'hide' } | { kind: 'none' }`
  - `interface DefaultRule { pattern: string; action: DefaultAction }`
  - `parseDefaultEffect(text: string): { rules: DefaultRule[]; warnings: string[] }` — `"pat = action;"` を `;` で区切る。前後の空白を除く。`=` のない項・空の項は警告して捨てる。`action` が `hide`/`none`（大文字小文字を無視）ならその種類、ほかは .fx のパス（`normalizePath` を通す。`./` を除く）。
  - `matchName(pattern: string, name: string): boolean` — `*`（0 文字以上）・`?`（1 文字）、大文字小文字を無視、全体一致。
  - `resolveDefault(rules: DefaultRule[], name: string, isSelf: boolean): DefaultAction | null` — 上から順に。パターン `self`（大文字小文字を無視）は `isSelf` のときだけ合う。どれにも合わなければ `null`（描かない）。

- [ ] **Step 1: 失敗するテストを書く**（Ray-MMD の実物の文字列を使う）
  - `parseDefaultEffect('"self = hide;" "*controller*.pmx=hide;" "*= ./Materials/material_2.0.fx;"' の連結後の文字列)` の規則が 3 つ、順番どおり、3 つ目の path が `Materials/material_2.0.fx`
  - `matchName('sky*box*.*', 'Sky with box.pmx') === true`、`matchName('*controller*.pmx', 'ray_controller.pmx') === true`、`matchName('PointLight.pmx', 'pointlight.PMX') === true`、`matchName('a?c', 'abbc') === false`
  - `resolveDefault(rules, 'ray_controller.pmx', false)` は hide、`resolveDefault(rules, 'ミク.pmx', true)` は hide（self が先）、`resolveDefault(rules, 'ミク.pmx', false)` は effect
  - 合わない名前は `null`、`'a=none'` の `none` は `{ kind: 'none' }`、`'broken'` は警告 1 つ
- [ ] **Step 2: 走らせて失敗を見る** — `npx vitest run src/core/mme/defaultEffect.test.ts`
- [ ] **Step 3: 実装**（警告は `t()` を通し、4 つの辞書に足す）
- [ ] **Step 4: 走らせて通るのを見る**（同じコマンドと `npx vitest run src/i18n`）
- [ ] **Step 5: コミット**

### Task 3: `CONTROLOBJECT` の項目を集め、値を渡す口を作る

**Files:**
- Create: `src/core/mme/controllers.ts`、`src/core/mme/controllers.test.ts`
- Modify: `src/core/mme/semantics.ts`（`UNSUPPORTED` から `CONTROLOBJECT` を外す。`SemanticContext` に `control`）、`semantics.test.ts`

**Interfaces:**
- Produces:
  - `type ControlType = 'float' | 'float3' | 'float4' | 'float4x4' | 'bool'`
  - `interface ControlRef { param: string; name: string; item: string | null; type: ControlType }`（`name` は注釈 `name` のまま。`item` は注釈 `item`、なければ `null`）
  - `controlRefs(desc: EffectDesc): ControlRef[]` — `semantic` が `CONTROLOBJECT` の param。型がこれ以外なら捨てる（呼ぶ側が警告）
  - `isSpecialName(name: string): boolean` — `(self)`・`(OffscreenOwner)`（大文字小文字を無視）
  - `virtualControls(refs: ControlRef[], present: (name: string) => boolean): Map<string, string[]>` — 特別な名前でも場面にある名前でもないものごとに、`type === 'float'` で `item` のある項目を、重複なく名前順で
  - `SemanticContext.control?: (ref: ControlRef) => number[] | null`（`null` は「値がない」= 0 を渡す）
- `semantics.ts`: `CONTROLOBJECT` の param は `ctx.control?.(ref)` の値。なければ型の大きさの 0。

- [ ] **Step 1: 失敗するテストを書く**
  - Ray-MMD の点光源の宣言（`float mR : CONTROLOBJECT<string name = "(self)"; string item = "R+";>;`、`float3 mPosition : CONTROLOBJECT<string name = "(self)"; string item = "Position";>;`、`float mMultiLightP : CONTROLOBJECT<string name = "ray_controller.pmx"; string item = "MultiLight+";>;`）を変換して `controlRefs` が 3 つ（型 float・float3・float）
  - `virtualControls(refs, () => false)` は `ray_controller.pmx → ['MultiLight+']` だけ（`(self)` は出ない）。`present` が `ray_controller.pmx` で true なら空
  - `semantics`: `control` が `[0.25]` を返すと `mMultiLightP` の値が `[0.25]`、`control` がないと `[0]`、float3 は `[0,0,0]`
- [ ] **Step 2: 走らせて失敗を見る** — `npx vitest run src/core/mme`
- [ ] **Step 3: 実装**
- [ ] **Step 4: 走らせて通るのを見る** — `npx vitest run src/core/mme src/engine/mme`（`CONTROLOBJECT` を「未対応」と期待していた既存のテストは、値 0 に直す）
- [ ] **Step 5: コミット**

### Task 4: DDS を読む・Ray-MMD の形式を調べる

この前に、コントローラーがユーザーに確認してから、Ray-MMD 1.5.2 のタグのファイルを `fx/ray-mmd-1.5.2/` に取ってくる（`git clone --depth 1 --branch 1.5.2 https://github.com/ray-cast/ray-mmd.git fx/ray-mmd-1.5.2` のあと `fx/ray-mmd-1.5.2/.git` を消す）。

**Files:**
- Create: `src/core/mme/dds.ts`、`src/core/mme/dds.test.ts`、`scripts/ray-survey.ts`、`docs/superpowers/notes/2026-10-05-ray-mmd-survey.md`
- Modify: `package.json`（`"ray:survey": "node scripts/ray-survey.ts"`）

**Interfaces:**
- Produces:
  - `type DdsFormat = 'rgba8' | 'bgra8' | 'bgrx8' | 'rg8' | 'r8' | 'rgba16f' | 'rgba32f' | 'rg16f' | 'rg32f' | 'r16f' | 'r32f' | 'rgba16' | 'dxt1' | 'dxt3' | 'dxt5'`（調べた結果で足りなければ足す）
  - `interface DdsLevel { width: number; height: number; data: Uint8Array | Uint16Array | Float32Array }`
  - `interface DdsImage { format: DdsFormat; width: number; height: number; cube: boolean; faces: DdsLevel[][] /* 面ごと (キューブは +X,-X,+Y,-Y,+Z,-Z)、ミップの段ごと */ }`
  - `ddsHeader(bytes: Uint8Array): { format: DdsFormat | string /* 読めない形式は FourCC か DXGI の番号の文字 */; width: number; height: number; mips: number; cube: boolean; volume: boolean }`
  - `parseDds(bytes: Uint8Array): DdsImage` — 読めない形式・ボリュームテクスチャ・壊れたファイルは `Error`（文は `t()`）。`DDPF_FOURCC` の D3DFMT の番号（113 = A16B16G16R16F、116 = A32B32G32R32F、111 = R16F、114 = R32F、112 = G16R16F、115 = G32R32F、36 = A16B16G16R16）と、`DX10` の拡張ヘッダー（DXGI_FORMAT）の両方を読む。マスクで書かれた 8 ビットの形式（A8R8G8B8・X8R8G8B8・A8B8G8R8・L8・A8L8・R8G8 相当）も読む。
- `scripts/ray-survey.ts` は `fx/ray-mmd-1.5.2/`（なければ止まって案内を出す）と `third_party/ray-mmd-1.5.2/` を読み、次を Markdown の表で書く:
  1. すべての .dds の形式（`ddsHeader`）・大きさ・ミップ・キューブ
  2. すべての .fx/.fxsub の `RENDERCOLORTARGET`・`RENDERDEPTHSTENCILTARGET`・`OFFSCREENRENDERTARGET` の `Format`・`MipLevels`・`Width`/`Height`/`ViewportRatio`・`shared` の有無（コンパイラの `compileEffect` で変換した desc から。`ray.conf` は標準のまま）
  3. `ResourceName` の拡張子ごとの数、`ScriptOrder`・`ScriptClass` の値

- [ ] **Step 1: 失敗するテストを書く** — テストの中で小さな DDS を組み立てる関数を作り、4×4 の `A8R8G8B8`（マスク）・`A16B16G16R16F`（FourCC 113）・`R32F`（FourCC 114）・DX10 の `R16G16B16A16_FLOAT`・DXT1・ミップ 3 段・キューブ（6 面）を読んで、形式・大きさ・各段の `data` の長さと先頭の値を確かめる。ボリュームテクスチャと 4 バイトに満たないファイルは `toThrow()`。
- [ ] **Step 2: 走らせて失敗を見る** — `npx vitest run src/core/mme/dds.test.ts`
- [ ] **Step 3: `dds.ts` を実装**
- [ ] **Step 4: 走らせて通るのを見る**
- [ ] **Step 5: `scripts/ray-survey.ts` を書き、`npm run ray:survey` で表を `docs/superpowers/notes/2026-10-05-ray-mmd-survey.md` に書く** — 表の DDS の形式がすべて `parseDds` で読めること（読めないものがあれば `dds.ts` に足し、テストも足す）。表の RT の形式のうち `Framebuffers` にないものを、表の下に「Task 7 で足す」と書く。
- [ ] **Step 6: コミット**（取ってきたバイナリは `fx/` なので入らないことを `git status` で確かめる）

### Task 5: 画像の形式（DDS・.hdr・.tga・.bmp）

**Files:**
- Create: `src/engine/mme/textures.ts`（`EffectInstance.ts` の `decodeTexture`・`cloneTexture` をここへ移す）、`src/engine/mme/textures.test.ts`
- Modify: `src/engine/mme/EffectInstance.ts`（import を直す）

**Interfaces:**
- Consumes: `parseDds`（Task 4）
- Produces: `decodeTexture(bytes: Uint8Array, path: string): Promise<THREE.Texture>`（形はいまと同じ）
  - `.dds` → `parseDds`。2D は `DataTexture`、キューブは `CubeTexture` 相当（いまの DDS のキューブの扱いと同じ型）、DXT は `CompressedTexture`（`WEBGL_compressed_texture_s3tc` がなければ、警告を出せるよう `Error`）。16 ビット浮動小数点は `HalfFloatType`、32 ビットは `FloatType`、ミップは `mipmaps` に並べる。three.js の `DDSLoader` は使わない。
  - `.hdr` → three.js の `HDRLoader`（0.186 の名前。なければ `RGBELoader`）で `HalfFloatType`
  - `.tga` → three.js の `TGALoader`
  - `.bmp`・`.png`・`.jpg` → いまのまま（ブラウザ）
  - どれも `flipY = false`、`colorSpace = NoColorSpace`（第 2 の計画の決まりのまま）

- [ ] **Step 1: 失敗するテストを書く** — Task 4 のテストの DDS を組み立てる関数を共有して（`src/core/testing/dds.ts` に移す）、`decodeTexture` が `A16B16G16R16F` の 2D を `HalfFloatType` の `DataTexture`（大きさ・ミップの数）に、キューブを 6 面のものにすることを確かめる。小さな .hdr（RGBE の文字のヘッダー＋2×1 の画素）と .tga（2×1 の無圧縮）も同じく。
- [ ] **Step 2: 走らせて失敗を見る** — `npx vitest run src/engine/mme/textures.test.ts`
- [ ] **Step 3: 実装**
- [ ] **Step 4: 走らせて通るのを見る** — `npx vitest run src/engine/mme`
- [ ] **Step 5: コミット**

### Task 6: エフェクトのフォルダ（文字は先に、画像はあとで）とコンパイルの使い回し

**Files:**
- Modify: `src/engine/mme/EffectStore.ts`、`EffectStore.test.ts`、`EffectInstance.ts`（画像を `folder.readBinary` から読む）、`MmeEngine.ts`
- Test: `EffectStore.test.ts`、`EffectInstance.test.ts`

**Interfaces:**
- Produces（Task 9・10・13・14 が使う）:
  - `interface EffectFolder { id: string; name: string; files: Map<string, File>; text: Map<string, Uint8Array>; used: Set<string> }` — キーはフォルダからの相対パス（`/` 区切り）。`text` は `.fx`・`.fxsub`・`.fxh`・`.conf`・`.txt` を読み込んだときに読んだもの。`used` は、コンパイルで読んだパスと、画像として読んだパス
  - `LoadedEffect { id: string; name: string; entry: string; folder: EffectFolder; result: EffectResult }`（`bytes` はなくなる）
  - `EffectStore.addFolder(files: File[]): Promise<EffectFolder>` — 同じ名前のフォルダがあれば、それにまとめる（ない相対パスだけ足す。同じパスで大きさが違えば新しいほうにし、そのフォルダのコンパイル結果を捨てる）
  - `EffectStore.folder(id: string): EffectFolder | null`、`EffectStore.folders(): EffectFolder[]`
  - `EffectStore.effect(folder: EffectFolder, path: string): LoadedEffect` — `folder.id` と正規化したパスで使い回す。パスは大文字小文字を無視して探す。初めて失敗したときだけお知らせを出す。ファイルがなければ `ok: false` の結果（コード `E_NOFILE` 相当のエラー）
  - `readBinary(folder: EffectFolder, path: string): Promise<Uint8Array | null>`（`EffectStore.ts` の関数。大文字小文字を無視して探し、見つかったら `used` に足す）
  - 既定の `default.fx` は `id: 'builtin'` のフォルダ
- `MmeEngine.loadObjectEffect(files, entry)`・`addPostEffect(files, entry)` は、`addFolder` してから `effect` を呼ぶ形に変える（画面はそのまま動く）。

- [ ] **Step 1: 失敗するテストを書く**
  - `addFolder` で 2 回同じフォルダ（同じ名前）を読むと `folders()` は 1 つ、2 回目にだけあったファイルが足される（Review Focus 1）
  - `effect` を同じパスで 2 回呼ぶと同じ `LoadedEffect`（`compileEffect` は 1 回）。`Shader/Math.fxsub` を `shader/math.fxsub` と include していても通る
  - 画像は `addFolder` のときに読まれない（`File.arrayBuffer` の呼ばれた数で確かめる）。`readBinary` で読むと `used` に入る
  - `EffectInstance` がファイルのテクスチャを `readBinary` から作る（いまのテストを直す）
- [ ] **Step 2: 走らせて失敗を見る** — `npx vitest run src/engine/mme`
- [ ] **Step 3: 実装**
- [ ] **Step 4: 走らせて通るのを見る** — `npx vitest run src/engine/mme` と `npx playwright test e2e/mme-ui.spec.ts e2e/mme-scene.spec.ts e2e/mme-post.spec.ts`
- [ ] **Step 5: コミット**

### Task 7: レンダーターゲット（`shared`・形式・ミップ・`Clear=Depth`）

**Files:**
- Modify: `src/engine/mme/Framebuffers.ts`、`src/core/mme/targets.ts`、`src/core/mme/script.ts`（`Clear=Depth`）、`src/engine/mme/PostChain.ts`
- Test: `Framebuffers.test.ts`、`targets.test.ts`、`script.test.ts`、`e2e/mme-post.spec.ts`

**Interfaces:**
- Consumes: `TextureDecl.shared`（Task 1）、調べた形式の表（Task 4 のノート）
- Produces:
  - `Framebuffers.prepare(effect, screen)` は、`shared` の `RENDERCOLORTARGET`・`RENDERDEPTHSTENCILTARGET` を、名前ごとに全体で 1 つにする（最初に注釈のある宣言の形・大きさで作る。注釈のない宣言はそれを使う。形・大きさが食い違えば警告を出して、そのエフェクトだけ別に作る）。`colorTexture(effect, name)`・`bind` は shared のものを返す。エフェクトを捨てても、ほかに使うエフェクトが残っていれば shared のものは捨てない
  - `targets.ts` の形式の表に、Task 4 で足りなかった形式を足す（WebGL2 の内部形式との対応）
  - `MipLevels` が 1 でないターゲット（0 はすべての段）は、そのターゲットへの描画が終わったあと（描画先を替えるとき・フレームの終わり）に `generateMipmap` する。`afterDraw` が受け持つ
  - 浮動小数点の形式のターゲットを作れない環境（`EXT_color_buffer_float` がない）では、それを宣言したエフェクトを止め（`EffectInstance.stopped`）、理由を警告に出す（いまの「8 ビットに落とす」ふるまいがあれば、それをやめる）
  - `Clear=Depth` は `fb.clear(null, clearDepth, clearStencil)`（ステンシルも消す）。e2e のコメント「Clear=Depth はステンシルを消さない」を直す

- [ ] **Step 1: 失敗するテストを書く**
  - `Framebuffers`: 2 つのエフェクトが `shared texture G : RENDERCOLORTARGET< float2 ViewportRatio={1,1}; string Format="A16B16G16R16F"; >;` と `shared texture G : RENDERCOLORTARGET;` を宣言 → `colorTexture` が同じテクスチャ。片方を `release` しても残る
  - `script`: `Clear=Depth` の命令がステンシルも消す値を出す
  - e2e（`mme-post.spec.ts` に足す）: エフェクト A（物の .fx）が `shared` の RT に赤を書き、ポストエフェクト B が同じ名前の `shared` の RT を読んで画面に出す → 画面が赤
  - `Framebuffers`: 浮動小数点に描けないと偽った renderer で、`A16B16G16R16F` を宣言したエフェクトが止まり、警告が 1 つ
  - e2e: `MipLevels = 0` の RT に縦縞を書き、`tex2Dlod(…, float4(uv, 0, 10))` で読むと平均の色
- [ ] **Step 2: 走らせて失敗を見る** — `npx vitest run src/engine/mme src/core/mme` と `npx playwright test e2e/mme-post.spec.ts`
- [ ] **Step 3: 実装**
- [ ] **Step 4: 走らせて通るのを見る**（同じコマンド）
- [ ] **Step 5: コミット**

### Task 8: 場面を描く処理（`ScenePass`）を取り出す

ふるまいを変えない作り替え。第 2 の計画の e2e がすべて通ること。

**Files:**
- Create: `src/engine/mme/ScenePass.ts`
- Modify: `src/engine/mme/MmeRenderer.ts`（`collect`・`item`・`subsets`・`drawItems`・`drawPass`・`drawGeometry`・`checkLink`・材質の状態づくりを移す）

**Interfaces:**
- Produces（Task 9・10 が使う）:
  - `type Slot = { kind: 'effect'; effect: LoadedEffect } | { kind: 'hide' }`
  - `type SlotFor = (obj: Obj | null /* ステージは null */, mesh: THREE.Mesh, materialIndex: number) => Slot`
  - `interface PassTable { name: string /* 'Main' かオフスクリーンの名前 */; slotFor: SlotFor; owner: Obj | null /* 入れ子のオフスクリーンの持ち主 */ }`
  - `class ScenePass { constructor(deps: ScenePassDeps); draw(table: PassTable, frame: FrameState, target: DrawTarget): void; whenReady(): Promise<void>; prune(): void; dispose(): void }`
  - `ScenePassDeps` は `MmeRendererDeps` から描くのに要るもの（`graph`・`world`・`library`・`stage`・`renderer` を返す関数・`instance(e: LoadedEffect): EffectInstance`・`skinner`・`warn`）
  - 骨の変形は `skinner` がフレームごとに覚えている（同じフレームで 2 回呼んでも計算は 1 回）ことを、テストで確かめる。覚えていなければ、フレームの番号で覚えるようにする
- `MmeRenderer` は Main の表（`slotFor` はいまの「物の .fx、なければ default.fx、ステージは default.fx」）で `ScenePass.draw` を呼ぶ。

- [ ] **Step 1: 失敗するテストを書く** — `Skinner`: 同じフレームの番号で同じ物を 2 回 `mmd()` すると、2 回目は骨の行列を計算しない（計算の回数を数える口を、テスト用に `ScenePass` か `Skinner` に作る）
- [ ] **Step 2: 走らせて失敗を見る** — `npx vitest run src/engine/mme`
- [ ] **Step 3: 取り出す**（`MmeRenderer.ts` は 300 行以下を目安に）
- [ ] **Step 4: 走らせて通るのを見る** — `npx vitest run src/engine/mme`、`npx playwright test e2e/mme-scene.spec.ts e2e/mme-post.spec.ts e2e/mme-ui.spec.ts`、`npm run mme:bench`（4〜5 ms のまま）
- [ ] **Step 5: コミット**

### Task 9: 物ごと・材質ごとの割り当て（Main）と決め方

**Files:**
- Create: `src/engine/mme/Assignments.ts`、`Assignments.test.ts`
- Modify: `src/core/mme/settings.ts`（形と `normalizeObjectEffects`）、`src/engine/types.ts`（`Obj.mme?`）、`src/engine/addons/builtins.ts`（`objectData` の `mme`）、`EffectStore.ts`（`objects` の Map をやめる）、`MmeEngine.ts`、`MmeRenderer.ts`

**Interfaces:**
- Produces:
  - `core/mme/settings.ts`:
    - `interface EffectRef { folder: string; path: string }`
    - `type SavedSlot = EffectRef | 'hide'`
    - `interface TabEffects { object?: SavedSlot; materials?: Record<string /* 材質の番号 */, SavedSlot> }`
    - `type ObjectEffects = Record<string /* 'Main' かオフスクリーンの名前 */, TabEffects>`
    - `normalizeObjectEffects(raw: unknown): ObjectEffects | null` — 壊れた項を捨てる。空なら `null`
  - `Obj.mme?: ObjectEffects`
  - `objectData` の `{ key: 'mme', label: msg('MME のエフェクト'), get: o => o.mme ?? null, set: (o, v) => e.mme.setObjectEffects(o, v), normalize: normalizeObjectEffects }`（保存・複製・取り消しはいまの仕組みで扱われる。画面からの変更は、名前の変更など、ほかの `objectData` と同じやり方で履歴に入れる）
  - `objectName(obj: Obj): string`（`Assignments.ts`）— モデルは .pmx のファイル名（`mmdSourceOf` / `userData.sourceFile` の `name`）、ほかは `obj.name ?? 種類の名前`
  - `class Assignments { constructor(store: EffectStore); slotFor(tab: string, defaults: { rules: DefaultRule[]; base: string /* フォルダの中のエントリーのフォルダ */; folder: EffectFolder } | null, owner: Obj | null): SlotFor }` — 決め方: 材質の割り当て → 物の割り当て → `defaults` があれば `resolveDefault`（`isSelf` は `obj === owner`。`none` は default.fx、`null` は hide）→ なければ（Main）default.fx。`EffectRef` のフォルダ・ファイルがなければ警告を 1 回出して、既定に戻す
  - `MmeEngine.setObjectEffects(obj: Obj, v: ObjectEffects | null): void`、`MmeEngine.assign(obj: Obj, tab: string, materialIndex: number | null, slot: SavedSlot | null): void`（`null` は既定に戻す）
  - 第 2 の計画の `store.objectEffect`・`setObjectEffect`・`forgetObject` は、`Obj.mme` の `Main` に置き換える（画面の「選んでいる物の .fx」は `Main` の物の割り当て）

- [ ] **Step 1: 失敗するテストを書く**
  - `normalizeObjectEffects`: 壊れた値（数・知らない形・`materials` の数でないキー）を捨てる
  - `Assignments`: 材質 1 だけに `hide` を当てると、材質 0 は物の割り当て、材質 1 は hide。材質の番号がモデルの材質の数より大きいものは無視される（Review Focus 2）
  - `slotFor` に `DefaultEffect` の規則を渡すと、名前で決まる（`ray_controller.pmx` は hide、ほかは `material_2.0.fx`）
  - 割り当てた物を `world` から消しても例外にならず、ほかの物の割り当てはそのまま
  - e2e（`mme-scene.spec.ts` に足す）: 2 つの材質のモデルで、材質 1 にだけ赤を出す .fx を当てると、材質 1 の画素だけ赤。複製すると複製も同じ。取り消すと元に戻る
- [ ] **Step 2: 走らせて失敗を見る** — `npx vitest run src/engine/mme src/core/mme` と `npx playwright test e2e/mme-scene.spec.ts`
- [ ] **Step 3: 実装**
- [ ] **Step 4: 走らせて通るのを見る**（同じコマンドと `e2e/mme-ui.spec.ts`）
- [ ] **Step 5: コミット**

### Task 10: オフスクリーンレンダーターゲット

**Files:**
- Create: `src/engine/mme/Offscreen.ts`、`Offscreen.test.ts`、`e2e/mme-offscreen.spec.ts`
- Modify: `src/core/mme/semantics.ts`（テクスチャの種類 `OFFSCREENRENDERTARGET` を `'offscreen'` に）、`EffectInstance.ts`（`'offscreen'` のテクスチャを `TextureSource` から受け取る）、`MmeRenderer.ts`、`Framebuffers.ts`（オフスクリーンの色と深度を作る）

**Interfaces:**
- Consumes: `ScenePass.draw`・`PassTable`（Task 8）、`Assignments.slotFor`（Task 9）、`parseDefaultEffect`（Task 2）、shared のターゲット（Task 7）
- Produces:
  - `interface OffscreenDecl { effect: LoadedEffect; name: string; shared: boolean; width: number; height: number /* ViewportRatio は画面の大きさから */; format: string; clearColor: [number, number, number, number]; clearDepth: number; antiAlias: boolean; mipLevels: number; rules: DefaultRule[] }`
  - `offscreenDecls(effect: LoadedEffect, screen: [number, number]): { decls: OffscreenDecl[]; warnings: string[] }`
  - `class Offscreen { constructor(deps); begin(frameNo: number): void; ensure(effect: LoadedEffect, owner: Obj | null, frame: FrameState): void; texture(effect: LoadedEffect, name: string, owner: Obj | null): THREE.Texture | null; tabs(): { name: string; description: string }[]; dispose(): void }`
    - `ensure` は、そのエフェクトが宣言するオフスクリーンを、まだこのフレームで描いていなければ、**宣言の逆の順に**描く。描く物は、そのタブの `PassTable`（`name` はオフスクリーンの名前、`slotFor` は `Assignments.slotFor(name, { rules, … }, owner)`）で `ScenePass.draw`。描く前に `ClearColor`・`ClearDepth` で消す
    - shared でないものは `(effect, name, owner の id)` ごとに作る。shared のものは名前ごとに 1 つ
    - 入れ子: `ScenePass` が物を描く前に、その物のエフェクトについて `ensure(effect, obj, frame)` を呼ぶ（深さ 2 まで。それより深いものは警告を出して描かない）
    - `tabs()` は、いま使われているエフェクトが宣言するオフスクリーンの名前と `Description`（名前ごとに 1 つ）
  - `MmeRenderer` は、ポストエフェクトと Main の物のエフェクトについて、描く前に `ensure` を呼ぶ
  - `(OffscreenOwner)` は Task 11 で `owner` を読む（ここでは `owner` を `SemanticContext` まで渡しておく）

- [ ] **Step 1: 失敗するテストを書く**
  - `offscreenDecls`: Ray-MMD の `MaterialMap`（`textures.fxsub` の宣言）の名前・形式・`DefaultEffect` の規則の数
  - `Offscreen`（three.js をまねた小さな deps で）: 宣言 A・B の順のエフェクトを `ensure` すると、B → A の順に描かれる。同じフレームで 2 回 `ensure` しても 1 回だけ
  - e2e（`mme-offscreen.spec.ts`。自作の .fx）:
    - ポストエフェクトが `OFFSCREENRENDERTARGET` を宣言し、`DefaultEffect = "*=green.fx;"` で物を緑に描き、そのオフスクリーンを画面に出す → 物の画素が緑
    - `DefaultEffect = "Cube*=hide; *=green.fx;"` → 名前が Cube で始まる物は描かれない（背景の色）
    - 割り当ての画面の代わりに `assign(obj, 'OffMap', null, 'hide')` で外すと、その物だけ消える。材質ごとの割り当ても効く
    - 入れ子: 物の .fx がオフスクリーンを宣言し、`DefaultEffect = "self=hide; *=white.fx;"` → 持ち主の物は入らない
    - 同じ .fx を当てた物 2 つ（入れ子のオフスクリーンを持つ）は、それぞれ自分のオフスクリーンを持つ（Review Focus 3。持ち主の位置で色を変える .fx で、2 つの画素が違う色）
- [ ] **Step 2: 走らせて失敗を見る** — `npx vitest run src/engine/mme src/core/mme` と `npx playwright test e2e/mme-offscreen.spec.ts`
- [ ] **Step 3: 実装**
- [ ] **Step 4: 走らせて通るのを見る**（同じコマンドと、第 2 の計画の MME の e2e すべて）
- [ ] **Step 5: コミット**

### Task 11: `CONTROLOBJECT` の値（場面の物と仮のコントローラー）

**Files:**
- Create: `src/engine/mme/Controllers.ts`、`Controllers.test.ts`
- Modify: `src/core/testing/pmx.ts`（`PmxOptions.morphs?: string[]`（名前だけ、頂点の動きのないモーフ）、`PmxOptions.boneNames?: string[]`（いまの骨の名前を置き換える））、`src/core/mme/settings.ts`（`MmeScene.controls`。Task 14 の形の一部をここで作る）、`MmeEngine.ts`、`ScenePass.ts`・`PostChain.ts`（`SemanticContext.control` を渡す）
- Test: `Controllers.test.ts`、`e2e/mme-offscreen.spec.ts` か `e2e/mme-controllers.spec.ts`（新）

**Interfaces:**
- Consumes: `ControlRef`・`virtualControls`（Task 3）、`objectName`（Task 9）、`owner`（Task 10）
- Produces:
  - `class Controllers { constructor(deps: { world: World; stage: () => THREE.Object3D | null }); values: Map<string, Map<string, number>> /* 仮のコントローラー: 名前 → 項目 → 値 */; set(name: string, item: string, v: number): void; value(ref: ControlRef, self: Obj | null, owner: Obj | null): number[] | null; catalog(effects: LoadedEffect[]): Map<string, string[]> }`
    - `(self)` は `self`、`(OffscreenOwner)` は `owner`、ほかは `objectName` が合う最初の物（なければ仮のコントローラー）
    - 物の値: 項目なしの `float4x4` は MMD の座標のワールド行列（`toMmd`）、`float3`/`float4` は位置、`bool` は「あって、隠していない」。項目が骨の名前なら骨の位置（`float3`/`float4`）・ワールド行列（`float4x4`）、モーフの名前なら `morphTargetInfluences` の値（`float`）。アクセサリの項目（`X`・`Y`・`Z`・`XYZ`・`Rx`・`Ry`・`Rz`・`Rxyz`・`Si`・`Tr`）は警告を 1 回出して `null`
    - 仮のコントローラーの値は `values`（なければ 0）。`set` は 0〜1 に収める
    - `catalog` は、描いているエフェクトの `controlRefs` から `virtualControls` を作る（画面のスライダーの元）
  - `MmeEngine.setControl(name: string, item: string, v: number): void`（描き直す。場面の値なので取り消しの対象にしない）

- [ ] **Step 1: 失敗するテストを書く**
  - `Controllers.value`: 仮のコントローラーの `SSAO+` に 0.5 を `set` すると `[0.5]`、2 を `set` すると `[1]`。`(self)` のモデルのモーフ `R+` の値、骨 `Position` の位置（MMD の座標）、`Si` は `null` と警告
  - 同じ名前のモデルが 2 つ → 最初の物の値
  - e2e: 物の .fx の色を `CONTROLOBJECT<string name="ray_controller.pmx"; string item="Red";>` から作る → `setControl('ray_controller.pmx', 'Red', 1)` で赤くなる。`(self)` のモーフ（`makePmx` の `morphs: ['Green']`）を 1 にすると緑になる
  - e2e（Review Focus 3 の残り）: 同じ .pmx（`morphs: ['R+']`）を 2 つ置き、片方だけモーフを 1 にすると、その物だけ色が変わる
- [ ] **Step 2: 走らせて失敗を見る** — `npx vitest run src/engine/mme src/core/testing` と e2e
- [ ] **Step 3: 実装**
- [ ] **Step 4: 走らせて通るのを見る**（同じコマンドと、MME の e2e すべて）
- [ ] **Step 5: コミット**

### Task 12: `ScriptOrder` とポストエフェクトのテクニックの選び方

**Files:**
- Modify: `src/engine/mme/PostChain.ts`、`MmeRenderer.ts`、`src/core/mme/technique.ts`（ポストエフェクト用の選び方）
- Test: `technique.test.ts`、`e2e/mme-post.spec.ts`

**Interfaces:**
- Produces:
  - `scriptOrder(effect: EffectDesc): 'standard' | 'preprocess' | 'postprocess'`（`technique.ts`。`STANDARDSGLOBAL` の param の注釈 `ScriptOrder`。なければ、ポストエフェクトとして足されたものは `postprocess`、物の .fx は `standard`）
  - `pickPostTechnique(effect: EffectDesc): Technique | null` — `techniques[0]` をやめ、`MMDPass` のないもののうち最初（なければ `null` と警告）
  - ポストエフェクトの一覧のうち `preprocess` のものは、オフスクリーンと Main の前に、画面（いまの描き先）に描く。`standard` のものは警告を出して `postprocess` として扱う（Ray-MMD は物の .fx 以外で使わない）

- [ ] **Step 1: 失敗するテストを書く** — `scriptOrder` と `pickPostTechnique` の単体テスト（`MMDPass="object"` の technique が先にあっても、それを選ばない）。e2e: `preprocess` のエフェクトが塗った色が、Main の物の後ろ（背景）に残る
- [ ] **Step 2: 走らせて失敗を見る** — `npx vitest run src/core/mme` と `npx playwright test e2e/mme-post.spec.ts`
- [ ] **Step 3: 実装**
- [ ] **Step 4: 走らせて通るのを見る**
- [ ] **Step 5: コミット**

### Task 13: 割り当てのタブとコントローラーの欄

**Files:**
- Create: `src/ui/components/MmeAssignTabs.tsx`、`src/ui/components/MmeControllers.tsx`
- Modify: `src/ui/components/sidebar/FxPage.tsx`、`src/engine/UiChannel.ts`（`MmeUiState`）、`MmeEngine.ts`（`publish`）、`src/ui/styles`（いまの MME の欄の CSS の所）、i18n の辞書
- Test: `e2e/mme-ui.spec.ts`

**Interfaces:**
- Consumes: `Offscreen.tabs()`（Task 10）、`Controllers.catalog`・`values`（Task 11）、`EffectStore.folders()`（Task 6）、`MmeEngine.assign`（Task 9）、`MmeEngine.setControl`（Task 11）
- Produces:
  - `MmeUiState` に足す: `folders: { id: string; name: string; fx: string[] /* .fx の相対パス */ }[]`、`tabs: { name: string; description: string }[]`（先頭は `{ name: 'Main', description: '' }`）、`rows: Record<string /* tab */, MmeRowUi[]>`、`controllers: { name: string; items: { item: string; value: number }[] }[]`
  - `interface MmeRowUi { objId: number; label: string; material: number | null /* null は物の行 */; assigned: string | null /* "フォルダ名/パス"・'hide' */; fallback: string /* 既定で決まるもの: "フォルダ名/パス"・'hide'・'default.fx' */ }`（物の行のあとに、その物の材質の行が続く。材質の行は、画面で開いたときだけ出す）
  - `publish()` は、いままでどおり変わったときだけ知らせる（JSON を比べる。毎フレームの重さを増やさないよう、行の一覧は割り当て・物・タブが変わったときだけ作り直す）

- [ ] **Step 1: 失敗するテストを書く**（`mme-ui.spec.ts` に足す）
  - フォルダを読み込むと、タブに「Main」とそのフォルダのポストエフェクトが宣言するオフスクリーンの名前が出る
  - オフスクリーンのタブで、物の行の選択を「非表示」にすると、画面のその物の画素が消える（Task 10 の e2e の .fx を使う）。「既定に戻す」で戻る
  - 選んでいない行には、`DefaultEffect` で決まったものが出る（薄い字の要素のテキストで確かめる）
  - モデルの行を開くと材質の行が出て、材質に割り当てられる
  - コントローラーの欄に `ray_controller.pmx` と項目のスライダーが出て、動かすと画素が変わる
- [ ] **Step 2: 走らせて失敗を見る** — `npx playwright test e2e/mme-ui.spec.ts`
- [ ] **Step 3: 実装**（文はすべて `t()`。サイドバーの幅でも横にはみ出さない）
- [ ] **Step 4: 走らせて通るのを見る** — 同じコマンドと `npx vitest run src/i18n`
- [ ] **Step 5: コミット**

### Task 14: 保存と開く

**Files:**
- Modify: `src/core/mme/settings.ts`、`src/engine/addons/builtins.ts`（`sceneData` の `mme`）、`src/engine/project/ProjectIO.ts`、`src/engine/project/format.ts`、`MmeEngine.ts`、`EffectStore.ts`
- Test: `src/core/mme/settings.test.ts`（新か、いまのもの）、`src/engine/project/*.test.ts`（いまの保存のテストのあるもの）、`e2e/mme-project.spec.ts`（新）

**Interfaces:**
- Produces:
  - `interface MmeScene { settings: MmeSettings; folders: { id: string; name: string }[]; posts: { effect: EffectRef; enabled: boolean }[]; controls: Record<string, Record<string, number>> }`
  - `normalizeMmeScene(raw: unknown): MmeScene` — 第 2 の計画の形（いちばん上に `engine` がある = 設定だけ）も読む（Review Focus 5）。壊れた項を捨てる
  - `sceneData` の `mme`: `save: () => e.mme.saveScene()`、`load: raw => e.mme.loadScene(normalizeMmeScene(raw))`、`reset` はいまのまま（割り当て・フォルダ・コントローラーも消す）
  - `format.ts` の `ProjectData` に `mmeFiles?: { folder: string; path: string; asset: string }[]`
  - `ProjectIO.build`: `e.mme.store.folders()` の `used` のファイルを `asset()` に通して `data.mmeFiles` に入れる
  - `ProjectIO.saveFile`・`save`・`saveReference`: 組み立てる前に `await e.mme.whenFilesRead()`（割り当てたエフェクトとポストエフェクトのファイルのテクスチャを、描いていなくても読み終える。Review Focus 4）
  - `ProjectIO.open`: `sceneData` を読む前に `e.mme.store.restore(folders, (data.mmeFiles ?? []).map(m => ({ folder: m.folder, path: m.path, file: fileOf(m.asset) })))`（見つからないファイルは、ほかの assets と同じく探してもらう画面に出る。見つからなければ、そのファイルなしでフォルダを作る）
  - `EffectStore.restore(folders: { id: string; name: string }[], files: { folder: string; path: string; file: File | null }[]): Promise<void>`（保存したときの id のまま作る。文字のファイルは読んでおく）
  - 割り当て（`Obj.mme`）はいまの `objectData` の仕組みで保存・復元される。フォルダより先に物が作られても、割り当ては描くときに `EffectRef` から引くので、順番は問わない

- [ ] **Step 1: 失敗するテストを書く**
  - `normalizeMmeScene`: 第 2 の計画の形 `{ engine: 'mme', selfShadow: false, shadowDistance: 5000, groundShadow: true }` を読むと `settings` にその値、ほかは空。壊れた `posts`・`controls` を捨てる
  - e2e（`mme-project.spec.ts`）:
    - フォルダを読み、物に .fx（画像を使う）、オフスクリーンのタブに割り当て、ポストエフェクト、コントローラーの値を設定して PNG を撮る → .wgp に保存 → 最初の状態に戻す → 開く → PNG が同じ（画素の差 2 以下）
    - 同じことを .wgpj で（ファイルは、e2e で開くときに渡す）
    - 割り当ててすぐ（`requestDraw` の前に）.wgp に保存しても、開き直すと画像がある（Review Focus 4）
    - 第 2 の計画の形の `mme` のプロジェクトを開いても、エラーのお知らせが出ない（Review Focus 5）
- [ ] **Step 2: 走らせて失敗を見る** — `npx vitest run src/core/mme src/engine/project` と `npx playwright test e2e/mme-project.spec.ts`
- [ ] **Step 3: 実装**
- [ ] **Step 4: 走らせて通るのを見る** — 同じコマンドと、プロジェクトの e2e（いまの `e2e/` の project/保存のもの）すべて
- [ ] **Step 5: コミット**

### Task 15: 本物の Ray-MMD で確かめて、足りないものを埋める

**Files:**
- Create: `e2e/ray-mmd-local.spec.ts`
- Modify: ここで見つかった不足を埋める所、`README.md`（MME の節: Ray-MMD の使い方・できないこと・fps）、`ARCHITECTURE.md`（`ScenePass`・`Offscreen`・`Controllers`・割り当ての決め方）、`fx/README.md`（Ray-MMD を置く場所）、設計書（実装でわかったことで直す）

**Interfaces:**
- `e2e/ray-mmd-local.spec.ts` は `fx/ray-mmd-1.5.2/ray.fx` がなければ `test.skip`。CI では動かない。

- [ ] **Step 1: 手元の e2e を書く** — 次を読み込む:
  1. Ray-MMD のフォルダ（全体）
  2. モデル: `makePmx` のモデル（材質 3 つ）と `Materials/Editor` の .pmx を 1 つ
  3. MaterialMap のタブ: モデルの材質ごとに `Materials/Skin/…`・`Materials/Hair/…`・`material_2.0.fx`
  4. 空: `Skybox/Time of day/Time of day.pmx` と EnvLightMap に `Time of lighting.fx`
  5. ライト: `Lighting` のすべての種類の .pmx（`DefaultEffect` で決まる）
  6. フォグ: `Fog` の 4 種類の .pmx
  7. ポストエフェクト: `ray.fx`

  そのうえで確かめること:
  - 「未対応」の警告（`MmeUiState` の warnings とエフェクトごとの warnings のうち、未対応・止めました の文）が 0
  - リンクの失敗が 0
  - PNG が真っ黒でない（平均の明るさ > 0.05）
  - 1 フレームの時間を測って出す
  - PNG を `test-results/ray-mmd/` に保存する（ライトとフォグを、点光源・スポットライト・グラウンドフォグ・空に絞ったものも）
- [ ] **Step 2: 走らせて、出た警告をすべて書き出す** — `npx playwright test e2e/ray-mmd-local.spec.ts`
- [ ] **Step 3: 警告を 1 つずつ埋める** — それぞれ、単体テストか自作の .fx の e2e で再現してから直す（コミットは 1 つの不足ごと）。この計画の範囲（設計書の「この計画に入れないもの」）のものなら、警告のまま残してノートに書く
- [ ] **Step 4: 手元の e2e が通るまで、Step 2〜3 をくり返す**
- [ ] **Step 5: README・ARCHITECTURE・`fx/README.md`・設計書を書く** — README には Ray-MMD の置き方と割り当ての手順、できないこと、手元で測った fps（ビューポート 1280×720 の目安）
- [ ] **Step 6: すべてのテストを流す** — `CI=1 E2E_GL=software npm run test:all`
- [ ] **Step 7: コミット**。保存した PNG のパスを、最後の報告に書く（ユーザーの目の確認のため）
