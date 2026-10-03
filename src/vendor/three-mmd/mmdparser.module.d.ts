// MMD のファイル (.pmx・.vmd など) のパーサー (型定義がないので、使う分だけ宣言する)
export const MMDParser: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Parser: new () => { parsePmx(buffer: ArrayBuffer, leftToRight: boolean): any; [k: string]: any };
};
