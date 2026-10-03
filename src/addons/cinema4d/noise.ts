// --- ノイズ (MoGraph のシェーダー・フィールドで使う): 場所でなめらかに変わる 0〜1 の値 ---
// 格子の点ごとの乱数を、なめらかにつなぐ (バリューノイズ)。octaves 回、細かくして重ねる
function hash(x: number, y: number, z: number, seed: number) {
  let h = Math.imul(x, 0x8da6b343) ^ Math.imul(y, 0xd8163841) ^ Math.imul(z, 0xcb1ab31f) ^ Math.imul(seed, 0x165667b1);
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function value3(x: number, y: number, z: number, seed: number) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const u = fade(x - xi), v = fade(y - yi), w = fade(z - zi);
  const c = (dx: number, dy: number, dz: number) => hash(xi + dx, yi + dy, zi + dz, seed);
  return lerp(
    lerp(lerp(c(0, 0, 0), c(1, 0, 0), u), lerp(c(0, 1, 0), c(1, 1, 0), u), v),
    lerp(lerp(c(0, 0, 1), c(1, 0, 1), u), lerp(c(0, 1, 1), c(1, 1, 1), u), v),
    w,
  );
}
// 0〜1 のノイズ
export function noise3(x: number, y: number, z: number, seed = 0, octaves = 3) {
  let sum = 0, amp = 1, total = 0, f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += value3(x * f, y * f, z * f, seed + i * 101) * amp;
    total += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / total;
}
