// HLSL の型の名前 (float4・float4x3・float2[8] など) の形

// rows × cols はスカラーで 1 × 1、ベクトルで 1 × n。elems は配列の要素の数 (配列でなければ 1)
export interface TypeShape { rows: number; cols: number; matrix: boolean; elems: number; array: boolean }

// 知らない型は null
export function typeShape(type: string): TypeShape | null {
  const m = /^(?:float|half|double|int|uint|bool)([1-4])?(?:x([1-4]))?((?:\[\d+\])*)$/.exec(type);
  if (!m) return null;
  const elems = (m[3].match(/\d+/g) ?? []).reduce((n, x) => n * Number(x), 1);
  const array = m[3] !== '';
  if (m[2]) return { rows: Number(m[1]), cols: Number(m[2]), matrix: true, elems, array };
  return { rows: 1, cols: m[1] ? Number(m[1]) : 1, matrix: false, elems, array };
}
