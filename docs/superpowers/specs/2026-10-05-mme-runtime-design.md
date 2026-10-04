# MME 互換モード — 第 2 の計画: MME ランタイム 設計書

- 日付: 2026-10-05
- 状態: 設計（承認待ち）
- 前の計画: `docs/superpowers/specs/2026-10-05-mme-fx-compiler-design.md`（FX コンパイラ。完了）
- 前の計画で次に回したこと: `docs/superpowers/notes/2026-10-05-mme-fx-compiler-followups.md`

## 目的

第 1 の計画で作ったコンパイラ（`compileEffect` → `EffectDesc`）の出力を使って、MME の決まりどおりに描く「MME 互換」のレンダラーを作る。この計画の終わりには、次のことができる。

- プロパティの「レンダーエンジン」を「MME 互換」にすると、MMD モデルに当てた .fx（トゥーン・輪郭線・地面の影・セルフシャドウの pass を含む）と、その上に重ねたポストエフェクト（Script とレンダーターゲットを使うもの）が、ビューポートと書き出し（PNG・動画）に出る。

全体の 5 つの計画のうちの位置:

| # | 部分 | 状態 |
|---|---|---|
| 1 | FX コンパイラ | 完了 |
| 2 | **MME ランタイム（この設計書）** | |
| 3 | エフェクトの割り当て（物・材質ごとの割り当ての画面、`OFFSCREENRENDERTARGET`、.x アクセサリ、`CONTROLOBJECT`、.emm、プロジェクトへの保存、パラメータの画面、`fx/` の一覧と MCP） | |
| 4 | Ray-MMD で合格 | |
| 5 | ほかの MME エフェクト | |

## 決めたこと

- この計画の区切りは「物の .fx ＋ ポストエフェクト」が画面と書き出しに出ること。
- 切り替えは、プロパティの **「レンダーエンジン: 標準 / MME 互換」**（Blender の Eevee / Cycles の切り替えと同じ考え方）。ビューポートの「レンダー」表示と書き出しが MME 互換で描かれ、ワイヤーフレーム・ソリッド・マテリアル表示はいまのまま。レンダーエンジンの設定はプロジェクトに保存する。
- 合格は、同梱の `default.fx` と自作の小さな .fx で、書き出した画像の画素を自動テストで確かめる。手持ちのエフェクトは `fx/` に置いて目で確かめる（自動テストにはしない）。
- **骨とモーフの変形は CPU で行う**（MMD 本体と同じ。SDEF も MMD どおりに計算する）。描画（材質・レンダーターゲット・描画ステート）は three.js の上で行う。

## 前提

- .fx を当てていない物は、同梱の `default.fx`（MMD 標準の描き方をまねたもの。私たちが書く）で描く。形（立方体など）も同じ。
- グリッド・ギズモ・選択の輪郭線などの編集用の表示は、MME の絵の上に、ビューポートでだけ重ねる。書き出しには写さない（いまと同じ）。
- この計画の割り当ては最小限（選んでいる物に .fx を読む・ポストエフェクトを足す・並べ替える・オン・オフ・外す）。割り当てはページを開き直すと消え、元に戻す（Ctrl+Z）の対象にもしない（保存と元に戻すは第 3 の計画）。
- MMD と MME は左手系（D3D）、three.js は右手系で、MMDLoader は読み込むときに z を反転している。.fx に渡す頂点・行列は、すべて MMD の左手系に戻して渡す。

## 部品

いまのリポジトリの決まり（`core/` は純粋な計算、`engine/` は three.js、`ui/` は画面）に合わせる。

### `core/mme/`（純粋な計算。WebGL なしで単体テストする）

| ファイル | 役割 |
|---|---|
| `semantics.ts` | セマンティクスの値を計算する。入力は「カメラ・ライト・物・材質・時刻・描画先の大きさ・いまの MMDPass」をまとめた `SemanticContext`、出力は `Param` に入れる数の並び（D3D の行ごとの並び）か、テクスチャの指定 |
| `coords.ts` | three.js（右手系）と MMD（左手系）の行き来。D3D の左手系の視野行列・投影行列（深度 0〜1）。地面の影の行列 |
| `technique.ts` | MME の決まりで technique を選ぶ（`MMDPass`・`Subset`・`UseTexture`・`UseSphereMap`・`UseToon`・`UseSelfShadow`） |
| `script.ts` | `ScriptCommand[]` を実行する。GL には触らず、`ScriptBackend`（描画先を替える・消す・消す色や深度を決める・pass を描く・場面を描く・ループの番号を変数に入れる）に頼むだけ |
| `targets.ts` | レンダーターゲットの大きさと形式を、注釈（`ViewportRatio`・`Dimensions`・`Width`/`Height`・`Format`・`MipLevels`）と描画先の大きさから決める |
| `skinning.ts` | CPU での変形。BDEF1/2/4・SDEF・QDEF（BDEF4 として計算する）と、頂点モーフ・UV モーフ。型付き配列だけを使う |

### `engine/mme/`（three.js を使う部分）

| クラス | 役割 | 使う相手 |
|---|---|---|
| `MmeEngine` | レンダーエンジンの切り替えと設定（セルフシャドウ・地面の影）。MME 互換のあいだは `Viewport.drawOverride` に描画を差し込む。下の部品を組み立てる | Viewport, UiChannel, World, SceneGraph |
| `EffectStore` | 選ばれたファイル（.fx が入っているフォルダごと）を `compileEffect` にかけて持つ。失敗したらお知らせを出す。物ごとの .fx とポストエフェクトの一覧を持つ | UiChannel |
| `EffectInstance` | 1 つのエフェクトの GPU の資源。pass ごとの `RawShaderMaterial`（`Program` と描画ステートから作る）、`ResourceName` のテクスチャ、レンダーターゲット、パラメータの値 | Viewport |
| `Skinner` | MMD モデルごとに、変形後の頂点（MMD の左手系）を持つ写しの形を作り、骨とモーフの重みから計算し直す（`System`）。輪郭線用に、法線の向きに広げた位置も作る | World, Viewport |
| `MmeRenderer` | 1 フレームの順番を回す（下の「1 フレームの流れ」） | 上のすべて, SceneGraph |

### 画面（`ui/`）

- プロパティの出力（または場面）のタブに「レンダーエンジン」の欄（標準 / MME 互換）。MME 互換のときは、その下にセルフシャドウ（オン・オフ、影の距離）と地面の影（オン・オフ）。
- 「効果」タブに「MME 互換」の欄（レンダーエンジンが MME 互換のときだけ出す）。
  - 選んでいる物の .fx: 「読み込む…」「外す」と、コンパイルの結果（成功・警告の数・エラー。開くと全部の一覧）。
  - ポストエフェクトの一覧: 足す・上下に並べ替える・オン・オフ・外す。それぞれにコンパイルの結果。
  - 「割り当てはページを開き直すと消えます」と一言書く。

### ほかの部分への変更

- **コンパイラ（第 1 の計画）**
  1. `SamplerDecl` に `register: string | null`（`register(s0)` の `'s0'`）を足す。MMD 標準のシェーダーは、セルフシャドウの深度マップを `sampler DefSampler : register(s0);` のようにレジスタの番号で受け取るため。
  2. `gl_Position` に書く式に、半画素ずらす `uniform vec2 mme_halfPixel` を足す（`gl_Position.xy += mme_halfPixel * p.w`。uniform の一覧には `builtin` として出す）。
- **MMD の読み込み**（`MmdLoader`・`fromMmd`）: トゥーンとスフィアマップのテクスチャ、スフィアの種類（乗算・加算・サブテクスチャ）、材質ごとの「地面の影」「セルフシャドウ」「輪郭線」の描画フラグを捨てずに残す。
- **SDEF の値**（C・R0・R1）と頂点の輪郭線の倍率: MMDLoader の結果に残らないので、`Skinner` は .pmx をもう一度、手元の `mmdparser`（`src/vendor/three-mmd/mmdparser.module.js`）で読んで取り出す。そのため、読み込んだ .pmx のファイルをメッシュから参照できるようにする（いまもプロジェクトの保存のために持っている）。

## 1 フレームの流れ

MMD・MME の順に合わせる。

1. **ポストエフェクト**: オンになっているポストエフェクトを、一覧の最後のものが外側になるよう入れ子にする。外側から順に technique の Script を実行し、`ScriptExternal=Color` に来たところで内側（次のポストエフェクト、いちばん内側は場面）を描く。一覧の上にあるものほど先に（場面の近くで）かかる。ポストエフェクトが 1 つもなければ、場面を描画先に直接描く。
2. **場面**
   1. セルフシャドウがオンなら、全モデルの `zplot` の pass を、ライトから見た深度マップ（2048×2048、`R32F`。描けなければ RGBA8 に詰める）に描く。
   2. モデルを置いた順に 1 つずつ: 地面の影（`shadow`。地面の影がオンで、材質のフラグがオンの材質）→ 本体（材質ごとに、セルフシャドウがオンなら `object_ss`、オフなら `object`）→ 輪郭線（`edge`。材質の輪郭線のフラグがオンの材質）。
   3. その `MMDPass` に合う technique が .fx にないときは、`default.fx` の technique で描く（MME と同じ）。中身が空の technique は「その pass は描かない」の意味。
3. **編集用の表示**: ビューポートでだけ、グリッド・ギズモ・選択の輪郭線などを上に重ねる。

物の technique の Script（`Draw=Geometry` など）も `script.ts` で実行する。`Draw=Geometry` は「いまの材質の部分（サブセット）を描く」、`Draw=Buffer` は「描画先いっぱいの四角を描く」。

## MMD が .fx に渡す値

MMD 標準のシェーダー（MME の `full.fx`）が前提にしている MMD の決まりに合わせる。

### 材質（`Object = "Geometry"`。省略したときもこれ）

| セマンティクス | 値 |
|---|---|
| `DIFFUSE` | .pmx の拡散色と不透明度 (r, g, b, a) |
| `AMBIENT` | .pmx の拡散色 (r, g, b)（MME の決まり） |
| `EMISSIVE` | .pmx の環境色 (r, g, b)（MME の決まり） |
| `SPECULAR` | .pmx の反射色 |
| `SPECULARPOWER` | .pmx の反射の強さ |
| `TOONCOLOR` | トゥーンテクスチャのいちばん下の行の色（トゥーンがなければ白） |
| `EDGECOLOR` | .pmx の輪郭線の色 |
| `GROUNDSHADOWCOLOR` | 地面の影の色（既定は MMD と同じ半透明の黒） |
| `MATERIALTEXTURE`・`MATERIALSPHEREMAP`・`MATERIALTOONTEXTURE` | 材質のテクスチャ・スフィアマップ・トゥーン |
| `ADDINGTEXTURE`・`MULTIPLYINGTEXTURE`・`ADDINGSPHERETEXTURE`・`MULTIPLYINGSPHERETEXTURE` | 材質モーフの値（この計画では材質モーフがないので、加算 0・乗算 1） |

形（立方体など、MMD でない物）は、マテリアルのベースカラーとアルファから作る: 拡散色 = ベースカラー、不透明度 = アルファ、環境色 = ベースカラー × 0.5、反射色 = 0、反射の強さ = 5、輪郭線なし。

### ライト（`Object = "Light"`）

| セマンティクス | 値 |
|---|---|
| `DIFFUSE` | (0, 0, 0)（MME の決まり） |
| `AMBIENT`・`SPECULAR` | ライトの色 |
| `DIRECTION`・`POSITION` | ライトの向き・位置（左手系） |
| `VIEW`・`PROJECTION` ほか行列 | セルフシャドウの深度マップを描くときのライトのカメラ（正射影。いまの標準のエンジンの太陽の影と同じ範囲） |

ライトの色と向きは、場面の設定の太陽から取る: 色 = 太陽の色 × min(明るさ ÷ π, 1)、向き = 太陽の来る向きの逆。

### カメラ（`Object = "Camera"`。行列で省略したときもこれ）・そのほか

- `WORLD`・`VIEW`・`PROJECTION`・`WORLDVIEW`・`VIEWPROJECTION`・`WORLDVIEWPROJECTION` と、それぞれの `INVERSE`・`TRANSPOSE`・`INVERSETRANSPOSE`。
- `POSITION`・`DIRECTION`（カメラ）。
- `VIEWPORTPIXELSIZE`: いまの描画先の大きさ（ピクセル）。
- `TIME`・`ELAPSEDTIME`: タイムラインの時刻（秒）と、前のフレームからの時間。書き出しで同じ絵になるよう、`SyncInEditMode` によらずいつもタイムラインに合わせる。
- `STANDARDSGLOBAL`: 値は入れない（注釈を `EffectDesc` から読むだけ）。
- 名前で決まる変数（セマンティクスなし）: `parthf`（セルフシャドウがオン）、`transp`（半透明の材質）、`spadd`（スフィアが加算）、`use_texture`・`use_spheremap`・`use_toon`（その材質にあるか）、`use_subtexture`・`opadd`（いつも false）。

### pass ごとの特別な値

- **地面の影**（`shadow`）: `WORLD` に「ライトの向きで地面（y = 0）に潰す行列」を掛けた行列を渡す（MMD の決まり。.fx は `WorldViewProjection` を掛けるだけで地面の影になる）。
- **輪郭線**（`edge`）: 頂点の位置を、法線の向きに「材質の輪郭線の太さ × 頂点の輪郭線の倍率 × カメラからの距離に比例する係数」だけ広げて渡す（MMD は CPU で広げた頂点を渡している）。係数は、標準のエンジンの輪郭線とほぼ同じ太さになるように決め、e2e で比べる。

### この計画で値を入れないもの

`CONTROLOBJECT`・`OFFSCREENRENDERTARGET`（第 3 の計画）、`MOUSEPOSITION` などマウスの値、`TEXTUREVALUE`、`ANIMATEDTEXTURE`（最初のフレームだけ使う）は、既定の値（0・空のテクスチャ）を入れて、警告の一覧に出す。

## 座標と向きの約束

- **頂点**: CPU で変形した位置と法線を、MMD の左手系（z を反転）で `a_POSITION`・`a_NORMAL` に渡す。`a_TEXCOORD0` は UV（UV モーフ込み）、追加 UV は `a_TEXCOORD1` から。
- **行列**: 左手系に直した行列（列ベクトルの書き方で `S·M·S`、`S = diag(1, 1, −1)`）の three.js の `Matrix4.elements`（列ごとの並び）は、数の並びが D3D の行ごとの並びと同じなので、そのまま渡す（コンパイラの「D3D の行列はそのまま、`transpose=false`」と合う）。
- **`VIEW`・`PROJECTION`**: カメラから D3D の決まり（左手系、深度 0〜1）で作る。深度を GL の −1〜1 に直す式は、コンパイラが入れ済み。
- **上下の向き**
  - 画面（canvas）に描くとき `mme_flipY = 1`、レンダーターゲット（深度マップを含む）に描くとき `mme_flipY = −1`。こうすると、GL のテクスチャの 1 行目が D3D の画面の上の行になり、D3D の座標（v = 0 が上）でレンダーターゲットを読んでも正しい向きになる。
  - 画像ファイルのテクスチャは、three.js の既定の上下反転（`flipY`）を切って読む（理由は同じ）。
- **面の向き**: 上下を返すと三角形の回る向きも逆になるので、描画先ごとに `frontFace` を合わせ、D3D の `CullMode`（既定 `CCW`）と同じ面を消す。`VFACE` は `gl_FrontFacing` に従う。
- **半ピクセル**: DX9 は画素の中心が整数の位置、GL は 0.5 の位置にある。DX9 向けのポストエフェクトはそれを見越して texcoord に半画素足しているので、全部の描画で `mme_halfPixel = (−1 / 幅, mme_flipY / 高さ)` だけずらして、DX9 のラスタライズをまねる。

## テクスチャ

- **ファイルの渡し方**: .fx が入っているフォルダごと選ぶ（フォルダの選択とドラッグ＆ドロップ）。`#include` と `ResourceName` は、そのフォルダから大文字小文字を無視して探す（`compileEffect` の `listFiles`）。
- **画像ファイル**（`ResourceName`）: png・jpg・bmp・gif・webp はブラウザで、tga と dds は three.js のローダーで読む。dds は DXT1/3/5（`WEBGL_compressed_texture_s3tc` がある環境）と、圧縮していない形式。読めない・見つからないときは赤紫の 1×1 にして警告を出す。`MipLevels` が 1 でなければミップマップを作る。
- **サンプラーステート**: `MinFilter`・`MagFilter`・`MipFilter`・`AddressU/V/W`・`MaxAnisotropy` を three.js のテクスチャの設定に移す。同じテクスチャを違う設定のサンプラーで使うときは、テクスチャの写し（GPU の中身は共有）を作る。`BorderColor`（`BORDER`）は GL にないので `CLAMP` にして警告を出す。
- **レンダーターゲットの形式**: `A8R8G8B8`・`X8R8G8B8` → RGBA8、`A16B16G16R16F` → RGBA16F、`A32B32G32R32F` → RGBA32F、`R16F`・`R32F`・`G16R16F`・`G32R32F` → 対応する形式、`D24S8` → 深度とステンシル。浮動小数に描けない環境では RGBA8 に落として警告を出す。

## 描画ステート

`RenderState` を three.js の材質の設定に移す。

- `ZEnable`・`ZWriteEnable`・`ZFunc` → `depthTest`・`depthWrite`・`depthFunc`
- `AlphaBlendEnable`・`SrcBlend`・`DestBlend`・`BlendOp`（と `…Alpha`）→ `blending = CustomBlending` と各係数
- `CullMode` → `side`（上の「面の向き」で描画先ごとに直す）
- `StencilEnable` ほか → three.js のステンシルの設定
- `ColorWriteEnable` → `colorWrite`（RGBA ごとに分けられないものは、全部か無しにして警告）
- `AlphaTestEnable`・`AlphaFunc`・`AlphaRef`（D3D の固定機能）: GL にないので、MME 互換ではこの計画では無視して警告を出す（`default.fx` は使わない）。第 5 の計画で、コンパイラが `discard` を差し込む形で扱う。
- 値が `{ expr }`（定数にできなかった式）のステート: 既定の値にして警告を出す。

## エラーの扱い

どんなときも、ふつうの描画は止めない。

- **コンパイルの失敗**: 最初のエラー（code・ファイル:行・文）をお知らせに出し、欄で全部を見られるようにする。物の .fx なら `default.fx` で描き、ポストエフェクトなら飛ばす。
- **GL での失敗**（リンクできない・フレームバッファが不完全・拡張がない）: そのエフェクトを止めて、お知らせを 1 回だけ出す。
- **MME の描画全体が例外を出したとき**: そのフレームは標準のエンジンで描き、お知らせを出す（同じ例外ではくり返し出さない）。
- **値を入れないセマンティクス・無視したステート**: 欄の警告の一覧に出す。

## 重さ

- CPU の変形は、レンダーエンジンが MME 互換のあいだだけ行う。変形後の形は最初に要るときに作り、骨・モーフの重みが変わったフレームだけ計算し直す。
- 目安: 約 5 万頂点のモデルの CPU の変形が、1 フレーム 8 ms 以内（Mac）。測って文書に書くが、テストにはしない。

## テスト

1. **単体テスト（vitest。`core/mme`）**
   - セマンティクス: 決まったカメラと物で、行列（`INVERSE`・`TRANSPOSE` も）が手で計算した値と合う。three.js の (0, 0, 1) が MMD の z = −1 になる。材質・ライトの値の表どおり。地面の影の行列で、ライトの向きに沿って y = 0 に潰れる。
   - technique の選び方: `MMDPass`・`Subset`（`"0-3,5"` など）・`UseTexture` などの組み合わせの表。
   - Script の実行: 偽の `ScriptBackend` で、命令の順番・`LoopByCount`/`LoopGetIndex`・`ScriptExternal` の入れ子。
   - レンダーターゲットの大きさと形式。
   - CPU の変形: BDEF1/2/4 は three.js の `SkinnedMesh.applyBoneTransform` の結果と照らし合わせる。SDEF は手で作った小さな例で式を確かめる。頂点モーフ・UV モーフ。輪郭線の広げ方。
2. **エンジンのテスト（描画先なし）**: レンダーエンジンの切り替えと保存、.fx の割り当て、コンパイルに失敗したときに `default.fx` に戻ること、ポストエフェクトの並べ替え・オン・オフ。
3. **e2e（本物の WebGL2。書き出した画像の画素を見る）**。テスト用の .pmx は `e2e/fixtures/pmx.ts` で作る。
   - `default.fx`: 材質の色（MMD の式で計算した色）で描かれる・輪郭線の色が出る・地面の影が落ちる・セルフシャドウで片方の箱にもう片方の影が落ちる。
   - 物の .fx: 単色の .fx でその色になる。`MATERIALDIFFUSE` をそのまま出す .fx で材質の色になる。
   - ポストエフェクト: 色の反転で 1 − 元の色になる。中間のレンダーターゲット（`ViewportRatio = 0.5`）を使う 2 pass のぼかし。`LoopByCount`。MRT。
   - 向き: レンダーターゲットの左上を読むと場面の左上になる。上が赤・下が青の画像を貼ると上が赤になる。片面の四角は表からだけ見える。`VPOS.y` は上の行が 0。
   - 半ピクセル: `ViewportOffset` を足して 1:1 で写すポストエフェクトで、市松模様がにじまずにそのまま写る。
   - 変形: 骨を曲げたモデルの輪郭が、標準のエンジンとほぼ同じになる（画素の違いが小さい）。輪郭線の太さも標準のエンジンとほぼ同じ。
   - 書き出し・画面・エラー: 動画の書き出しで MME 互換のままフレーム数が合う。画面からレンダーエンジンを切り替え、.fx を読み（`setInputFiles`）、ポストエフェクトを並べ替え・オン・オフできる。壊れた .fx でお知らせが出て、モデルは `default.fx` で描かれる。
   - 標準のエンジンの絵が変わらない（いまある e2e がそのまま通る）。
4. **目で確かめる**: 手持ちのエフェクトを `fx/` から読み、画面で見る。

## 合格の基準

- 上のテストがすべて通り、`npm run test:all` が通る（CI の Linux・ソフトウェア描画でも）。
- 標準のエンジンの絵が変わらない。
- CPU の変形の速さを測って文書に書く。
- ARCHITECTURE.md に `engine/mme`・`core/mme` を、README に MME 互換モードの使い方とできないことを書き足す。

## この計画に入れないもの

- 第 3 の計画: `OFFSCREENRENDERTARGET`・.x アクセサリ・`CONTROLOBJECT`・.emm・材質ごとの割り当て・割り当てのプロジェクトへの保存と元に戻す・パラメータの画面（`UIWidget` など）・`fx/` の一覧と MCP の命令。
- 第 4 の計画: Ray-MMD を描くこと。
- 第 5 の計画: D3D のアルファテスト、そのほか `fx:check` で見つかるもの。
