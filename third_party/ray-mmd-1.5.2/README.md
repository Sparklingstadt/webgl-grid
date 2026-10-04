# Ray-MMD 1.5.2（FX コンパイラのテスト用の見本）

MME の .fx を GLSL ES 3.00 に変換するコンパイラ（`src/core/fx/`）が、実際のエフェクトを全部変換できることを確かめるための見本です（`src/core/fx/corpus.test.ts` が読みます）。

- 元の場所: https://github.com/ray-cast/ray-mmd
- タグ: `1.5.2`
- コミット: `a425ab6d4219a047f8d64ac7fdc4f73c76c31dc8`
- 入れたもの: 拡張子が `.fx`（515 個）・`.fxsub`（107 個）・`.conf`（6 個）のファイルと、一番上の `LICENSE.txt`
- フォルダの形・中身（改行コードの CRLF も）は元のまま。手を加えていません（`.gitattributes` で改行コードを変えないようにしています）
- 取り方: `gh api 'repos/ray-cast/ray-mmd/git/trees/1.5.2?recursive=1'` の一覧から拡張子で選び、`https://raw.githubusercontent.com/ray-cast/ray-mmd/<コミット>/<パス>` から取りました
- ライセンス: MIT ライセンス（`LICENSE.txt`）
