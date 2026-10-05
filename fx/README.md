# fx/ — MME のエフェクト置き場

手持ちの MME のエフェクト（.fx とそれが読むファイル）を、エフェクトの一式ごとのフォルダにして置く場所です。
アプリの MME 互換モード（プロパティの「出力」のタブで「レンダーエンジン」を「MME 互換」にする）は、これを GLSL ES 3.00 に変換して使います。「効果」のタブの「MME 互換」の欄で、.fx が入っているフォルダを選んで読み込みます（`fx/` の一覧から選ぶ画面は、まだありません）。

置いたエフェクトが変換できるかは、`npm run fx:check` で確かめられます。.fx 1 つずつの結果（`成功` か、最初の誤りの種類）・誤りの場所（`ファイル:行`）・変換にかかった時間を表にして出します。
`#include` は、そのエフェクトのフォルダの中から探します（ファイル名の大文字・小文字は区別しません）。

```
fx/
  マイエフェクト/
    effect.fx
    effect.fxsub   … #include されるファイル
    Textures/      … テクスチャ
  単体のエフェクト.fx   … fx/ の直下のファイルは、fx/ がフォルダの代わり
```

見本として、Ray-MMD 1.5.2 の .fx 全部を `third_party/ray-mmd-1.5.2/` に入れています（MIT ライセンス。単体テストと `npm run fx:check` で全部変換できることを確かめます）。

## Ray-MMD 1.5.2 を置く

`third_party/` にあるのは文字のファイル（.fx・.fxsub・.conf）だけです。モデル（.pmx）・画像（.dds・.png など）も含めた Ray-MMD 全体は、ここに置きます。

```
fx/
  ray-mmd-1.5.2/      … GitHub の ray-cast/ray-mmd のタグ 1.5.2 をそのまま (ray.fx・ray.conf・Lighting/・Fog/・Skybox/・Materials/・Shader/ …)
```

- 取ってくるには、たとえば `git clone --depth 1 --branch 1.5.2 https://github.com/ray-cast/ray-mmd.git fx/ray-mmd-1.5.2` のあと `fx/ray-mmd-1.5.2/.git` を消します（約 88 MB）。
- アプリでは、「効果」のタブの「MME 互換」の欄で、このフォルダごと選びます（使い方は README の「Ray-MMD を使う」）。
- 置くと、手元だけの e2e `npx playwright test e2e/ray-mmd-local.spec.ts` が動きます（置いていなければ飛ばします）。描いた絵は `test-results/ray-mmd/` に保存されます。
- `npm run ray:survey` は、ここにある .dds の形式と、Ray-MMD の .fx が宣言するレンダーターゲットの形式を調べて、`docs/superpowers/notes/2026-10-05-ray-mmd-survey.md` に書きます。

**このフォルダの中身は Git に入りません**（`.gitignore` で、この README 以外を除いています）。
エフェクトの多くは規約で再配布が禁じられているので、リポジトリに入れたり公開したりしないでください。
