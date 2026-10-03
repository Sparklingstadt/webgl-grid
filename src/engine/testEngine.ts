import { Engine } from './Engine';

// テスト用: 原点に立方体を 1 つ (id 1) 置いた場面から始めるエンジン (描画なし)。
// アプリは何も置かずに始まるが、物を使うテストは、この立方体を足場にする
export function engineWithCube() {
  const e = new Engine();
  e.world.addShape(0, 0, 0, 0);
  e.history.reset();
  return e;
}
