// エラーを、お知らせに出せる文にする
export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
