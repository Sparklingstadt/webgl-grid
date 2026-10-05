# three.js の MMD 用の部品 (r171)

three.js は r172 で MMD 用の部品 (MMDLoader・MMDAnimationHelper・MMDPhysics・MMDToonShader・MMD のパーサー) を本体から外した。
このアプリは .pmx・.vmd を読むのに使うので、外される前の最後の版 (three r171、npm の three@0.171.0) から、ここに取り込んでいる。
MMDAnimationHelper が使う CCDIKSolver も、同じ版のものを一緒に置いている (本体の版が上がっても、IK の動きを変えないため)。

- 元のファイル: `three/examples/jsm/{loaders/MMDLoader, animation/MMDAnimationHelper, animation/MMDPhysics, animation/CCDIKSolver, shaders/MMDToonShader, libs/mmdparser.module}.js`
- 型定義: `@types/three@0.171` の同じ名前の `.d.ts` (mmdparser.module.d.ts だけは、使う分を自分で書いたもの)
- 変えたところ: お互いを読み込む場所 (import のパス) と、「r172 で外される予定」というコンソールの警告 (取り込んだので当てはまらない) を消したことだけ。TGALoader は three 本体のものを使う。mmdparser.module.js だけ、QDEF (PMX 2.1 の頂点の変形 type 4) を BDEF4 と同じ並びで読めるようにした (元は例外で止まる。MMDLoader は頂点の type を見ないので、読み込みの結果は変わらない)
- ライセンス: three.js と同じ MIT (LICENSE)
