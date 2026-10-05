# MME 互換モード 第 3 の計画: 割り当ての残り Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 仮のアクセサリ・仮のコントローラーを「MME の物」として置き、その値と .fx のパラメータにキーフレームを打てるようにし、.emm の読み書き・`fx/` の一覧・MCP のコマンドを足す。

**Architecture:** 新しい物の種類 `Obj.mmeObj`（形のない物）と、物のアニメーションの新しいチャンネルの種類 `mme`（物ごとの名前の一覧 `Obj.mmeChannels` の番号）を足し、キーフレーム・タイムライン・取り消し・複製・保存はいまの仕組みのまま使う。値は `Obj.mmeValues`（名前 → 値）に持ち、キーフレームがあれば毎フレーム評価して上書きする。ランタイム（`Controllers`・ポストエフェクトの一覧・パラメータの uniform）はこの値を読む。

**Tech Stack:** TypeScript、three.js 0.186、React、vitest、Playwright。

**Spec:** `docs/superpowers/specs/2026-10-05-mme-assignments-design.md`（前の計画: `docs/superpowers/specs/2026-10-05-mme-ray-mmd-design.md`、次に回したこと: `docs/superpowers/notes/2026-10-05-mme-ray-mmd-followups.md`）

## Global Constraints

- ブランチ `claude/mme-plan3-assignments`（第 4 の計画のブランチ = PR #1 から切ったもの）の上に作る。
- **.x は値だけ。** .x の形は読まない・描かない。仮のアクセサリは `X`・`Y`・`Z`・`Rx`・`Ry`・`Rz`・`Si`・`Tr`・表示 を持つ。既定値は `Si` = 1、`Tr` = 1、ほかは 0。表示は「物を隠しているか」。位置と回転は MMD の座標（MMD の単位・左手系）。行列は「`Si` の拡大 → `Rx`〜`Rz` の回転 → `X`〜`Z` の位置」の順。
- 仮のコントローラーの項目は 0〜1。場面にない名前は MME の欄に「置く」ボタン付きで並べ、勝手には置かない。
- アクセサリに当てた .fx（`Obj.mme.Main.object`）がポストエフェクトになり、描く順はアウトライナーでのアクセサリの並び。オン・オフ = 隠す。
- パラメータ: 初期値を持つ uniform の数値（`float`〜`float4`・`int`・`bool`）で、セマンティクスのないもの。注釈 `UIName`・`UIMin`・`UIMax`・`UIWidget = "Color"`・`UIHidden`。値は「.fx を当てた物」と「.fx」の組ごと。ステージのパラメータは場面の値でキーフレームなし。DefaultEffect だけで決まった物の .fx は初期値。
- MME チャンネルの名前: コントローラーの項目は項目名（`SSAO+`）、アクセサリは `X`〜`Tr`、パラメータは `<フォルダの id>/<.fx のパス>:<名前>`（ベクトルは `:x`・`:y`・`:z`・`:w`）。
- .emm: 書式は実装の最初に MME の資料で確かめて表にする。読み込みは名前で照らし合わせ、同じ名前は番号の順に場面の並びの順。.fx のパスは「後ろの部分がいちばん長く合うもの」（大文字小文字・`\` を吸収）。書き出しのパスは `フォルダの名前\フォルダの中のパス`。読み込みは 1 回の取り消しで戻る（ステージの割り当てを除く）。
- `fx/` の一覧は `models/` の一覧と同じ仕組み。環境変数 `WEBGL_GRID_FX_DIR`。サーバーがないときは選択肢を出さない。
- 古いプロジェクト（第 4 の計画の形）を開くと、`MmeScene.posts` はアクセサリ（名前は .fx の拡張子を `.x` にしたもの、並びとオン・オフはそのまま）、`MmeScene.controls` はコントローラーの物に移す。同じ絵になる。
- 警告・画面の文はすべて `t()`（日本語・英語・簡体字・繁体字）。`src/core` は消せる TypeScript の書き方だけ。
- 標準のレンダーエンジンの絵と、これまでのテストを変えない。
- コミットは日本語で「MME 割り当て: …」、末尾に実際にコミットしたモデルの `Co-Authored-By`。素の `git stash` は使わない。Ray-MMD のバイナリ（`fx/ray-mmd-1.5.2/`）はコミットしない。

## Review Focus

1. 同じ名前のコントローラー・アクセサリを 2 つ置く → `CONTROLOBJECT` は場面の並びで最初のもの（第 4 の計画と同じ）、ポストエフェクトは両方とも並びの順に描かれる（Task 5 のテスト）。
2. キーフレームと .fx の割り当てを持つアクセサリを消して取り消す → キー・値・割り当てごと戻る（Task 3 のテスト）。
3. .fx を読み直してパラメータが減った・名前が変わった → 古いチャンネルとキーは残るが使われず、例外にならない。画面には今あるパラメータだけ出る（Task 6 のテスト）。
4. .emm に場面にない物・読み込んでいない .fx がある → 警告にまとめ、残りは当たる（Task 8 のテスト）。
5. 第 4 の計画の形のプロジェクトを開く → ポストエフェクトの並びとオン・オフ、スライダーの値がアクセサリ・コントローラーに移り、同じ絵（Task 4・5 のテストと Task 12 の e2e）。

---

## ファイルの構成

| ファイル | 役目 | タスク |
|---|---|---|
| `src/core/animation.ts`・`src/engine/anim/Keyframes.ts`・`src/engine/types.ts` | チャンネルの種類 `mme`、`Obj.mmeChannels`・`Obj.mmeValues` | 1 |
| `src/core/mme/params.ts`（新）・`src/core/mme/accessory.ts`（新） | パラメータの一覧、アクセサリの行列 | 2 |
| `src/engine/world/MmeObjects.ts`（新）・`types.ts`・`Engine.ts`・`ProjectIO.ts`・`builtins.ts`・`Outliner.tsx` | MME の物（置く・複製・保存・描かない・積まない） | 3 |
| `src/engine/mme/Controllers.ts`・`MmeEngine.ts`・`core/mme/settings.ts` | コントローラーの物の値を読む・古い値の移し替え | 4 |
| `MmeRenderer.ts`・`EffectStore.ts`・`MmeEngine.ts`・`Controllers.ts`・`FxPage.tsx` | アクセサリのポストエフェクト・アクセサリの値・古いポストエフェクトの移し替え | 5 |
| `EffectInstance.ts`・`ScenePass.ts`・`PostChain.ts`・`MmeEngine.ts` | パラメータの値を描くたびに入れる | 6 |
| `src/ui/components/sidebar/MmeValuesPage.tsx`（新）・`Sidebar.tsx`・`MmeControllers.tsx` | MME の値の欄（スライダー・◆）・「置く」 | 7 |
| `src/core/mme/emm.ts`（新）・`MmeEngine.ts`・`FxPage.tsx` | .emm の読み書き | 8 |
| `mcp/fx.ts`（新）・`src/core/fxFolder.ts`（新）・`src/engine/io/fxFolder.ts`（新）・`vite.config.ts`・`mcp/appServer.ts`・`MmeEffectPicker.tsx` | `fx/` の一覧 | 9 |
| `src/engine/remote/commands.ts` | MCP のコマンド | 10 |
| `MmeAssignTabs.tsx`・`MmeEngine.ts`・`settings.ts` | 割り当ての画面の後片付け・ステージの名前 | 11 |
| `e2e/ray-mmd-local.spec.ts`・`e2e/mme-mcp-local.spec.ts`（新）・README・ARCHITECTURE・設計書 | 本物の Ray-MMD で確かめる・書き残す | 12 |

---

### Task 1: チャンネルの種類 `mme`

**Files:** Modify `src/core/animation.ts`、`src/engine/anim/Keyframes.ts`、`src/engine/types.ts`、`src/engine/addons/builtins.ts`（objectData）。Test `src/core/animation.test.ts`、`src/engine/anim/*.test.ts`（いまのキーフレームのテストのあるもの）

**Interfaces:**
- Produces:
  - `Animation.mme: Map<number, Map<number, MorphKey>>`、`Channel.kind` に `'mme'`、`evaluate(...)` の戻り値に `mme: Map<number, number>`、`AnimationJson` に `mme`（なければ空。古いプロジェクトはそのまま読める）。`isEmpty`・`keyFrames`・`deleteKeys`・`moveKeys`・`copyKeys`・`pasteKeys` が `mme` も扱う
  - `Obj.mmeChannels?: string[]`（チャンネルの名前。番号 = 位置。消さない・並べ替えない）、`Obj.mmeValues?: Record<string, number>`（いまの値）
  - `mmeChannel(obj: Obj, name: string): number`（`src/engine/anim/mmeChannels.ts`（新）。なければ足して番号を返す）
  - `Keyframes.insertMme(obj: Obj, frame: number, names: string[]): void`（`obj.mmeValues` の値でキーを打つ。いまの `insert` と同じく、すでにあれば値だけ替える）
  - `Keyframes.applyAll` は `mme` を評価して `obj.mmeValues[名前]` を上書きし、`changed` を通知する（下の Task が描き直しに使う）
  - objectData `mmeChannels`・`mmeValues`（保存・複製・取り消し）

- [ ] **Step 1: 失敗するテストを書く** — `insertMme` で 0 と 30 フレームに `Si` = 1 と 3 を打つと、`evaluate` の 15 フレームで 2（直線の補間曲線）。`animationToJson` → `animationFromJson` で `mme` が戻る。`mme` のない古い JSON も読める。`copyKeys`/`pasteKeys`/`deleteKeys`/`moveKeys` が `mme` のキーも動かす。`applyAll` が `obj.mmeValues.Si` を書き換える
- [ ] **Step 2: 走らせて失敗を見る** — `npx vitest run src/core/animation.test.ts src/engine/anim`
- [ ] **Step 3: 実装**（タイムラインとグラフエディターに `mme` チャンネルを出すのは、いまの表情のチャンネルの出し方にならう。名前は `obj.mmeChannels`）
- [ ] **Step 4: 走らせて通るのを見る** — `npx vitest run src/core src/engine` と `npx playwright test e2e/timeline*.spec.ts e2e/keyframe*.spec.ts`（あるもの）
- [ ] **Step 5: コミット**

### Task 2: パラメータの一覧とアクセサリの行列（純粋な計算）

**Files:** Create `src/core/mme/params.ts`、`params.test.ts`、`src/core/mme/accessory.ts`、`accessory.test.ts`

**Interfaces:**
- Produces:
  - `interface ParamUi { name: string; label: string; type: 'float' | 'float2' | 'float3' | 'float4' | 'int' | 'bool'; init: number[]; min: number; max: number; color: boolean }`
  - `effectParams(desc: EffectDesc): ParamUi[]` — `storage === 'uniform'`・`semantic === null`・初期値あり・`UIHidden` でない、の数値の param。`label` は `UIName`、なければ名前。`min`/`max` は `UIMin`/`UIMax`、なければ初期値 v から `[min(0, v·2), max(1, v·2)]`（成分の最小・最大）。`bool` は 0〜1、`int` は整数に丸める。`color` は `UIWidget` が `Color`（大文字小文字を無視）で、`float3`/`float4` のとき
  - `paramChannels(folderId: string, path: string, p: ParamUi): string[]` — `float` は `${folderId}/${path}:${name}`、ベクトルは末尾に `:x`・`:y`・`:z`・`:w`
  - `ACCESSORY_ITEMS = ['X','Y','Z','Rx','Ry','Rz','Si','Tr'] as const`、`ACCESSORY_DEFAULTS: Record<…, number>`（`Si` = 1、`Tr` = 1、ほか 0）
  - `accessoryMatrix(v: Record<string, number>): Matrix4` — MMD の座標の行列（D3D の並び）。拡大 `Si` → 回転（`Rx`・`Ry`・`Rz` は度。MMD のアクセサリと同じ回転の順を MME の資料で確かめて、テストに書く）→ 位置 `X`・`Y`・`Z`

- [ ] **Step 1: 失敗するテストを書く** — `float Strength < string UIName = "強さ"; float UIMin = 0; float UIMax = 4; > = 1.5;` → label `強さ`、範囲 0〜4。`float3 Col < string UIWidget = "Color"; > = {1,0.5,0};` → color true、範囲 0〜2。`float4x4 W : WORLD;`（セマンティクスあり）・`static float s = 1;`・`float NoInit;`・`UIHidden = true` は出ない。`paramChannels` の名前。`accessoryMatrix({ X: 1, Si: 2 })` が拡大 2・位置 x = 1、`Ry: 90` で +X が回転した向き
- [ ] **Step 2: 走らせて失敗を見る** — `npx vitest run src/core/mme`
- [ ] **Step 3: 実装**
- [ ] **Step 4: 走らせて通るのを見る**
- [ ] **Step 5: コミット**

### Task 3: MME の物

**Files:** Create `src/engine/world/MmeObjects.ts`、`MmeObjects.test.ts`。Modify `src/engine/types.ts`（`Obj.mmeObj`、`ObjKind` に `'mme'`、`kindOf`）、`src/engine/Engine.ts`（`addMmeObject`・複製）、`src/engine/world/World.ts`（積み重ね・足場から外す）、`src/engine/project/ProjectIO.ts`（保存・開く）、`src/engine/addons/builtins.ts`（objectData `mmeObj`）、`src/ui/components/sidebar/Outliner.tsx`（アイコン）、`src/engine/render/*`（標準のエンジンで何も描かない。ライトの目印のような目印も出さない）

**Interfaces:**
- Consumes: Task 1 の `mmeValues`、Task 2 の `ACCESSORY_DEFAULTS`
- Produces:
  - `interface MmeObjData { kind: 'controller' | 'accessory'; name: string }`（`src/core/mme/settings.ts`）、`normalizeMmeObj(raw): MmeObjData | null`
  - `Obj.mmeObj?: MmeObjData`。`kindOf(o)` は `'mme'`
  - `MmeObjects.add(data: MmeObjData): Obj`（アクセサリは `mmeValues` を `ACCESSORY_DEFAULTS` で始める）、`Engine.addMmeObject(data: MmeObjData): Obj`（履歴に入る。選ぶ）
  - 名前（`obj.name`）は `data.name`。アウトライナーで名前を変えると `mmeObj.name` も変わる（`CONTROLOBJECT` の名前はこれで照らす）
  - `objectName(obj)`（`Assignments.ts`）は MME の物なら `mmeObj.name`

- [ ] **Step 1: 失敗するテストを書く** — `addMmeObject({ kind: 'accessory', name: 'a.x' })` で物が増え、`kindOf` が `'mme'`、`mmeValues.Si` が 1。取り消すと消え、やり直すと戻る。キーと割り当てを持つアクセサリを消して取り消すと、キー・値・割り当てごと戻る（Review Focus 2）。複製すると値・キー・割り当てが写る。.wgp に保存して開き直すと同じ。物を積む高さの計算に入らない（隣に形を置いても形が上に乗らない）。標準のエンジンの PNG が、MME の物を置く前と同じ
- [ ] **Step 2: 走らせて失敗を見る** — `npx vitest run src/engine/world src/engine/project src/engine/mme`
- [ ] **Step 3: 実装**
- [ ] **Step 4: 走らせて通るのを見る** — 同じコマンドと `npx playwright test e2e/outliner*.spec.ts e2e/project*.spec.ts`（あるもの）
- [ ] **Step 5: コミット**

### Task 4: コントローラーの物の値を読む

**Files:** Modify `src/engine/mme/Controllers.ts`、`Controllers.test.ts`、`src/engine/mme/MmeEngine.ts`、`src/core/mme/settings.ts`、`MmeEngine.test.ts`

**Interfaces:**
- Consumes: Task 3 の MME の物、Task 1 の `mmeValues`/`mmeChannel`
- Produces:
  - `Controllers` は、名前が合う最初のコントローラーの物（場面の並び）の `mmeValues[item]` を読む。なければ 0。`Controllers.values`・`set`・`clear` はなくす
  - `Controllers.catalog(effects)` はいまのまま（名前 → 項目）。`MmeEngine` は `missingControllers(): { name: string; items: string[] }[]`（catalog のうち場面に物がない名前）を UI に出す
  - `MmeEngine.setControl(name, item, v)` は、その名前のコントローラーの物の `mmeValues[item]` を 0〜1 に収めて書き、`mmeChannel` を足す（物がなければ何もしない）。物ごとの値なので履歴に入る（第 4 の計画の「取り消しの対象にしない」から変わる）
  - `MmeScene.controls` は読むだけ（開くとき）: 値があれば、名前ごとにコントローラーの物を作って値を入れる（Review Focus 5）。保存するときは書かない

- [ ] **Step 1: 失敗するテストを書く** — コントローラーの物 `ray_controller.pmx` の `SSAO+` = 0.5 → `CONTROLOBJECT` の値が `[0.5]`。同じ名前の物が 2 つ → 場面の並びで最初のもの（Review Focus 1）。キーフレームで 0 → 1 → 30 フレームで値が変わる。`MmeScene.controls = { Ctrl: { Si: 0.7 } }` のプロジェクトを開くと `Ctrl` のコントローラーの物ができ、値が 0.7。`missingControllers` に場面にない名前が出る
- [ ] **Step 2: 走らせて失敗を見る** — `npx vitest run src/engine/mme`
- [ ] **Step 3: 実装**（第 4 の計画のテストのうち、スライダーの値を場面の値として確かめていたものは、コントローラーの物で確かめるように直す。直したテストを報告に書く）
- [ ] **Step 4: 走らせて通るのを見る** — `npx vitest run src/engine src/core` と `npx playwright test e2e/mme-controllers.spec.ts e2e/mme-project.spec.ts`
- [ ] **Step 5: コミット**

### Task 5: アクセサリのポストエフェクトと値

**Files:** Modify `src/engine/mme/MmeRenderer.ts`、`EffectStore.ts`、`MmeEngine.ts`、`Controllers.ts`、`src/core/mme/settings.ts`、`src/ui/components/sidebar/FxPage.tsx`。Test `MmeEngine.test.ts`、`Controllers.test.ts`、`e2e/mme-post.spec.ts`

**Interfaces:**
- Consumes: Task 2 の `accessoryMatrix`・`ACCESSORY_ITEMS`、Task 3 の MME の物
- Produces:
  - ポストエフェクトの一覧 = 場面の並びのアクセサリの物のうち、`mme.Main.object` が .fx の参照のもの。隠しているもの（`hidden`/`colHidden`、書き出しのときは `hideRender`）は飛ばす。`EffectStore.posts` とその操作（`addPost`・`movePost`・`setPostEnabled`・`removePost`・`setPosts`・`recompilePosts`）はなくし、`MmeEngine.posts(): { obj: Obj; effect: LoadedEffect }[]` にする
  - `MmeEngine.addPostEffect(files, entry)` は、アクセサリの物（名前は .fx の拡張子を `.x` にしたもの）を置いて割り当てる。画面の「上下に動かす」は `reorder_objects` と同じ物の並べ替え、「オン・オフ」は隠す、「外す」はアクセサリを消す
  - `Controllers`: アクセサリの項目（`X`〜`Tr`）は名前が合うアクセサリの物（とアクセサリに当てた .fx の `(self)`）の `mmeValues`。`XYZ`/`Rxyz` は 3 成分、項目なしの `float4x4` は `accessoryMatrix`、`float3`/`float4` は位置、`bool` は表示。第 4 の計画の「アクセサリの項目は警告して 0」はなくす
  - `MmeScene.posts` は読むだけ: 並びとオン・オフ（オフ = 隠す）を保ったまま、アクセサリの物を作って割り当てる（Review Focus 5）。保存するときは書かない

- [ ] **Step 1: 失敗するテストを書く**
  - 単体: アクセサリ 2 つ（同じ名前でも）に .fx → `posts()` が並びの順に 2 つ（Review Focus 1）。片方を隠すと 1 つ。並べ替えで順が変わる。`posts: [{a, enabled: true}, {b, enabled: false}]` のプロジェクトを開くと、アクセサリ `a.x`・`b.x`（`b.x` は隠す）
  - e2e: ポストエフェクトが `float s : CONTROLOBJECT<string name = "(self)"; string item = "Si";>;` で色を作る → アクセサリの `Si` を 0.5 → 1 にすると色が変わる。キーフレームで 1 フレーム目と最後のフレームの書き出しの色が違う
- [ ] **Step 2: 走らせて失敗を見る** — `npx vitest run src/engine/mme` と `npx playwright test e2e/mme-post.spec.ts`
- [ ] **Step 3: 実装**（第 4 の計画のテストのうち `store.posts` を直接使っていたものを直し、報告に書く）
- [ ] **Step 4: 走らせて通るのを見る** — `npx vitest run src/engine src/core` と `npx playwright test e2e/mme-*.spec.ts`
- [ ] **Step 5: コミット**

### Task 6: パラメータの値

**Files:** Modify `src/engine/mme/EffectInstance.ts`、`ScenePass.ts`、`PostChain.ts`、`MmeEngine.ts`、`src/core/mme/settings.ts`（`MmeScene.stageParams`）。Test `EffectInstance.test.ts`、`MmeEngine.test.ts`、`e2e/mme-params.spec.ts`（新）

**Interfaces:**
- Consumes: Task 2 の `effectParams`・`paramChannels`、Task 1 の `mmeValues`
- Produces:
  - `EffectInstance.bind(..., overrides?: ReadonlyMap<string, number[]>)` — 描くたびに、その物のパラメータの値で uniform を上書きする（なければ初期値）
  - ScenePass は物（Main・オフスクリーン）の `mmeValues` から、その物に当てた .fx のパラメータの値を作って渡す（`paramChannels` の名前で引く）。DefaultEffect だけで決まった .fx は渡さない。PostChain はアクセサリの物の値。ステージは `MmeScene.stageParams: Record<string, number>`（チャンネルの名前 → 値）
  - `MmeEngine.setParam(target: Obj | 'stage', folderId: string, path: string, name: string, values: number[]): void` — 範囲に収めて書く（物なら `mmeChannel` を足し、履歴に入る。ステージは場面の値）
  - `MmeEngine.paramsOf(target: Obj | 'stage'): { effect: { folder: string; path: string; name: string }; params: (ParamUi & { value: number[] })[] }[]`（UI 用。今のパラメータだけ）

- [ ] **Step 1: 失敗するテストを書く**
  - 単体: モデル 2 体に同じ .fx、片方だけ `Strength` を 3 → それぞれの描画で uniform が 3 と初期値（Review Focus の「物ごと」）。.fx を読み直して `Strength` がなくなっても例外にならず、`paramsOf` に出ない、古いチャンネルとキーは残る（Review Focus 3）。範囲の外は収める
  - e2e: パラメータ `float3 Col < string UIWidget = "Color"; > = {1,0,0};` で色を出す .fx → `setParam(obj, …, 'Col', [0,1,0])` で緑。キーフレームで書き出しの最初と最後の色が違う
- [ ] **Step 2: 走らせて失敗を見る** — `npx vitest run src/engine/mme` と `npx playwright test e2e/mme-params.spec.ts`
- [ ] **Step 3: 実装**
- [ ] **Step 4: 走らせて通るのを見る** — 同じコマンドと `npx playwright test e2e/mme-*.spec.ts`
- [ ] **Step 5: コミット**

### Task 7: MME の値の欄

**Files:** Create `src/ui/components/sidebar/MmeValuesPage.tsx`。Modify `Sidebar.tsx`、`src/ui/components/MmeControllers.tsx`（「置く」）、`src/engine/UiChannel.ts`、`MmeEngine.ts`（`publish`）、CSS、i18n。Test `e2e/mme-ui.spec.ts`

**Interfaces:**
- Consumes: Task 4 の `missingControllers`・`setControl`、Task 5 の `posts()`、Task 6 の `paramsOf`・`setParam`、Task 1 の `insertMme`
- Produces:
  - サイドバー: 選んでいる物が MME の物かモデルなら「MME」のページ。コントローラーは項目のスライダー（0〜1）、アクセサリは `X`〜`Tr`（数値の欄。`Si`・`Tr` はスライダーも）、どれにも「エフェクトのパラメータ」を .fx ごと（色は色の部品）。値ごとに ◆（キーを打つ・あれば消す。いまの表情の欄と同じ動き）
  - MME の欄のコントローラーの節: 場面にない名前を「置く」ボタン付きで出す（押すと `addMmeObject({ kind: 'controller', name })`）。場面にあるものは、その物を選ぶリンク
  - `publish` は、値の欄の中身を変わったときだけ知らせる（第 4 の計画の版の数の仕組みに、`mmeValues` の変化を足す。毎フレームの重さを増やさない）

- [ ] **Step 1: 失敗するテストを書く**（`mme-ui.spec.ts`）— 「置く」でコントローラーの物ができ、スライダーで画素が変わる。◆ を押すとキーができ、タイムラインにチャンネルの名前が出る。アクセサリの `Si` の欄で画素が変わる。モデルを選ぶとエフェクトのパラメータが出て、色の部品で色が変わる。サイドバーの幅で横にはみ出さない
- [ ] **Step 2: 走らせて失敗を見る** — `npx playwright test e2e/mme-ui.spec.ts`
- [ ] **Step 3: 実装**
- [ ] **Step 4: 走らせて通るのを見る** — 同じコマンドと `npx vitest run src/i18n src/engine/mme`
- [ ] **Step 5: コミット**

### Task 8: .emm の読み書き

**Files:** Create `src/core/mme/emm.ts`、`emm.test.ts`、`docs/superpowers/notes/2026-10-05-emm-format.md`。Modify `MmeEngine.ts`、`FxPage.tsx`（ボタン）、i18n。Test `MmeEngine.test.ts`、`e2e/mme-emm.spec.ts`（新）

**Interfaces:**
- Produces:
  - 最初に MME の資料（MikuMikuEffect の付属文書・配布サイトの説明）で .emm の書式を確かめ、`2026-10-05-emm-format.md` に表にする（節・キー・値・文字コード（Shift_JIS か UTF-8 か）・改行）。見本がなければ、表に書いた書式でテスト用の .emm を自作する
  - `interface EmmDoc { objects: { index: number; file: string }[]; tabs: Record<string /* 'Main' かオフスクリーンの名前 */, { object: number; material: number | null; value: string /* .fx のパス・'none'・'hide' など */; show?: boolean }[]> }`
  - `parseEmm(text: string): { doc: EmmDoc; warnings: string[] }`、`writeEmm(doc: EmmDoc): string`
  - `matchFxPath(path: string, folders: { id: string; name: string; files: string[] }[]): { folder: string; path: string } | null` — パスの後ろの部分がいちばん長く合うもの（区切りの単位で。大文字小文字・`\` を吸収）。同じ長さなら先のフォルダ
  - `MmeEngine.importEmm(bytes: Uint8Array): { applied: number; warnings: string[] }`（文字コードを判定して読む。名前で照らし合わせ、場面にない `.x` はアクセサリを作り、1 回の履歴にまとめる。警告はまとめて t() で出す）、`MmeEngine.exportEmm(): Uint8Array`

- [ ] **Step 1: 失敗するテストを書く** — 自作の .emm（Main とオフスクリーン 1 つ、物 3 つ: モデル・アクセサリ・場面にないモデル、材質ごとの割り当て、`hide`、Windows の絶対パス）を `parseEmm`。`matchFxPath('C:\\MMD\\ray-mmd-1.5.2\\Materials\\material_2.0.fx', …)` が `Materials/material_2.0.fx` のフォルダ。`importEmm` で割り当てが戻り、場面にないモデルと見つからない .fx は警告（Review Focus 4）、取り消しで全部戻る。`exportEmm` → `importEmm` で同じ割り当て。e2e: .emm を MME の欄から読んで画素が変わる
- [ ] **Step 2: 走らせて失敗を見る** — `npx vitest run src/core/mme/emm.test.ts src/engine/mme` と `npx playwright test e2e/mme-emm.spec.ts`
- [ ] **Step 3: 実装**
- [ ] **Step 4: 走らせて通るのを見る**
- [ ] **Step 5: コミット**

### Task 9: `fx/` の一覧

**Files:** Create `mcp/fx.ts`、`src/core/fxFolder.ts`、`src/engine/io/fxFolder.ts`。Modify `vite.config.ts`、`mcp/appServer.ts`、`src/ui/components/MmeEffectPicker.tsx`、`fx/README.md`、i18n。Test `src/core/fxFolder.test.ts`、`e2e/mme-fx-folder.spec.ts`（新）

**Interfaces:**
- Produces: `models/` の一覧（`mcp/models.ts`・`src/core/models.ts`・`src/engine/io/modelsFolder.ts`・`ModelPicker.tsx`）と同じ形。`listFxFolder(): Promise<FxListing | null>`（サーバーがなければ null）、`fetchFxFiles(folder, onProgress?): Promise<File[]>`（`webkitRelativePath` を `フォルダ名/パス` にした File。`EffectStore.addFolder` にそのまま渡せる）。環境変数 `WEBGL_GRID_FX_DIR`。`fx/` の外のファイルは渡さない。`MmeEffectPicker` に「`fx/` から選ぶ」（一覧がないときは出さない）

- [ ] **Step 1: 失敗するテストを書く** — 一覧の作り方（`fx/` の直下のフォルダごと、`.fx` の相対パス、隠しファイルを除く、`..` を渡さない）。e2e: `WEBGL_GRID_FX_DIR` に自作のフォルダを置き、「`fx/` から選ぶ」で読み込んで物に当てると画素が変わる
- [ ] **Step 2: 走らせて失敗を見る**
- [ ] **Step 3: 実装**
- [ ] **Step 4: 走らせて通るのを見る** — `npx vitest run src/core` と `npx playwright test e2e/mme-fx-folder.spec.ts e2e/models*.spec.ts`（あるもの）
- [ ] **Step 5: コミット**

### Task 10: MCP のコマンド

**Files:** Modify `src/engine/remote/commands.ts`、`commands.test.ts`、MCP の説明（`mcp/` のツールの一覧があればそこ）

**Interfaces:**
- Consumes: Task 3〜9 の `MmeEngine` の操作
- Produces（引数はいまのコマンドの書き方にならう。物は id か名前）:
  - `mme_state` → `{ settings, folders, tabs, assignments: { object, tab, material, fx }[], accessories, controllers, warnings }`
  - `mme_set { settings }`、`mme_list_fx`、`mme_load_folder { folder }`（`fx/` の中の名前）、`mme_assign { object | 'stage', tab, material?, fx: { folder, path } | 'hide' | null }`、`mme_add_accessory { name, fx? }`、`mme_add_controller { name }`、`mme_set_values { object, values: Record<string, number | number[]> }`（コントローラーの項目・アクセサリの値・パラメータのチャンネル名）、`mme_import_emm { data }`（base64）、`mme_export_emm` → `{ data }`
  - `insert_keyframe` は MME の物と MME のチャンネルも打てる（`channels: string[]` を足す）

- [ ] **Step 1: 失敗するテストを書く** — 各コマンドの正しい呼び出しと、壊れた引数（ない物・ない .fx・知らないタブ）でエラーの文を返すこと
- [ ] **Step 2: 走らせて失敗を見る** — `npx vitest run src/engine/remote`
- [ ] **Step 3: 実装**
- [ ] **Step 4: 走らせて通るのを見る** — `npx vitest run src/engine src/core` と `npx playwright test e2e/mcp*.spec.ts`（あるもの）
- [ ] **Step 5: コミット**

### Task 11: 割り当ての画面の後片付けとステージの名前

**Files:** Modify `src/ui/components/MmeAssignTabs.tsx`、`src/engine/UiChannel.ts`、`MmeEngine.ts`、`src/engine/mme/Assignments.ts`、`src/core/mme/settings.ts`（`MmeScene.stage` に .pmx の名前）、i18n。Test `e2e/mme-ui.spec.ts`、`Assignments.test.ts`、`MmeEngine.test.ts`

**Interfaces:**
- Produces:
  - .fx の選択肢はフォルダの一覧が変わったときだけ作る（`useMemo`）。選んでいるものは `{ folder, path }` の id（行に `assignedRef` を足す）で照らす
  - タブ: `role="tablist"`/`tab`/`tabpanel`、`aria-controls`、`aria-selected`、矢印キーで移る、選ばれたタブだけ `tabIndex=0`。既定の欄は `aria-describedby` で選択とつなぐ。同じ名前の物の行のラベルに番号を足す
  - `MmeScene.stage` を `{ name: string; effects: ObjectEffects }` にし、ステージの .pmx の名前が違えば当てない（第 4 の計画の形 `ObjectEffects` だけのものは、開いたときのステージの名前のものとして読む）

- [ ] **Step 1: 失敗するテストを書く** — 矢印キーでタブが移る・aria の属性。長い名前（60 文字の .fx のパス・タブ名）で横にはみ出さない。同じ名前のモデル 2 体のラベルが違う。空のステージに .fx を当ててから別の .pmx のステージに差し替えると、その .fx は当たらない。第 4 の計画の形の `stage` を読める
- [ ] **Step 2: 走らせて失敗を見る**
- [ ] **Step 3: 実装**
- [ ] **Step 4: 走らせて通るのを見る** — `npx playwright test e2e/mme-ui.spec.ts e2e/mme-stage.spec.ts` と `npx vitest run src/engine/mme src/core/mme src/i18n`
- [ ] **Step 5: コミット**

### Task 12: 本物の Ray-MMD で確かめ、書き残す

**Files:** Modify `e2e/ray-mmd-local.spec.ts`。Create `e2e/mme-mcp-local.spec.ts`、`e2e/mme-legacy-project.spec.ts`。Modify `README.md`、`ARCHITECTURE.md`、`fx/README.md`、設計書（実装でわかったこと）

- [ ] **Step 1: 手元の e2e を直す** — `ray-mmd-local.spec.ts` を、アクセサリ（`ray.x` に ray.fx）とコントローラーの物（`ray_controller.pmx`）で組み、`fx/` の一覧から読み込むように直す。コントローラーの項目にキーフレームを打ち、書き出した動画の最初と最後のコマの明るさが違うことを確かめる
- [ ] **Step 2: MCP だけで組む手元の e2e** — `mme-mcp-local.spec.ts`: `mme_load_folder` → モデルを読む → `mme_assign`（MaterialMap・EnvLightMap・ステージ）→ `mme_add_accessory('ray.x', ray.fx)` → `mme_add_controller` → `render_image`。「未対応」の警告とリンクの失敗が 0、PNG が真っ黒でない（空の領域が青い）
- [ ] **Step 3: 古いプロジェクトの e2e（CI で動く）** — `mme-legacy-project.spec.ts`: 第 4 の計画の形（`posts`・`controls`・`stage` が ObjectEffects）の .wgp を、テストの中で第 4 の計画の書式どおりに作って開き、アクセサリ・コントローラーに移って、その形で描いた PNG と同じ（画素の差 2 以下。比べる PNG は、移し替えたあとの場面を新しく作って撮る）
- [ ] **Step 4: 走らせる** — `npx playwright test e2e/ray-mmd-local.spec.ts e2e/mme-mcp-local.spec.ts e2e/mme-legacy-project.spec.ts`（手元のものはハードウェア GL）
- [ ] **Step 5: README・ARCHITECTURE・`fx/README.md`・設計書を書く** — アクセサリ・コントローラーの物・パラメータ・キーフレーム・.emm（書き出したものの置き場所）・`fx/` の一覧・MCP のコマンド。README の「Ray-MMD を使う」の手順をアクセサリで書き直す
- [ ] **Step 6: すべてのテストを流す** — `CI=1 E2E_GL=software npm run test:all`（`fx/ray-mmd-1.5.2` を一時的によけて。終わったら戻す）
- [ ] **Step 7: コミット**
