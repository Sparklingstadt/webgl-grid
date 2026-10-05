// HLSL の組み込み関数の表とオーバーロードの解決。
import { conversion, matrixOf, vectorOf, type Dim, type Scalar, type Type } from './types.ts';

export type IntrinsicResolution =
  | { ok: true; ret: Type; params: Type[] }
  | { ok: false; reason: 'no-overload' | 'ambiguous' };

// SM3 にない (対応しない) 組み込み関数
export const UNSUPPORTED_INTRINSICS: readonly string[] = ['noise', 'frexp', 'dst'];

interface Overload { params: Type[]; ret: Type }

const FLOAT: Type = { k: 'scalar', s: 'float' };
const BOOL: Type = { k: 'scalar', s: 'bool' };
const VOID: Type = { k: 'void' };
const F3 = vectorOf('float', 3);
const F4 = vectorOf('float', 4);
const SIZES = [1, 2, 3, 4];

// スカラー・ベクトル (n = 1..4)
function vectorShapes(s: Scalar): Type[] {
  return SIZES.map(n => vectorOf(s, n));
}

// スカラー・ベクトル・行列 (T)
function allShapes(s: Scalar): Type[] {
  const shapes = vectorShapes(s);
  for (const r of SIZES) for (const c of SIZES) if (r * c > 1) shapes.push(matrixOf(s, r, c));
  return shapes;
}

// 成分ごとに働く関数: 引数の数・int 版があるか・戻り値 (省略は引数と同じ型)
interface Componentwise { arity: 1 | 2 | 3; ints?: boolean; ret?: 'bool' | 'void' }
const COMPONENTWISE: Record<string, Componentwise> = {
  abs: { arity: 1, ints: true }, acos: { arity: 1 }, asin: { arity: 1 }, atan: { arity: 1 }, atan2: { arity: 2 },
  ceil: { arity: 1 }, clamp: { arity: 3, ints: true }, clip: { arity: 1, ret: 'void' }, cos: { arity: 1 },
  cosh: { arity: 1 }, ddx: { arity: 1 }, ddy: { arity: 1 }, degrees: { arity: 1 }, exp: { arity: 1 },
  exp2: { arity: 1 }, floor: { arity: 1 }, fmod: { arity: 2 }, frac: { arity: 1 }, fwidth: { arity: 1 },
  isfinite: { arity: 1, ret: 'bool' }, isinf: { arity: 1, ret: 'bool' }, isnan: { arity: 1, ret: 'bool' },
  ldexp: { arity: 2 }, lerp: { arity: 3 }, log: { arity: 1 }, log10: { arity: 1 }, log2: { arity: 1 },
  max: { arity: 2, ints: true }, min: { arity: 2, ints: true }, modf: { arity: 2 }, pow: { arity: 2 },
  radians: { arity: 1 }, round: { arity: 1 }, rsqrt: { arity: 1 }, saturate: { arity: 1 },
  sign: { arity: 1, ints: true }, sin: { arity: 1 }, sincos: { arity: 3, ret: 'void' }, sinh: { arity: 1 },
  smoothstep: { arity: 3 }, sqrt: { arity: 1 }, step: { arity: 2 }, tan: { arity: 1 }, tanh: { arity: 1 },
  trunc: { arity: 1 },
};
// modf(x, out ip) と sincos(x, out s, out c) は戻り値が違うだけで、引数は同じ型にそろえる

function componentwise(spec: Componentwise): Overload[] {
  const out: Overload[] = [];
  for (const s of spec.ints ? (['float', 'int'] as const) : (['float'] as const)) {
    for (const t of allShapes(s)) {
      let ret = t;
      if (spec.ret === 'bool') ret = shapeLike(t, 'bool');
      else if (spec.ret === 'void') ret = VOID;
      out.push({ params: Array.from({ length: spec.arity }, () => t), ret });
    }
  }
  return out;
}

function shapeLike(t: Type, s: Scalar): Type {
  if (t.k === 'vector') return vectorOf(s, t.n);
  if (t.k === 'matrix') return matrixOf(s, t.rows, t.cols);
  return { k: 'scalar', s };
}

// ベクトル用: 引数の形 (V = スカラー・ベクトル) と戻り値 ('V' は引数と同じ、'float' はスカラー)
interface VectorFn { params: ('V' | 'float')[]; ret: 'V' | 'float' }
const VECTOR_FNS: Record<string, VectorFn> = {
  distance: { params: ['V', 'V'], ret: 'float' },
  dot: { params: ['V', 'V'], ret: 'float' },
  faceforward: { params: ['V', 'V', 'V'], ret: 'V' },
  length: { params: ['V'], ret: 'float' },
  normalize: { params: ['V'], ret: 'V' },
  reflect: { params: ['V', 'V'], ret: 'V' },
  refract: { params: ['V', 'V', 'float'], ret: 'V' },
};

function vectorFn(spec: VectorFn): Overload[] {
  return vectorShapes('float').map(v => ({
    params: spec.params.map(p => (p === 'V' ? v : FLOAT)),
    ret: spec.ret === 'V' ? v : FLOAT,
  }));
}

// mul: スカラー・ベクトル・行列の積。内側の大きさが合わないときは、大きいほうを小さいほうに切り詰める
function resolveMul(args: Type[]): IntrinsicResolution {
  const none: IntrinsicResolution = { ok: false, reason: 'no-overload' };
  if (args.length !== 2) return none;
  const [a, b] = args;
  const numeric = (t: Type) => t.k === 'scalar' || t.k === 'vector' || t.k === 'matrix';
  if (!numeric(a) || !numeric(b)) return none;
  const fa = shapeLike(a, 'float');
  const fb = shapeLike(b, 'float');
  const done = (params: Type[], ret: Type): IntrinsicResolution => ({ ok: true, ret, params });
  if (a.k === 'scalar') return done([FLOAT, fb], fb);
  if (b.k === 'scalar') return done([fa, FLOAT], fa);
  if (a.k === 'vector' && b.k === 'vector') {
    const v = vectorOf('float', Math.min(a.n, b.n));
    return done([v, v], FLOAT);
  }
  if (a.k === 'vector' && b.k === 'matrix') {
    const k = Math.min(a.n, b.rows);
    return done([vectorOf('float', k), matrixOf('float', k, b.cols)], vectorOf('float', b.cols));
  }
  if (a.k === 'matrix' && b.k === 'vector') {
    const k = Math.min(a.cols, b.n);
    return done([matrixOf('float', a.rows, k), vectorOf('float', k)], vectorOf('float', a.rows));
  }
  if (a.k === 'matrix' && b.k === 'matrix') {
    const k = Math.min(a.cols, b.rows);
    return done([matrixOf('float', a.rows, k), matrixOf('float', k, b.cols)], matrixOf('float', a.rows, b.cols));
  }
  return none;
}

const TEX_DIMS: { base: string; dim: Dim; coord: Type }[] = [
  { base: 'tex1D', dim: '1D', coord: FLOAT },
  { base: 'tex2D', dim: '2D', coord: vectorOf('float', 2) },
  { base: 'tex3D', dim: '3D', coord: F3 },
  { base: 'texCUBE', dim: 'CUBE', coord: F3 },
];

// 2 引数 (座標) と勾配付きの 4 引数は基本の名前、lod / bias / proj は float4 の座標、grad は 4 引数
function textureOverloads(name: string): Overload[] | null {
  for (const { base, dim, coord } of TEX_DIMS) {
    if (!name.startsWith(base)) continue;
    const sampler: Type = { k: 'sampler', dim };
    const suffix = name.slice(base.length);
    if (suffix === '') {
      return [{ params: [sampler, coord], ret: F4 }, { params: [sampler, coord, coord, coord], ret: F4 }];
    }
    if (suffix === 'lod' || suffix === 'bias' || suffix === 'proj') return [{ params: [sampler, F4], ret: F4 }];
    if (suffix === 'grad') return [{ params: [sampler, coord, coord, coord], ret: F4 }];
  }
  return null;
}

function squareMatrices(): Type[] {
  return [2, 3, 4].map(n => matrixOf('float', n, n));
}

// all / any: 成分の種類は引数のまま (比較は 0 かどうかで行う)
function anyAllOverloads(): Overload[] {
  const out: Overload[] = [];
  for (const s of ['bool', 'int', 'float'] as const) for (const t of allShapes(s)) out.push({ params: [t], ret: BOOL });
  return out;
}

function transposeOverloads(): Overload[] {
  const out: Overload[] = [];
  for (const r of SIZES) for (const c of SIZES) if (r * c > 1) out.push({ params: [matrixOf('float', r, c)], ret: matrixOf('float', c, r) });
  return out;
}

// 特別な関数
const SPECIAL: Record<string, () => Overload[]> = {
  cross: () => [{ params: [F3, F3], ret: F3 }],
  all: anyAllOverloads,
  any: anyAllOverloads,
  lit: () => [{ params: [FLOAT, FLOAT, FLOAT], ret: F4 }],
  determinant: () => squareMatrices().map(m => ({ params: [m], ret: FLOAT })),
  transpose: transposeOverloads,
  D3DCOLORtoUBYTE4: () => [{ params: [F4], ret: vectorOf('int', 4) }],
};

function buildOverloads(name: string): Overload[] {
  if (Object.hasOwn(SPECIAL, name)) return SPECIAL[name]();
  if (Object.hasOwn(VECTOR_FNS, name)) return vectorFn(VECTOR_FNS[name]);
  if (Object.hasOwn(COMPONENTWISE, name)) return componentwise(COMPONENTWISE[name]);
  return textureOverloads(name) ?? [];
}

const TEXTURE_SUFFIXES = ['', 'lod', 'bias', 'proj', 'grad'];

// 組み込み関数の名前の一覧 (エミッターが 1 対 1 で対応づける)
export const INTRINSIC_NAMES: readonly string[] = [
  'mul', ...Object.keys(SPECIAL), ...Object.keys(VECTOR_FNS), ...Object.keys(COMPONENTWISE),
  ...TEX_DIMS.flatMap(d => TEXTURE_SUFFIXES.map(s => d.base + s)),
].filter((n, i, all) => all.indexOf(n) === i);

const NAME_SET = new Set(INTRINSIC_NAMES);
const cache = new Map<string, Overload[]>();

function overloadsOf(name: string): Overload[] {
  let list = cache.get(name);
  if (!list) {
    list = buildOverloads(name);
    cache.set(name, list);
  }
  return list;
}

export function isIntrinsic(name: string): boolean {
  return NAME_SET.has(name);
}

function scalarKind(t: Type): Scalar | null {
  return t.k === 'scalar' || t.k === 'vector' || t.k === 'matrix' ? t.s : null;
}

// float を int などに落とす引数の数
function lossyCount(args: Type[], params: Type[]): number {
  let n = 0;
  for (let i = 0; i < args.length; i++) {
    const a = scalarKind(args[i]);
    const p = scalarKind(params[i]);
    if (a === 'float' && p !== null && p !== 'float') n++;
  }
  return n;
}

// 成分の種類の遠さ (同じ 0、整数・bool どうし 1、float との間 2)
function kindDistance(args: Type[], params: Type[]): number {
  let d = 0;
  for (let i = 0; i < args.length; i++) {
    const a = scalarKind(args[i]);
    const p = scalarKind(params[i]);
    if (a === null || p === null || a === p) continue;
    d += a === 'float' || p === 'float' ? 2 : 1;
  }
  return d;
}

// 行列だけを取る関数 (ベクトルは行列に読み替えない)
const MATRIX_ONLY = new Set(['transpose', 'determinant']);

// 候補を (float を落とす引数の数, conversion の cost の合計, 切り詰める引数の数, 成分の種類の遠さ) の順で比べて、
// いちばん小さいものを選ぶ。それでも同点が 2 つ以上なら ambiguous
// (lerp(float, float4, float) は float4 版、abs(uint) は int 版、clamp(int, int, float) は float 版)
export function resolveIntrinsic(name: string, args: Type[]): IntrinsicResolution {
  if (!isIntrinsic(name)) return { ok: false, reason: 'no-overload' };
  if (name === 'mul') return resolveMul(args);
  if (MATRIX_ONLY.has(name) && args.some(a => a.k !== 'matrix')) return { ok: false, reason: 'no-overload' };
  let best: Overload | null = null;
  let bestKey: number[] = [Infinity, 0, 0, 0];
  let tie = false;
  for (const o of overloadsOf(name)) {
    if (o.params.length !== args.length) continue;
    let cost = 0;
    let truncations = 0;
    let ok = true;
    for (let i = 0; i < args.length; i++) {
      const c = conversion(args[i], o.params[i]);
      if (!c) { ok = false; break; }
      cost += c.cost;
      if (c.truncates) truncations++;
    }
    if (!ok) continue;
    const key = [lossyCount(args, o.params), cost, truncations, kindDistance(args, o.params)];
    const order = compareKeys(key, bestKey);
    if (order < 0) {
      best = o; bestKey = key; tie = false;
    } else if (order === 0) {
      tie = true;
    }
  }
  if (!best) return { ok: false, reason: 'no-overload' };
  if (tie) return { ok: false, reason: 'ambiguous' };
  return { ok: true, ret: best.ret, params: best.params };
}

function compareKeys(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}
