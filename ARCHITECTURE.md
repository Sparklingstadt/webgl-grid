# アーキテクチャ

## 方針

3 つの層に分け、依存は **上から下への一方向** だけにします。

```
ui/      React の画面 (部品・ショートカット)
  ↓ engine の公開 API (Engine クラス) と、UiChannel のストアだけを使う
engine/  three.js の実行部 (場面・描画・操作・アニメーション・MMD)
  ↓
core/    純粋な計算とデータ (three.js の数学ライブラリは使ってよいが、場面・DOM・WebGL には触らない)
```

- **core** は単体テストしやすい計算をまとめた場所です（シェーダーノードとノードツリー、ノードからの GLSL の組み立て、.pmx の材質の書き換え、積み重ねの判定、髪の錘の見つけ方、キーフレームの補間、.vpd の書式、Shift-JIS、タイムラインの目盛り、ストア、イベント）。
- **engine** は、役割ごとのクラス（サービス）でできています。モジュールのグローバル変数は持たず、使う相手はコンストラクタで受け取ります。`Engine` がすべてを組み立てる場所（コンポジションルート）で、画面への窓口（ファサード）も兼ねます。
- **ui** はエンジンを React の Context（`EngineProvider` / `useEngine`）で受け取り、状態は `useUi(selector)` で購読します。

## engine の中

| 部分 | クラス | 役割 | 使う相手 |
| --- | --- | --- | --- |
| 画面への通知 | `UiChannel` | 画面に見せる状態 (ストア)・お知らせ・「変わった」番号 | なし |
| 描画 | `SceneGraph` | シーン・カメラ・光・地面のグリッド | なし |
| | `Viewport` | WebGL の描画先・描画ループ (`System` を順に update)・描く前後のフック | SceneGraph |
| | `Effects` | MME 風の後処理の設定と描画 | Viewport, UiChannel |
| マテリアル | `MaterialLibrary` | マテリアル (名前・ノードツリー・設定・輪郭線) と画像。使う物ごとに three.js の材質を作り、ノードから組み立てた GLSL を差し込み、変更を反映する | なし (イベントで知らせる) |
| | `MaterialEditor` | 選んでいる物のマテリアルの編集 (スロット・マテリアルの割り当て・ノードツリー・画像)。サイドバーとシェーダーエディターから使う | MaterialLibrary, World, Selection, UiChannel |
| 物 | `World` | 置いた物の一覧・作成・削除・積み重ね・落下 (`System`)・マテリアルスロット | SceneGraph, Viewport, UiChannel, MaterialLibrary |
| | `Selection` | 選択・選択中の輪郭線 | World, UiChannel |
| | `Cloners` | クローナー: 物の node の子にクローンを並べ (`core/cloner.ts`)、描く前に材質と、MMD モデルなら骨・表情を元の物から写す | World, Viewport |
| | `Deformers` | デフォーマ: 物の形の、位置と法線を変形した写しを作って差し替える (`core/deform.ts`)。元の形は `userData.baseGeometry` | Cloners, Viewport |
| | `ColorPicker` | スマホの色のパレット | World, Viewport, UiChannel |
| 視点と入力 | `CameraController` | オービットカメラ・レイ・決まった向き・カメラを外から動かすもの (`CameraOverride`) | SceneGraph, Viewport, UiChannel, World |
| | `InputController` | ビューポートのマウス・タッチ操作 | 上のものと、`InputActions` (Engine が渡す) |
| アニメーション | `Clock` | タイムライン (時刻・再生・範囲)。three.js にも画面にも依存しない (`System`) | なし (曲は `TimeSource` として受け取る) |
| | `Keyframes` | チャンネル (ボーン・表情) ごとのキーフレームの挿入・選択・移動・削除・補間曲線と、モデルへの反映 (計算は `core/animation.ts`) | World, Posing, Viewport, UiChannel |
| | `Music` | 曲。`TimeSource` として Clock に再生位置を渡す | UiChannel |
| MMD | `MmdLoader` | .pmx をメッシュにし、材質をプリンシプル BSDF のマテリアルに変換する (ステージかも見分ける) | UiChannel, MaterialLibrary |
| | `Physics` | 物理演算 (`System`)・髪の錘を外して垂らす。MMDPhysics は必ず等倍・親なしのモデルの座標で呼ぶ | World, Viewport, UiChannel |
| | `Stage` | ステージ | SceneGraph, Viewport, MaterialLibrary |
| | `Motion` | VMD のダンスとカメラ (`System`、カメラは `CameraOverride`) | World, Physics, Stage, CameraController, UiChannel |
| | `Posing` | 表情とボーン・IK と付与 (`System`) | World, Physics, Motion, Viewport, UiChannel |
| | `VpdIO` | ポーズファイルの保存・読み込み | Posing, Viewport, UiChannel |
| 出力 | `RenderOutput` | レンダリング: 描画先を出力の大きさにして (`Viewport.beginOutput`。ビューポートの出力の枠 `outputFrame` の中がそのまま描かれるよう、画角を合わせる)、編集用の表示を隠して描く。動画はタイムラインを 1 フレームずつ進め (`Clock.advanceTo` と `Viewport.stepSystems`)、WebCodecs で圧縮する (mediabunny)。`renderPng` / `renderVideo` はデータを返すだけ (MCP も使う)、`renderImage` / `renderAnimation` は画面の操作 (レンダー結果・保存) | Viewport, SceneGraph, Clock, Music, UiChannel |
| 元に戻す | `History` | 編集のひと区切り (マウスやキーを離した・読み込みが終わった) ごとに、場面の編集できる部分の写しを取って積む。戻すときは写しとの違いだけを直し、消した物は捨てずに持っておいて置き直す (`World.keepRemoved` / `World.restore`、`MaterialLibrary.snapshot` / `restore`) | World, MaterialLibrary, Physics, Motion, Posing, Keyframes, Clock, Selection, Viewport, UiChannel |
| 自動保存 | `Autosave` | `History` の手が増えたら少し待って、参照だけのプロジェクトと参照するファイルを `AutosaveStore` (IndexedDB。テストではメモリ) にしまう。前の回があれば「前回の続き」として開ける | ProjectIO, History, UiChannel |
| 外部からの操作 | `RemoteLink` | MCP サーバー (`mcp/`) の WebSocket につなぎ、届いた命令を 1 つずつ `commands.ts` で実行して返す。つなぐ前に、MCP サーバーが動いているかをページの配り元に問い合わせ (`REMOTE_STATUS_PATH`。コンソールにエラーを出さない)、だめなら 3 回までつなぎ直す。命令は画面と同じ `Engine` の操作を呼ぶ | Engine |
| プロジェクト | `ProjectIO` | 場面をまるごと .wgp (ZIP: `project.json` + 読み込んだファイル) か、ファイルは参照だけの .wgpj (JSON) に保存し、開くときは同じ順に作り直す。ファイル形式 (型・ZIP / JSON の読み書き) は `format.ts`。場面とのやりとりはほかのサービスをまたぐので、`Engine` を受け取る。`saveFile` / `openFile` は画面の操作 (ダウンロード・見つからないファイルの画面) | Engine |
| 組み立て | `Engine` | 上のすべてを作ってイベントでつなぎ、画面に操作を出す | すべて |

## 下から上へは「イベント」で知らせる

下の部分が上の部分を import すると循環するので、起きたことはイベント（`core/events.ts` の `Emitter`）で知らせ、つなぐのは `Engine` の役目にしています。

- `World.events.removed` → `Physics` / `Motion` が後片付け、`Selection` / `ColorPicker` が選択を外す
- `Clock.events.seek` / `advance` / `play` / `change` → `Engine` が `Motion`・`Keyframes`・`Music` に時刻を合わせさせ、画面にフレームを知らせる
- `Selection.events.changed` → `Keyframes` が選んでいたキーフレームの選択を外す
- `Music.events.loaded` → `Engine` が終了フレームを曲の長さに合わせる
- カメラモーションは `CameraOverride` として `CameraController` に渡し、ユーザーがカメラを動かすと `released()` で `Motion` に返ってくる

## 毎フレームの流れ

`Viewport` の描画ループが、動いている `System` を登録順に update してから描きます。

1. `Clock` — 再生中なら時刻を進める（→ `advance` で `Motion` と `Keyframes` が追いつく）
2. `Motion` — 止まっているあいだも姿勢を計算し直す
3. `Posing` — モーションのあるモデルに、手で動かしたボーンを重ねる
4. `Physics` — 物理演算
5. `World` — 落下アニメーション
6. 描く前のフック（カメラ・物の位置・明るさ・輪郭線・影の範囲）→ 描画（効果があれば後処理）→ 描いたあとのフック（選択とビューポート左上の文字を画面に知らせる）

何も動いていなければループは止まり、変化があったときだけ `requestDraw()` で 1 回描きます。動いているあいだに `requestDraw()` が呼ばれても、そのフレームの描画にまとめます（1 フレームに描くのは 1 回だけ。`Viewport.test.ts`）。

## 画面との約束

- 画面はエンジンの状態を `UiChannel` のストアから読むだけで、three.js のオブジェクトは持ちません。
- 1 つの部分で済む操作は、その部分を直接呼んでかまいません（`engine.clock.togglePlay()`、`engine.camera.snapView('top')`、`engine.effects.set(...)` など）。まとまった機能は、その機能のサービスを呼びます（`engine.materials`・`engine.output`・`engine.project`）。複数の部分にまたがる操作は `Engine` のメソッドにします（`loadFiles`・`insertKey`・選んでいるモデルの表情とボーンなど）。
- 毎フレーム変わる値（再生中のボーンの値）は、描き直しを 0.1 秒に 1 回に間引きます。タイムラインとナビゲーションギズモは、2D の canvas に直接描きます。

## テスト

- `core/*.test.ts` — 純粋な計算
- `engine/**/*.test.ts` — `Clock` 単体と、描画先なしで組み立てた `Engine`（`mount` しなければ WebGL も DOM も使わない）
- `ui/**/*.test.tsx` — 入力の部品 (jsdom)
- `e2e/` — 本物のブラウザで画面を操作する。`?debug` で開くと `window.engine` から中の状態を確かめられる

## 新しい機能を足すとき

1. 計算だけの部分は `core/` に純粋な関数として書き、単体テストを付ける。
2. three.js を使う部分は `engine/` に、使う相手をコンストラクタで受け取るクラスとして書く。毎フレーム動くなら `System` にして `Engine` で `viewport.addSystem` する。
3. ほかの部分に知らせたいことはイベントにして、`Engine` でつなぐ。`Engine` には組み立てとつなぎ、ほかの部分にまたがる短い操作だけを書き、ひとまとまりの機能はサービス (クラス) に分ける。
4. ダウンロードは `engine/io/download.ts`、エラーの文は `core/errors.ts` の `errorText` を使う。
5. 画面に出す状態は `UiState` に足し、部品から `useUi` で読む。入力の部品は `ui/components/controls/` のもの (BSelect・BCheck・NumField・ColorField など) を使い、ブラウザ標準の部品は使わない。
