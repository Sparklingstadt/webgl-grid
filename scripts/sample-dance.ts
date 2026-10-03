// --- 試し用のダンス (体・表情・カメラの .vmd と曲の .wav) を作る ---
// models/サンプルダンス/ に書き出す (models/ の中は Git に入らない)。起動したときに読み込むモデルに、これがそのまま付く。
// 標準的な MMD のボーン・表情の名前 (センター・グルーブ・上半身・首・頭・腕・ひじ・まばたき・あ など) を使うので、多くのモデルで動く。
// 120 BPM・32 拍 (16 秒)。使い方: node scripts/sample-dance.ts [書き出す場所]
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { encodeShiftJis } from '../src/core/sjis.ts';

const FPS = 30, BPM = 120, BEATS = 32;
const BEAT = FPS * 60 / BPM; // 1 拍のフレーム数 (15)
const END = BEAT * BEATS;    // 480 フレーム
const out = path.resolve(process.argv[2] ?? 'models/サンプルダンス');

// --- VMD の書き出し ---
class Writer {
  private parts: number[] = [];
  private view = new DataView(new ArrayBuffer(4));
  u8(...vs: number[]) { this.parts.push(...vs); }
  u32(v: number) { this.view.setUint32(0, v, true); this.u8(...new Uint8Array(this.view.buffer)); }
  f32(...vs: number[]) { for (const v of vs) { this.view.setFloat32(0, v, true); this.u8(...new Uint8Array(this.view.buffer)); } }
  text(s: string, size: number) { const b = encodeShiftJis(s); for (let i = 0; i < size; i++) this.u8(b[i] ?? 0); }
  bytes() { return new Uint8Array(this.parts); }
}
interface BoneKey { bone: string; frame: number; pos?: [number, number, number]; rot?: [number, number, number] } // rot はオイラー角 (度、X・Y・Z)
interface MorphKey { name: string; frame: number; weight: number }
interface CameraKey { frame: number; distance: number; target: [number, number, number]; rot: [number, number, number]; fov: number } // rot はラジアン

// 補間: なめらかに出入り (ボーンは X・Y・Z・回転のそれぞれ x1・y1・x2・y2 を 4 つずつ並べる)
const SMOOTH = [64, 0, 64, 127];
const boneCurve = Array.from({ length: 64 }, (_, i) => SMOOTH[Math.floor(i / 4) % 4]);
// カメラ: 6 本の曲線 (X・Y・Z・回転・距離・視野角) を、x1・x2・y1・y2 の順に。ぐるっと回るので直線
const cameraCurve = Array.from({ length: 24 }, (_, i) => [20, 107, 20, 107][i % 4]);

function quat([x, y, z]: [number, number, number]): [number, number, number, number] {
  const r = Math.PI / 180, [cx, sx] = [Math.cos(x * r / 2), Math.sin(x * r / 2)], [cy, sy] = [Math.cos(y * r / 2), Math.sin(y * r / 2)], [cz, sz] = [Math.cos(z * r / 2), Math.sin(z * r / 2)];
  // (Y → X → Z の順に回す)
  return [cy * sx * cz + sy * cx * sz, sy * cx * cz - cy * sx * sz, cy * cx * sz - sy * sx * cz, cy * cx * cz + sy * sx * sz];
}

function vmd(model: string, bones: BoneKey[], morphs: MorphKey[], cameras: CameraKey[] = []) {
  const w = new Writer();
  w.text('Vocaloid Motion Data 0002', 30);
  w.text(model, 20);
  w.u32(bones.length);
  for (const k of bones) {
    w.text(k.bone, 15);
    w.u32(Math.round(k.frame));
    w.f32(...(k.pos ?? [0, 0, 0]));
    w.f32(...quat(k.rot ?? [0, 0, 0]));
    w.u8(...boneCurve);
  }
  w.u32(morphs.length);
  for (const m of morphs) { w.text(m.name, 15); w.u32(Math.round(m.frame)); w.f32(m.weight); }
  w.u32(cameras.length);
  for (const c of cameras) {
    w.u32(c.frame); w.f32(c.distance); w.f32(...c.target); w.f32(...c.rot);
    w.u8(...cameraCurve); w.u32(c.fov); w.u8(0);
  }
  w.u32(0); // 照明
  w.u32(0); // セルフ影
  return w.bytes();
}

// --- 体の動き: 拍に合わせて沈み、左右に揺れ、8 拍ごとに腕の振りを変える ---
function body(): BoneKey[] {
  const keys: BoneKey[] = [];
  for (let b = 0; b <= BEATS; b++) {
    const f = b * BEAT, half = f + BEAT / 2, side = b % 2 ? -1 : 1, part = Math.floor(b / 8) % 4;
    // 沈む (拍の頭) → 戻る (裏拍)。足は IK で床に残るので、ひざが曲がる
    keys.push({ bone: 'グルーブ', frame: f, pos: [0, -0.9, 0] });
    if (b < BEATS) keys.push({ bone: 'グルーブ', frame: half, pos: [0, 0, 0] });
    // 2 拍ごとに左右へ
    keys.push({ bone: 'センター', frame: f, pos: [(b % 4 < 2 ? 1 : -1) * 0.8, 0, 0] });
    keys.push({ bone: '上半身', frame: f, rot: [4, side * 12, side * 4] });
    keys.push({ bone: '下半身', frame: f, rot: [0, -side * 8, 0] });
    keys.push({ bone: '首', frame: f, rot: [6, side * 6, 0] });
    keys.push({ bone: '頭', frame: f, rot: [8, 0, -side * 6] });
    if (b < BEATS) keys.push({ bone: '頭', frame: half, rot: [-2, 0, 0] });
    // 腕: 0 振る、1 上で手を振る、2 前で手をたたく、3 交互に上へ。
    // (左腕は Z を足すと上がり、Y を足すと前へ。左ひじは Y を足すと前へ曲がる。右は左右反対)
    const arms: Record<number, [BoneKey['rot'], BoneKey['rot'], BoneKey['rot'], BoneKey['rot']]> = {
      0: [[0, side * 25, 10], [0, side * 25, -10], [0, 40, 0], [0, -40, 0]],
      1: [[0, 10, 100 + side * 15], [0, -10, -100 + side * 15], [0, 0, 20], [0, 0, -20]],
      2: [[0, side > 0 ? 55 : 35, -5], [0, side > 0 ? -55 : -35, 5], [0, side > 0 ? 85 : 60, 0], [0, side > 0 ? -85 : -60, 0]],
      3: [[0, 10, side > 0 ? 110 : 0], [0, -10, side > 0 ? 0 : -110], [0, 15, 0], [0, -15, 0]],
    };
    const [la, ra, le, re] = arms[part];
    keys.push({ bone: '左腕', frame: f, rot: la }, { bone: '右腕', frame: f, rot: ra }, { bone: '左ひじ', frame: f, rot: le }, { bone: '右ひじ', frame: f, rot: re });
  }
  return keys;
}

// --- 表情: にこっとして、ときどきまばたき。後半は拍に合わせて口を開ける ---
function face(): MorphKey[] {
  const keys: MorphKey[] = [{ name: 'にこり', frame: 0, weight: 0.6 }, { name: 'にこり', frame: END, weight: 0.6 }];
  for (const f of [40, 130, 205, 300, 352, 430]) keys.push({ name: 'まばたき', frame: f - 2, weight: 0 }, { name: 'まばたき', frame: f, weight: 1 }, { name: 'まばたき', frame: f + 3, weight: 0 });
  const vowels = ['あ', 'い', 'う', 'え', 'お'];
  for (let b = 16; b < BEATS; b++) {
    const v = vowels[b % vowels.length], f = b * BEAT;
    keys.push({ name: v, frame: f, weight: 0 }, { name: v, frame: f + 3, weight: 0.8 }, { name: v, frame: f + BEAT - 2, weight: 0 });
  }
  return keys;
}

// --- カメラ: 正面から始めて、ゆっくり 1 周する ---
function camera(): CameraKey[] {
  const keys: CameraKey[] = [];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8, f = Math.round(t * END);
    keys.push({ frame: f, distance: -55 + 8 * Math.sin(t * Math.PI * 2), target: [0, 10, 0], rot: [0.1, t * Math.PI * 2, 0], fov: 30 });
  }
  return keys;
}

// --- 曲: 120 BPM の 4 つ打ち・ハイハット・ベース・アルペジオ (C - G - Am - F) ---
function song(): Uint8Array {
  const rate = 22050, secs = BEATS * 60 / BPM + 0.5, n = Math.round(rate * secs), beat = 60 / BPM;
  const data = new Float32Array(n);
  const chords = [[60, 64, 67], [55, 59, 62], [57, 60, 64], [53, 57, 60]]; // C・G・Am・F (MIDI の番号)
  const hz = (note: number) => 440 * 2 ** ((note - 69) / 12);
  const add = (start: number, len: number, fn: (t: number) => number) => {
    const s = Math.round(start * rate);
    for (let i = 0; i < len * rate && s + i < n; i++) data[s + i] += fn(i / rate);
  };
  let seed = 1;
  const noise = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (let b = 0; b < BEATS; b++) {
    const t0 = b * beat, chord = chords[Math.floor(b / 8) % 4];
    // キック: 低く沈む音
    add(t0, 0.25, t => Math.sin(2 * Math.PI * (45 * t + 60 * (1 - Math.exp(-t * 30)) / 30)) * Math.exp(-t * 12) * 0.9);
    // ハイハット: 裏拍
    add(t0 + beat / 2, 0.06, t => noise() * Math.exp(-t * 60) * 0.25);
    // ベース: 和音の根音を、拍ごとに
    add(t0, beat * 0.9, t => Math.sin(2 * Math.PI * hz(chord[0] - 24) * t) * Math.min(1, t * 80) * Math.exp(-t * 3) * 0.35);
    // アルペジオ: 8 分音符で和音をなぞる
    for (let k = 0; k < 2; k++) {
      const note = chord[(b * 2 + k) % 3] + 12;
      add(t0 + k * beat / 2, beat / 2, t => {
        const p = 2 * Math.PI * hz(note) * t;
        return (Math.sin(p) + 0.3 * Math.sin(2 * p)) * Math.min(1, t * 200) * Math.exp(-t * 6) * 0.18;
      });
    }
  }
  const peak = data.reduce((m, v) => Math.max(m, Math.abs(v)), 0) || 1;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, data[i] / peak * 0.85)) * 32767), 44 + i * 2);
  return new Uint8Array(buf);
}

await mkdir(out, { recursive: true });
await writeFile(path.join(out, '体.vmd'), vmd('サンプル', body(), []));
await writeFile(path.join(out, '表情.vmd'), vmd('サンプル', [], face()));
await writeFile(path.join(out, 'カメラ.vmd'), vmd('カメラ・照明', [], [], camera()));
await writeFile(path.join(out, '曲.wav'), song());
console.log(`${out} に 体.vmd・表情.vmd・カメラ.vmd・曲.wav を書き出しました (${BPM} BPM・${BEATS} 拍)`);
