// --- サウンド・エフェクタの音の大きさ: 曲を一度だけ読んで、時刻ごと・周波数の帯ごとの大きさ (0〜1) を出す ---
// 1/30 秒ごとに 1024 点の FFT をかけ、40 Hz〜16 kHz を対数で BANDS 個の帯に分ける。帯ごとに一番大きいところを 1 にする。
// 時刻で決まるので、再生中も動画のレンダリングでも同じ値になる
export const BANDS = 16;
const RATE = 30, N = 1024;

export interface SoundLevels { rate: number; frames: number; data: Float32Array; overall: Float32Array }

// 実数の FFT (大きさだけ)。re・im は書き換える
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci, vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
      }
    }
  }
}

// 音 (モノラル) から、時刻ごと・帯ごとの大きさを作る
export function analyze(samples: Float32Array, sampleRate: number): SoundLevels {
  const frames = Math.max(Math.ceil(samples.length / sampleRate * RATE), 1);
  const data = new Float32Array(frames * BANDS), overall = new Float32Array(frames);
  const re = new Float64Array(N), im = new Float64Array(N);
  // 帯の境 (FFT の番号)
  const edges = Array.from({ length: BANDS + 1 }, (_, b) => Math.min(Math.max(Math.round(40 * Math.pow(16000 / 40, b / BANDS) / sampleRate * N), 1), N / 2));
  for (let f = 0; f < frames; f++) {
    const start = Math.floor(f / RATE * sampleRate) - N / 2;
    let rms = 0;
    for (let i = 0; i < N; i++) {
      const s = samples[start + i] ?? 0, w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)); // ハン窓
      re[i] = s * w; im[i] = 0;
      rms += s * s;
    }
    overall[f] = Math.sqrt(rms / N);
    fft(re, im);
    for (let b = 0; b < BANDS; b++) {
      let sum = 0;
      const lo = edges[b], hi = Math.max(edges[b + 1], lo + 1);
      for (let k = lo; k < hi; k++) sum += Math.hypot(re[k], im[k]);
      data[f * BANDS + b] = sum / (hi - lo);
    }
  }
  // 帯ごと (と全体) に、一番大きいところを 1 にする
  for (let b = 0; b < BANDS; b++) {
    let max = 0;
    for (let f = 0; f < frames; f++) max = Math.max(max, data[f * BANDS + b]);
    if (max > 0) for (let f = 0; f < frames; f++) data[f * BANDS + b] /= max;
  }
  const om = overall.reduce((m, v) => Math.max(m, v), 0);
  if (om > 0) for (let f = 0; f < frames; f++) overall[f] /= om;
  return { rate: RATE, frames, data, overall };
}

// 時刻 t (秒) の大きさ。band を省くと全体 (帯は 0〜BANDS-1)
export function levelAt(s: SoundLevels | null, t: number, band?: number) {
  if (!s) return 0;
  const x = Math.min(Math.max(t * s.rate, 0), s.frames - 1), f = Math.floor(x), g = Math.min(f + 1, s.frames - 1), u = x - f;
  const at = (k: number) => (band === undefined ? s.overall[k] : s.data[k * BANDS + band]);
  return at(f) * (1 - u) + at(g) * u;
}

// 曲のファイルを読んで (デコードして)、大きさを作る。読めなければ null
export async function analyzeFile(file: File): Promise<SoundLevels | null> {
  const Ctx = (globalThis as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
  if (!Ctx) return null;
  try {
    const buf = await new Ctx(1, 1, 44100).decodeAudioData(await file.arrayBuffer());
    const mono = new Float32Array(buf.length);
    for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) mono[i] += d[i] / buf.numberOfChannels; }
    return analyze(mono, buf.sampleRate);
  } catch (err) {
    console.error(err);
    return null;
  }
}
