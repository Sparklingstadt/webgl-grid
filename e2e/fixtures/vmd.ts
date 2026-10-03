import { encodeShiftJis } from '../../src/core/sjis';

// e2e テスト用の小さな VMD モーションを組み立てる。
// keys は、ボーン名・フレーム・位置 (MMD の座標)。回転はなし、補間は直線
export function makeVmd(keys: { bone: string; frame: number; pos: [number, number, number] }[]): Uint8Array {
  const bytes: number[] = [];
  const view = new DataView(new ArrayBuffer(4));
  const u32 = (v: number) => { view.setUint32(0, v, true); bytes.push(...new Uint8Array(view.buffer)); };
  const f32 = (...vs: number[]) => { for (const v of vs) { view.setFloat32(0, v, true); bytes.push(...new Uint8Array(view.buffer)); } };
  const fixed = (data: Uint8Array, size: number) => { for (let i = 0; i < size; i++) bytes.push(data[i] ?? 0); };
  fixed(new TextEncoder().encode('Vocaloid Motion Data 0002'), 30);
  fixed(encodeShiftJis('テスト'), 20);
  u32(keys.length);
  // 補間曲線 (x1, y1, x2, y2 を X・Y・Z・回転の順に並べたもの) は、直線になる (20, 20, 107, 107)
  const linear = Array.from({ length: 64 }, (_, i) => [20, 20, 107, 107][Math.floor(i / 4) % 4]);
  for (const k of keys) {
    fixed(encodeShiftJis(k.bone), 15);
    u32(k.frame);
    f32(...k.pos);
    f32(0, 0, 0, 1);
    bytes.push(...linear);
  }
  u32(0); // 表情
  u32(0); // カメラ
  u32(0); // 照明
  u32(0); // セルフ影
  return new Uint8Array(bytes);
}
