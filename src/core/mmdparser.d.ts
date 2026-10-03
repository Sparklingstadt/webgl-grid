// three.js の付属の MMD パーサー (型定義がないので、テストで使う分だけ宣言する)
declare module 'three/examples/jsm/libs/mmdparser.module.js' {
  export const MMDParser: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Parser: new () => { parsePmx(buffer: ArrayBuffer, leftToRight: boolean): any };
  };
}
