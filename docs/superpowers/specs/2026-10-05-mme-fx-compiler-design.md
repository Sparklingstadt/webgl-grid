# MME 互換モード — 第 1 の計画: FX コンパイラ 設計書

- 日付: 2026-10-05
- 状態: 設計（承認待ち）

## 目的

MME（MikuMikuEffect）の .fx を、webgl-grid でそのまま動かせるようにしたい。Ray-MMD はその 1 つで、いちばん動かしたいエフェクト。

- いまの描画（ノードのマテリアル・組み込みの「効果」・ビューポートの表示）には手を入れず、**「MME 互換モード」という別のレンダラー**を作る。オンにしたときだけ、描画を丸ごと差し替える（`Viewport.drawOverride` の差し込み口を使う）。
- MME の .fx は DirectX 9 の HLSL で書かれていて、ブラウザではそのまま動かない。そこで、.fx を読んで WebGL2 の GLSL に変換するコンパイラと、MME の決まりどおりに描く実行部を作る。

## 全体の分け方

MME 全般を動かすのは 1 回の設計では収まらないので、5 つの計画に分け、順に作る。それぞれ別に設計・計画・実装する。**この設計書は第 1 の計画（FX コンパイラ）だけを扱う。**

| # | 部分 | 中身 | 依存 |
|---|---|---|---|
| 1 | **FX コンパイラ** (`core/`) | 前処理、エフェクトの外側と関数の中身のパーサー、型チェック、GLSL ES 3.00 の書き出し | なし |
| 2 | MME ランタイム (`engine/`) | 互換レンダラー本体: セマンティクスの値の受け渡し、Script の実行、レンダーターゲット・MRT、three.js のスキニングとモーフの差し込み、ポストエフェクトの順番 | 1 |
| 3 | エフェクトの割り当て | 物ごとの .fx の割り当て、`OFFSCREENRENDERTARGET`、アクセサリ（.x）、`CONTROLOBJECT`、.emm の読み書き、プロジェクトへの保存 | 2 |
| 4 | Ray-MMD で合格 | Ray-MMD 1.5.x の標準構成が動くまで、足りない機能を埋める | 3 |
| 5 | ほかの MME エフェクト | AutoLuminous・ikPolishShader など、よく使われるものを順に | 4 |

第 1 と第 2 の境目が、全体の設計でいちばん大事な点。コンパイラは「.fx の文字列 → 型の付いたエフェクトの記述 + GLSL」という純粋な関数にし、ランタイムはその記述だけを見て描く。こうすると、コンパイラは WebGL なしでテストでき、ランタイムは HLSL の細かいことを知らずに済む。

## 決めたこと

- 動かす範囲は **MME 全般**（Ray-MMD はその 1 つ）。
- 最初の区切りは **コンパイラだけを仕上げること**。
- HLSL → GLSL の変換は **TypeScript で自前で書く**。
  - npm には HLSL を読める WASM の道具がない（`@webgpu/glslang` は 2020 年のもので GLSL だけ。`naga-wasm` は HLSL を出力できるだけ）。glslang + SPIRV-Cross を使うには、emscripten で自分で WASM にビルドし続ける必要がある。
  - .fx は「エフェクトの外側」（注釈・`sampler_state`・pass の描画ステート・Script）と「シェーダーの関数」が 1 つのファイルに混ざっている。外側のパーサーはどの方式でも自前で要るので、同じパーサーで関数の中身まで読めば、増えるのは型チェックと書き出しだけになる。
  - 道具のビルドが要らない。MME 特有のくせを自分で決めて直せる。エラーを日本語で、元の .fx の行番号付きで出せる。書き出す GLSL が読みやすい。vitest で全部テストできる。
  - いちばん大きい仕事は型チェッカー（組み込み関数のオーバーロード・暗黙の型変換・行列の演算）。fxc との食い違いは、見本の .fx を全部通すテストと、WebGL2 で値を確かめるテストで見つける。
- 見本の .fx は二段構え。
  - Git に入れる: 自作の小さな .fx（機能ごとに 1 つ）と、Ray-MMD 1.5.2 の文字のファイル（.fx・.fxsub・.conf）。Ray-MMD は MIT ライセンス（Copyright (C) 2016-2018 Rui）で、`LICENSE.txt` を一緒に入れれば再配布してよい。
  - Git に入れない: 手持ちのほかのエフェクトは `fx/` に置く（`models/` と同じ扱い。MME のエフェクトは規約がまちまちで、再配布できないものも多い）。あるときだけ `npm run fx:check` で確かめる。

## 前提

- 出力は **WebGL2 の GLSL ES 3.00** だけ（three.js はもう WebGL1 では描けない）。
- コンパイラは `src/core/fx/` に置く純粋な関数で、three.js・WebGL・DOM には触らない。同期で動き、ファイルの中身は呼び出し側が渡す。
- コンパイラは **「何を描くか」は解釈しない**。セマンティクスの値を入れる・Script を実行する・テクスチャを読むのはランタイムの仕事。コンパイラは、それらを読みやすい形にして渡すだけ。

## 入口と出口

```ts
compileEffect(entry: string, readFile: (path: string) => Uint8Array | null,
              options?: { defines?: Record<string, string>; listFiles?: () => string[] }): EffectResult

type EffectResult =
  | { ok: true;  effect: EffectDesc; warnings: Diagnostic[] }
  | { ok: false; errors: Diagnostic[]; warnings: Diagnostic[] }

interface EffectDesc {           // JSON にできる (あとでキャッシュや Worker に回せる)
  params: Param[];               // グローバル変数: 型・セマンティクス・注釈・初期値 (定数なら計算済み)
  textures: TextureDecl[];       // 注釈 (ResourceName・Format・ViewportRatio …) はそのまま渡す
  samplers: SamplerDecl[];       // どのテクスチャか・フィルター・ラップ
  techniques: Technique[];       // 注釈 (MMDPass・Subset・UseTexture …)・Script を命令の列にしたもの・pass
}
interface Technique {
  name: string; annotations: Annotation[]; script: ScriptCommand[]; passes: Pass[];
}
interface Pass {
  name: string; annotations: Annotation[]; script: ScriptCommand[];
  states: RenderState[];         // AlphaBlendEnable・ZEnable・CullMode … を種類と値に直したもの
  program: Program | null;       // シェーダーのない pass は null
}
interface Program {
  vertex: string; fragment: string;   // GLSL ES 3.00
  uniforms: UniformRef[];             // 使っているグローバル変数・サンプラーと、GLSL での名前
  attributes: AttributeRef[];         // POSITION・NORMAL・TEXCOORD0 … と、GLSL での名前
  outputs: number;                    // COLOR0〜3 (MRT) の数
  uniformVectors: number;             // uniform に使うベクトル (vec4) の数。GPU の限界はランタイムが見る
}
```

- `readFile` は、エントリーの .fx からの相対パス（`/` 区切り）で呼ばれる。**大文字と小文字の違いと `\` の区切りは、コンパイラの側で吸収する**（Ray-MMD 自身が `Shader/math.fxsub` を `shader/math.fxsub` と書いていて、Windows では通るため）。具体的には、まず書かれたとおりのパスで探し、なければ呼び出し側に渡された一覧から大文字小文字を無視して探す。そのため `readFile` に加えて、`options.listFiles`（エントリーのフォルダから見た、すべてのファイルの相対パス）を受け取れるようにする（なければ書かれたとおりのパスだけで探す）。
- 文字コードはコンパイラが見分ける（BOM 付きの UTF-8・UTF-16、BOM なしは UTF-8 として正しければ UTF-8、そうでなければ Shift-JIS。Shift-JIS の読み方はいまある `core/sjis.ts` を使う）。

## コンパイラの中の段階

```
バイト列 ─▶ ① 前処理 ─▶ ② 構文解析 ─▶ ③ 型チェック ─▶ ④ GLSL の書き出し ─▶ EffectDesc
```

段階ごとに別のファイルにし、1 つずつテストする。どの段階でも、すべての字句が「元のファイル名と行と列」を持ち歩くので、エラーはいつも元の .fx の場所で出せる。

### ① 前処理 `preprocess.ts`

- 文字コードの判定、CRLF、行末の `\` でつなぐ行、`#include`、`#define`（引数付きのマクロ、`#` と `##` も）、`#if`・`#elif`・`#else`・`#ifdef`・`#ifndef`・`defined()`、`#undef`、`#error`。`#pragma` は読み飛ばす。
- `#include "…"` は、include しているファイルのフォルダから探し、なければエントリーの .fx のフォルダから探す。
- Ray-MMD は注釈の文字列の途中に `#if` を挟んでいる（`"Pass=SSDO;"` を丸ごと出し入れする）ので、前処理は文字列の連結より先に済ませる（連結は構文解析で行う）。
- 同じファイルを何度も include しても止まらないよう、深さの上限（64）を設ける。

### ② 構文解析 `lexer.ts`・`parser.ts`・`ast.ts`

.fx 全体を 1 つの AST にする。

- グローバル変数: `static`・`const`・`uniform`・`shared`・`extern`・`row_major`・`column_major`、セマンティクス（`: WORLDVIEWPROJECTION`）、`< >` の注釈、初期値（式・`{ }` のリスト・`sampler_state { }`）、`register(…)` は読み飛ばす。
- 型: `float`・`half`・`double`（どれも float として扱う）・`int`・`uint`・`bool`、`floatN`・`floatNxM`・`vector<…>`・`matrix<…>`、配列、構造体、`texture`・`texture2D`・`texture3D`・`textureCUBE`、`sampler`・`sampler2D`・`sampler3D`・`samplerCUBE`、`string`、`typedef`。
- 関数: 引数の `in`・`out`・`inout`・`uniform`、引数と戻り値のセマンティクス、既定値。
- 文: 宣言・式・`if`・`for`・`while`・`do`・`switch`・`break`・`continue`・`return`・`discard`、`[unroll]` などの属性は読み飛ばす。
- `technique`・`pass`: 注釈、描画ステートの代入、`VertexShader = compile vs_3_0 F(引数);`。
- 隣り合う文字列の連結（`"a;" "b;"` → `"a;b;"`）。

### ③ 型チェック `types.ts`・`intrinsics.ts`・`check.ts`

- 名前の解決（グローバル・関数・構造体・ローカルのスコープ）、式の型、関数と組み込み関数（約 100 個の表）のオーバーロードの解決。
- 暗黙の型変換: スカラーをベクトル・行列に広げる。ベクトル・行列の切り詰めは fxc と同じく警告にして通す。`int` と `float` の混ざった演算は float にする。
- 定数の計算: `const` と、初期値が定数の `static`、pass の引数の定数の部分、配列の大きさ。
- **型を見るのは、pass から使われている関数だけ。** 構文はすべて読むが、使われていない関数の中の型の誤りでは失敗させない（fxc で一度も試されていない古いコードが混ざっていることが多いため）。

### ④ GLSL の書き出し `emit.ts`

pass ごとに、頂点とフラグメントのシェーダーを 1 本ずつ書く。使っている変数・関数・構造体だけを入れる。先頭は `#version 300 es` と `precision highp float; precision highp int;`（サンプラーの精度も）。

DX9 と GLSL の違いは、次のように吸収する。

| くせ | 扱い |
|---|---|
| 行列と `mul` | HLSL の行を GLSL の列として持つ（HLSL の `floatRxC` → GLSL の `matRxC`。GLSL の `matCxR` は C 列 R 行なので、R 行 C 列の HLSL の行列の転置がそのまま入る）。`mul(a, b)` → `(b) * (a)`。`M[i]` は HLSL の i 行目で、GLSL でもそのまま `M[i]`。ランタイムは、D3D の行列（行ごとに並んだ 16 個の数）をそのまま `uniformMatrix4fv(…, false, …)` で渡せばよい |
| `row_major`・`column_major` の付いた行列 | レジスタへの詰め方だけの違いで、DX9 のエフェクトの仕組み (`SetMatrix`) が吸収するので、行列の意味は変わらない。読み飛ばして、ほかの行列と同じに扱う |
| `static` で uniform などから計算する初期値（`static float x = lerp(u, …)`） | GLSL では全体の初期値に使えないので、ふつうのグローバル変数にして、`main` の最初で計算する |
| `compile ps_3_0 F(Samp, float2(…))` の引数 | `F` の `uniform` の引数として、書き出す `main` の中で式を埋め込んで渡す（サンプラーはそのサンプラーの uniform を渡す） |
| 頂点の入力 | セマンティクスごとの `in`（`POSITION` → `a_POSITION`、`TEXCOORD0` → `a_TEXCOORD0` …）。`attributes` に対応を書く |
| 頂点からフラグメントへ | セマンティクス（`TEXCOORDn`・`COLORn`）で対応づけた `out`/`in`。構造体の入出力はメンバーごとに分ける |
| フラグメントの出力 | `COLOR0〜3` → `layout(location = n) out vec4`、`DEPTH` → `gl_FragDepth` |
| `VFACE`・`VPOS` | `VFACE` → `(gl_FrontFacing ? 1.0 : -1.0)`、`VPOS` → `gl_FragCoord.xy`（上下の向きは下の行で直す） |
| D3D と GL の座標の違い（深度の範囲 0〜1 と −1〜1、上下の向き、DX9 の半ピクセルのずれ） | 直す**仕組み**だけコンパイラが入れる。`gl_Position` に書く直前に深度の範囲を直す式（`z = 2z − w`）と、uniform `mme_flipY`（1 か −1）を掛ける式を入れ、`VPOS`・`ddy` にも同じ uniform を使う。いつ上下を返すか、半ピクセルをどう扱うかの**方針**はランタイムが決める |
| 組み込み関数の意味の違い | `fmod(a, b)` → `a - b * trunc(a / b)`（GLSL の `mod` は切り捨ての向きが違う）、`ddx`/`ddy` → `dFdx`/`dFdy`（`ddy` は `mme_flipY` を掛ける）、`clip(x)` → x の成分のどれかが 0 より小さければ `discard`（スカラーなら `if (x < 0.0) discard;`、ベクトルなら `any(lessThan(x, vecN(0.0)))`）、`saturate` → `clamp(x, 0, 1)`、`lerp` → `mix`、`frac` → `fract`、`rsqrt` → `inversesqrt`、`atan2(y, x)` → `atan(y, x)`、`tex2D` → `texture`、`tex2Dlod` → `textureLod`、`tex2Dbias` → `texture(…, bias)`、`tex2Dproj` → `textureProj`、`tex2Dgrad` → `textureGrad`、`texCUBE`・`tex3D`・`tex1D`（2D の 1 行として扱う）も同じ |
| 整数とビット演算 | SM3 の整数は中身が float なので、`int` の割り算・剰余は fxc の結果に合わせて書き出す（0 に向けて切り捨て）。ビット演算は SM3 にないので、出てきたら型の誤りにする |
| GLSL の予約語・組み込み名とぶつかる名前（`input`・`output`・`sample`・`texture`・`smooth` …） | その名前だけ後ろに `_` を付けて変え、対応は `uniforms` などに書く |

### Script と描画ステート `script.ts`・`states.ts`

- 注釈の `Script` の文字列を、命令の列にする（実行はしない）。
  - 例: `"RenderColorTarget0=ScnMap; Pass=SSDO;"` → `[{ cmd: 'RenderColorTarget', index: 0, value: 'ScnMap' }, { cmd: 'Pass', value: 'SSDO' }]`
  - 対象は MME の命令すべて: `RenderColorTarget[n]`・`RenderDepthStencilTarget`・`ClearSetColor`・`ClearSetDepth`・`ClearSetStencil`・`Clear`・`ScriptExternal`・`Pass`・`LoopByCount`・`LoopEnd`・`LoopGetIndex`・`Draw`。知らない命令は警告にして残す。
- pass の描画ステート（`AlphaBlendEnable = FALSE; SrcBlend = SRCALPHA; CullMode = NONE;` など）を、種類と値（D3D の定数名と、数値・真偽値）に直して渡す。値が式（グローバル変数を使うもの）のときは、定数に計算できればその値、できなければ式のまま警告にする。

## エラーと「未対応」の扱い

### エラーの形 `diagnostics.ts`

```ts
interface Diagnostic {
  severity: 'error' | 'warning';
  code: string;      // 'FX-PP-INCLUDE-NOT-FOUND' など。テストは文ではなくこれで確かめる
  message: string;   // t('…') で訳した文
  file: string; line: number; column: number;
  includedFrom?: { file: string; line: number }[];  // #include の中で起きたときの、include した場所の列
}
```

- 文は `t('…')` で書き、英語・中国語（簡体字・繁体字）の辞書にも足す（いまの `i18n.test.ts` が、訳のない文を見つける）。
- code の一覧は `diagnostics.ts` にまとめる。

### どこまで失敗させるか（MME に合わせる）

- 前処理・構文の誤り、pass から使われている関数の型の誤り → **エフェクト全体を失敗**にする。MME も fxc がエラーを出せば、そのエフェクトは丸ごと使えない。途中まで動く中途半端なものは作らない。
- 使われていない関数の中の型の誤り → 何も言わない。
- 構文の誤りは最初の 1 つで止める。型の誤りは最大 20 個まで集めて出す。

### 警告にするもの（失敗はさせない）

- ベクトル・行列の暗黙の切り詰め（fxc と同じ）
- 知らない描画ステートの名前・知らない Script の命令（無視して進む）
- 定数に計算できない描画ステートの値

### 未対応ははっきり「未対応」と言う

黙って捨てたり、違う意味で書き出したりはしない。分かっていて最初は作らないものは、名前を挙げて `FX-UNSUPPORTED` のエラーにする。

- `asm { }` のブロック（シェーダーをアセンブリで書いたもの）と、`vs_1_x`・`ps_1_x` のアセンブリ
- SM4 以降の書き方（`Texture2D.Sample`・`cbuffer` など。MME は DX9 なので、ふつうは出てこない）
- テクスチャを手続きで作る `tx_1_0`（TextureShader）

見本を全部通すテストと `fx:check` でこれを数え、本当に要るものだけ足していく。

### WebGL2 の限界との関係

uniform の数・MRT の数・浮動小数のレンダーターゲットなど、**GPU によって変わる限界はコンパイラでは決めない**。コンパイラは pass ごとに `uniformVectors`・`outputs` を書いて渡し、足りるかどうかはランタイムが実際の GPU で判断する。

## 置き場所

```
src/core/fx/
  index.ts         compileEffect (入口)
  diagnostics.ts   Diagnostic と code の一覧
  preprocess.ts  lexer.ts  parser.ts  ast.ts
  types.ts  intrinsics.ts  check.ts
  emit.ts  script.ts  states.ts
  *.test.ts        段階ごとの単体テスト
  fixtures/*.fx    自作の小さな .fx (機能ごとに 1 つ)
third_party/ray-mmd-1.5.2/     Git に入れる。.fx・.fxsub・.conf だけを、フォルダの形のまま
  LICENSE.txt  README.md      README に「どこから・どのタグ (とコミット)・何を入れたか」を書く
fx/                            Git に入れない (models/ と同じ扱い。README.md だけ入れる)
scripts/fx-check.ts            npm run fx:check: fx/ と Ray-MMD を全部変換して、結果の表を出す
```

- `.gitignore` に `/fx/*` と `!/fx/README.md` を足す。
- Ray-MMD のファイルは、実装のときに GitHub（ray-cast/ray-mmd のタグ 1.5.2）から取ってくる。取ってくる前に、もう一度確認する。
- `third_party/` は lint の対象にしない（いまの lint は `src` などのフォルダを名指ししているので、そのままで対象外）。

## テスト

1. **単体テスト（vitest・Node）**: 段階ごとに、小さな入力と期待する出力で確かめる。書き出した GLSL は、短いものは文字列で照らし合わせ、長いものは「GLSL ES 3.00 として読めるか」を `@shaderfrog/glsl-parser`（devDependencies に足す）で確かめる。
2. **本物の WebGL2 で確かめる（Playwright・e2e）**:
   - **コンパイルとリンク**: Ray-MMD の全 pass の GLSL を、ブラウザの `compileShader`・`linkProgram` に通す（CI でも SwiftShader で動く）。
   - **値の確かめ**: 意味を取り違えやすいもの（4x3 などの行列と `mul`・`fmod`・スワズルへの代入・暗黙の型変換・`int` の割り算・`static` の初期値・pass の引数・MRT）を、小さな HLSL にして 1x1 の浮動小数のレンダーターゲットに描き、読み戻した値を HLSL の仕様から手で計算した値と比べる。
3. **見本を全部通す（vitest）**: Ray-MMD のすべての .fx を変換する。`ray.fx` は `#if` で隠れる部分が多いので、標準の `ray.conf` に加えて、`ray.conf` の 18 個の切り替え（`AA_QUALITY`・`SSR_QUALITY`・`BOKEH_QUALITY` など）を 1 つずつ、`ray.conf` の説明に書かれたそれぞれの値（例: `AA_QUALITY` は 0〜5）に変えた組み合わせでも変換する。切り替えは `options.defines` で上書きするのではなく、`ray.conf` の該当する `#define` の値を書き換えた中身を `readFile` から渡す（`#define` の二重定義を避けるため）。
4. **fx/ の確かめ（`npm run fx:check`）**: `fx/` は CI にないので、テストではなく表で見る。ファイルごとに「成功／失敗した code と場所／変換にかかった時間」を出す。

## 合格の基準（この計画の終わり）

- Ray-MMD 1.5.2 の **すべての .fx がエラー 0** で変換でき（上の切り替えの組み合わせも含む）、**すべての pass の GLSL が WebGL2 でリンクできる**。
- 値の確かめのテストがすべて通る。
- `npm run test:all`（型チェック・lint・単体・e2e）が通る。
- ARCHITECTURE.md に `core/fx` を、README に `fx/` フォルダと `fx:check` を書き足す。
- 速さの目安: Ray-MMD でいちばん大きい .fx でも、1 本 200 ms 以内（Mac）。`fx:check` で測って表に出すが、テストでは確かめない（機械によって揺れるため）。

## この計画に入れないもの

- 画面に出すこと（ランタイム・互換レンダラー）。アプリの見た目はこの計画では変わらない。
- セマンティクスの値を入れること、Script の実行、テクスチャ（DDS など）の読み込み、.x アクセサリ、エフェクトの割り当て。
- コンパイル結果のキャッシュと Worker での実行（`EffectDesc` を JSON にできる形にしておくだけ）。
