// --- クローナー (Cinema 4D のクローナー): 物を直線・放射・グリッドに並べる ---
// 並べる場所は、元の物 (クローナー) の位置と向きから見た座標。元の物を動かす・回すと、クローンも一緒に動く
export type ClonerMode = 'linear' | 'radial' | 'grid';
export type Vec3 = [number, number, number];
export interface ClonerSettings {
  mode: ClonerMode;
  count: number;          // 直線・放射の数
  step: Vec3;             // 直線: 1 つごとのずれ
  stepRotDeg: number;     // 直線: 1 つごとの、縦軸まわりの回転 (度)
  radius: number;         // 放射: 半径
  startDeg: number;       // 放射: 並べる角度の範囲 (0° が奥 (+Z)、90° が右 (+X))
  endDeg: number;
  align: boolean;         // 放射: 外を向く
  grid: Vec3;             // グリッド: X・Y・Z の数
  spacing: Vec3;          // グリッド: 間隔
  random: { position: number; rotationDeg: number; seed: number }; // ばらつき (Cinema 4D のランダム・エフェクタ)
}
// クローン 1 つの置き場所 (元の物から見た位置と、縦軸まわりの回転 (ラジアン))
export interface Placement { x: number; y: number; z: number; ry: number }

export const CLONER_MODES: { key: ClonerMode; name: string }[] = [
  { key: 'linear', name: '直線' }, { key: 'radial', name: '放射' }, { key: 'grid', name: 'グリッド' },
];
export const CLONER_DEFAULT: ClonerSettings = {
  mode: 'grid', count: 5, step: [1.5, 0, 0], stepRotDeg: 0,
  radius: 3, startDeg: 0, endDeg: 360, align: true,
  grid: [3, 1, 3], spacing: [1.5, 1.2, 1.5],
  random: { position: 0, rotationDeg: 0, seed: 1 },
};
// 数の上限 (MMD モデルは 1 つずつ骨を動かして描くので少なめ)
export const MAX_CLONES = { shape: 400, model: 25 };

const int = (v: number, lo: number, hi: number) => Math.min(Math.max(Math.round(Number.isFinite(v) ? v : lo), lo), hi);
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const vec = (v: unknown, d: Vec3): Vec3 => (Array.isArray(v) ? d.map((x, i) => num(v[i], x)) as Vec3 : [...d]);

// 保存されていた・外から渡された設定を、使える値にそろえる
export function normalizeCloner(s: Partial<ClonerSettings> | undefined): ClonerSettings {
  const d = CLONER_DEFAULT, o = s ?? {};
  const r: Partial<ClonerSettings['random']> = o.random ?? {};
  return {
    mode: CLONER_MODES.some(m => m.key === o.mode) ? o.mode! : d.mode,
    count: int(num(o.count, d.count), 1, MAX_CLONES.shape),
    step: vec(o.step, d.step), stepRotDeg: num(o.stepRotDeg, d.stepRotDeg),
    radius: Math.max(num(o.radius, d.radius), 0), startDeg: num(o.startDeg, d.startDeg), endDeg: num(o.endDeg, d.endDeg),
    align: typeof o.align === 'boolean' ? o.align : d.align,
    grid: vec(o.grid, d.grid).map(n => int(n, 1, 50)) as Vec3, spacing: vec(o.spacing, d.spacing),
    random: { position: Math.max(num(r.position, 0), 0), rotationDeg: Math.max(num(r.rotationDeg, 0), 0), seed: int(num(r.seed, 1), 0, 1e9) },
  };
}

// クローンの数 (並べ方の設定から。上限で切る)
export function cloneCount(s: ClonerSettings, max: number) {
  const n = s.mode === 'grid' ? s.grid[0] * s.grid[1] * s.grid[2] : s.count;
  return Math.min(n, max);
}

// 同じシードなら同じばらつきになる乱数 (mulberry32)
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// クローンの置き場所。max 個まで
export function clonerLayout(s: ClonerSettings, max: number): Placement[] {
  const out: Placement[] = [];
  const D = Math.PI / 180;
  if (s.mode === 'linear') {
    for (let i = 0; i < s.count && out.length < max; i++) out.push({ x: s.step[0] * i, y: s.step[1] * i, z: s.step[2] * i, ry: s.stepRotDeg * D * i });
  } else if (s.mode === 'radial') {
    const span = s.endDeg - s.startDeg;
    // 一周なら端と端が重ならないよう count 等分、そうでなければ両端を含めて並べる
    const full = Math.abs(Math.abs(span) - 360) < 1e-6;
    const d = s.count > 1 ? span / (full ? s.count : s.count - 1) : 0;
    for (let i = 0; i < s.count && out.length < max; i++) {
      const a = (s.startDeg + d * i) * D;
      out.push({ x: Math.sin(a) * s.radius, y: 0, z: Math.cos(a) * s.radius, ry: s.align ? a : 0 });
    }
  } else {
    // グリッド: 横 (X・Z) は元の物を真ん中に、縦 (Y) は地面から上へ
    const [nx, ny, nz] = s.grid, [sx, sy, sz] = s.spacing;
    for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
      if (out.length >= max) break;
      out.push({ x: (i - (nx - 1) / 2) * sx, y: j * sy, z: (k - (nz - 1) / 2) * sz, ry: 0 });
    }
  }
  const { position, rotationDeg, seed } = s.random;
  if (position || rotationDeg) {
    const rnd = random(seed);
    for (const p of out) {
      p.x += (rnd() * 2 - 1) * position;
      p.z += (rnd() * 2 - 1) * position;
      p.ry += (rnd() * 2 - 1) * rotationDeg * D;
    }
  }
  return out;
}
