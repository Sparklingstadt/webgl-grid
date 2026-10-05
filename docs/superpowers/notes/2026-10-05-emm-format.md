# MME のエフェクト割当ファイル (.emm) の書式

第 5 の計画 (割り当ての残り) の Task 8 で、.emm を読み書きする前に確かめた書式。設計書: `docs/superpowers/specs/2026-10-05-mme-assignments-design.md` の「3. .emm の読み書き」。

## 調べた元

MME (MikuMikuEffect) に付いている説明書 (readme) は手元になく、ネットでも本文が見つからなかった。代わりに、MME が書いた本物の .emm を GitHub から 31 個取ってきてバイトを見た (下の「見本」)。書式の説明として、MME の .emm を読み書きする第三者のプログラム (mmd-mcp) の説明とも照らした。

| 元 | 何を確かめたか |
|---|---|
| [trungpq163/MikuMikuDanceE_v932x64](https://github.com/trungpq163/MikuMikuDanceE_v932x64) の `UserFile/Project/**/*.emm`・`UserFile/Effect/rui_cg/ray-mmd-1.5.2/**/*.emm` (24 個。Ray-MMD 1.5.2 の場面。例: [pj_1.emm](https://github.com/trungpq163/MikuMikuDanceE_v932x64/blob/HEAD/UserFile/Project/30-12-19/pj_1.emm)) | 節・キーの形、オフスクリーンの節と `Owner`、`(1)` の付いた節、材質ごとの `[n]` と `.show`、Shift_JIS の日本語のパス、MMD のフォルダからの相対パス |
| [croakfang/UmaMusumeMME Example.emm](https://github.com/croakfang/UmaMusumeMME/blob/HEAD/Example.emm)・[croakfang/GakuenMME ExampleScene.emm](https://github.com/croakfang/GakuenMME/blob/HEAD/ExampleScene.emm) | 材質ごとの割り当て `Pmd1[0] = …`、材質の非表示 `Pmd2[9].show = false`、Windows の絶対パス |
| [primerL/poem_learning_platform …/rapi-ver1.emm](https://github.com/primerL/poem_learning_platform/blob/HEAD/poem-learning-platform/src/assets/model/move/rapi-ver1.emm)・[chsu-SE-2023/krinkin_notes …/a.emm](https://github.com/chsu-SE-2023/krinkin_notes) | 改行が CRLF (この 2 つは git が改行を変えずに入れていた。ほかは LF に変わっていた)、最後に空行 |
| [gitter-badger/vroid …/Tapsi and Lomi dances Queendom.emm](https://github.com/gitter-badger/vroid)・[OKOKOK-OKOKOK/MMD_Ray_projects_controller src/template.emm](https://github.com/OKOKOK-OKOKOK/MMD_Ray_projects_controller) | アクセサリの Main の割り当て `Acs1 = …fx`、物のない .emm |
| [BeamManP/mmd-mcp src/mmd_mcp/effects.py](https://github.com/BeamManP/mmd-mcp/blob/HEAD/src/mmd_mcp/effects.py)・`server.py` (MME の .emm を読み書きする MCP サーバー) | 「Observed MME v3 format: CP932, [Object] maps transient Pmd/Acs IDs to files, [Effect] is Main, and [Effect@<render target>] retains an Owner object ID」。`none` は「効果なし」で非表示ではない、非表示は `.show`。相対パスは .emm でなく MMD のフォルダから。MME ではエフェクト割当の画面の「ファイル → 設定を読む」で読み、.pmm を保存すると隣に同じ名前の .emm を書く設定がある |

## 書式

INI に似た文字のファイル。

| 項目 | 書式 | 見本 |
|---|---|---|
| 文字コード | **Shift_JIS (CP932)**。BOM なし。日本語のパスは 2 バイトの Shift_JIS、半角カナもある。UTF-8 としては読めない | `Pmd7 = UserFile\Stage\樹來\隘路ステージ\…\雑居ビル群_ver1.pmx` |
| 改行 | **CRLF**。節のあとに空行 1 つ、ファイルの最後も空行 (`…\r\n\r\n`) | |
| キーと値 | `キー = 値` (`=` の前後に半角の空白 1 つ)。値は引用符で囲まない。空白を含むパスもそのまま | `Pmd2 = UserFile\…\Sky Hemisphere\Sky with box.fx` |
| `[Info]` | `Version = 3` だけ (31 個とも 3) | `[Info]`<br>`Version = 3` |
| `[Object]` | 物の番号とファイル。`Pmd<n>` はモデル (.pmd・.pmx。アクセサリのフォルダの .pmx も Pmd)、`Acs<n>` はアクセサリ (.x)。**番号は Pmd と Acs で通し** (`Acs1`・`Pmd2`…`Pmd28`・`Acs29`…)。MMD の物の並び。1 から | `Acs1 = UserFile\Effect\rui_cg\ray-mmd-1.5.2\ray.x`<br>`Pmd2 = …\Sky with box.pmx` |
| `[Effect]` | Main のタブ。最初に `Default = none` (31 個ともこの値。意味は確かめられなかった)。そのあと物ごとの割り当て | `Default = none`<br>`Pmd3 = …\Main\main.fx` |
| `[Effect@<名前>]` | オフスクリーン (OFFSCREENRENDERTARGET) のタブ。名前はテクスチャの変数名。最初に `Owner = <物>` (そのオフスクリーンを宣言したエフェクトを当てた物)。オフスクリーンの中で描くエフェクトが宣言したものは `Owner = <物>@<タブ>` | `[Effect@MaterialMap]`<br>`Owner = Acs1`<br>`[Effect@VolumetricMap]`<br>`Owner = Pmd6@FogMap` |
| `[Effect@<名前>(<k>)]` | 同じ名前のオフスクリーンを、別の持ち主がもう 1 つ宣言したもの (2 つめが `(1)`) | `[Effect@ShadowMap(1)]`<br>`Owner = Pmd7@FogMap` |
| `Pmd<n>` / `Acs<n>` | その物全体の .fx のパスか `none` | `Pmd5 = none` |
| `Pmd<n>.show` | その物をそのタブで描くか (`true`・`false`)。`false` は描かない (DefaultEffect の `hide` と同じ)。値の行と一緒にも、`.show` だけでも出る | `Pmd5.show = false`<br>`Acs1.show = false` |
| `Pmd<n>[<k>]` | 材質 (サブセット) k (0 から) の .fx のパスか `none` | `Pmd3[0] = …\skin\Body.fx` |
| `Pmd<n>[<k>].show` | 材質 k をそのタブで描くか | `Pmd2[9].show = false` |
| 値 `none` | 「効果なし」= MMD の普通の描き方 (default.fx)。描かないのではない | |
| 値 `hide` | **見本には一度も出てこない**。描かないことは `.show = false` で書く | |
| パス | `\` 区切り。MMD のフォルダからの相対パス (`UserFile\…`) か、ドライブからの絶対パス (`D:\…`)。大文字小文字はそのまま (同じ .fx が `Materials\` と `materials\` で混ざる)。.fx のほか .fxsub もある | `Pmd2 = UserFile\…\AL_Object.fxsub` |
| 書かないもの | 見本では、アクセサリの Main の割り当てが .x と同じ名前の .fx (MME が自動で読むもの) のときは書かないことが多い (ray.x の ray.fx・AutoLuminous.x)。違う .fx・`none` のときは書く。同じ名前でも書いている見本もある (Falling hearts.x) | |

`Obj[n]` という書き方は見本にも mmd-mcp にもない (設計書の仮の書き方)。

## 読み込み・書き出しで決めたこと

自作の .emm も読むので、読み込みは緩くする。

| # | 決めたこと | 間違っていたときの影響 |
|---|---|---|
| 1 | 文字コード: UTF-8 / UTF-16 の BOM があればそれ、なければ UTF-8 として読めれば UTF-8、読めなければ Shift_JIS (`decodeSource`。.fx と同じ) | なし |
| 2 | 節の名前・キー・`true`/`false`・`none`/`hide` は大文字小文字を無視する。`=` の前後と行の前後の空白、`;`・`#` で始まる行、空行は無視する。値の前後の `"` は外す。キーの物の頭は `Pmd`・`Acs` と `Obj` (自作の .emm 用) | 緩すぎて壊れたファイルを黙って読む (読めない行は警告に数える) |
| 3 | `[Effect@名前(k)]` は `名前` のタブにまとめる (このアプリのタブはオフスクリーンの名前ごとに 1 つ)。同じ物・材質は先の節のものを使う | 持ち主ごとに違う割り当ての 2 つめ以降が効かない |
| 4 | `Owner` と `Default` は読み飛ばす (タブは名前で決まる) | なし |
| 5 | `.show = false` (と値 `hide`) は描かない (`'hide'`)。値 `none` は割り当てなし (`null` = 既定の決め方。Main では default.fx = MME の `none` と同じ。オフスクリーンでは DefaultEffect の規則に戻る)。値のない `.show = true` も割り当てなし | オフスクリーンで、DefaultEffect が .fx を当てる物を MME で `none` (普通の描き方) にしていたものが、規則の .fx になる (このアプリには「オフスクリーンで普通に描く」割り当てがない) |
| 6 | 物の照らし合わせ: `[Object]` のパスのファイル名 (最後の `\`・`/` のあと) を、大文字小文字を無視して、場面の物の名前 (モデルは .pmx のファイル名、MME の物はその名前、ほかは付けた名前) とステージの .pmx のファイル名に合わせる。同じ名前は .emm の番号の順に、場面の並びの順 (ステージは最後) で当てる | フォルダが違う同じ名前の .pmx を取り違える (MMD でも番号の順) |
| 7 | 合った物の割り当ては、.emm のものに置き換える (.emm にないタブ・材質は外す)。.emm にない場面の物はそのまま | なし |
| 8 | 場面にない `.x` は、その名前の仮のアクセサリを置く。場面にない .pmx (コントローラーも) は置かずに警告 (コントローラーは MME の欄の「置く」で置く) | なし |
| 9 | アクセサリの Main に物全体の行がなければ、.x と同じ名前の .fx (パスの拡張子を .fx にしたもの) を探して当てる (MME が自動で読むもの。見本の ray.x)。見つからなくても警告しない (.fx のないアクセサリもあるため) | ray.fx のフォルダを読み込んでいなくても警告が出ない |
| 10 | .fx のパスは、読み込んだフォルダの「フォルダの名前/フォルダの中のパス」と、後ろから区切りごとに大文字小文字を無視して比べ、いちばん多く合うもの (ファイル名は合うこと)。同じ数なら先のフォルダ、フォルダの中では先のファイル | 同じ名前の .fx が別の場所にあるとき、意図と違うほうを当てる |
| 11 | 書き出し: Shift_JIS・CRLF・`キー = 値`・最後に空行。`[Info]` は `Version = 3`。`[Object]` は場面の並びの物 (モデル・MME の物) のあとにステージ。頭は拡張子が `.x`・`.vac` なら `Acs`、ほかは `Pmd` | Shift_JIS で書けない文字は `?` になる |
| 12 | 書き出しのパス: `[Object]` はファイル名だけ (このアプリは .pmx の置き場所を知らない)。.fx は `フォルダの名前\フォルダの中のパス` (`\` 区切り。.fx のフォルダが並ぶ場所に .emm を置く) | MME が `[Object]` をフルパスで照らすなら、MMD では物が合わない (未確認) |
| 13 | 書き出しの `[Effect]` は `Default = none` のあと、全部の物の物全体の行 (割り当てがなければ `none`。アクセサリの .x と同じ名前の .fx の自動の割り当てで読み直したときに増えないように) と材質の行。描かないものは `none` と `.show = false` | なし |
| 14 | 書き出しのオフスクリーンの節は割り当てがあるタブだけ。`Owner` は、そのオフスクリーンを宣言する .fx を Main に当てた最初の物 (なければオフスクリーンのタブに当てた最初の物を `<物>@<タブ>`)。見つからなければ `Owner` を書かない | MME が `Owner` のない節を読み飛ばす (未確認) |
| 15 | `[Info]` の `Version` が 3 でなければ警告して読む | なし |
