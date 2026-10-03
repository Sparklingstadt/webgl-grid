// タイムラインの見た目の計算 (目盛りの間隔・拡大縮小・位置とフレームの変換)

// 見えている範囲 (フレーム)
export interface TlView { f0: number; f1: number }

// 目盛りの数字の間隔: 隣どうしが minPx 以上離れる、きりのいい間隔 (1・2・5 の 10 倍ずつ)
export function rulerStep(pxPerFrame: number, minPx = 50) {
  for (let base = 1; base < 1e7; base *= 10) {
    for (const m of [1, 2, 5]) if (base * m * pxPerFrame >= minPx) return base * m;
  }
  return 1e7;
}

// 開始〜終了が少し余白付きでちょうど入る範囲
export function fitView(start: number, end: number): TlView {
  const pad = Math.max((end - start) * 0.04, 2);
  return { f0: start - pad, f1: end + pad };
}

// at (フレーム) を中心に factor 倍に広げる (1 より小さければ拡大)。幅は 10〜100000 フレームに収める
export function zoomView(v: TlView, at: number, factor: number): TlView {
  const span = v.f1 - v.f0;
  const ns = Math.min(Math.max(span * factor, 10), 100000);
  const f0 = at - (at - v.f0) * ns / span;
  return { f0, f1: f0 + ns };
}

// 幅 width の中の位置 x にあるフレーム (整数)
export const frameAt = (v: TlView, x: number, width: number) => Math.round(v.f0 + x / width * (v.f1 - v.f0));
