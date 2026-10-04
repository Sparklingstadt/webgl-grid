// 定数の計算。型チェック済みの式 (convert・access の入ったもの) と、
// 型チェックしていない式 (pass のステートの値) のどちらも計算できるよう、型は値から求める。
import type { Expr, TypeRef } from './ast.ts';
import { resolveIntrinsic } from './intrinsics.ts';
import { arithmeticScalar, binaryResultType, componentCount, scalarKind, vectorOf, withScalar, type Scalar, type Type } from './types.ts';

// num の values は成分を並べたもの。行列は HLSL の行ごと (1 行目の C 個、2 行目 …)。bool は 0 / 1
export type ConstValue = { kind: 'num'; type: Type; values: number[] } | { kind: 'str'; value: string };
type Num = Extract<ConstValue, { kind: 'num' }>;

export interface ConstEnv {
  global(name: string): ConstValue | null; // const と static (値のあるもの) のグローバル変数の値
  resolveType(ref: TypeRef): Type | null;
}

const num = (v: ConstValue | null): Num | null => (v?.kind === 'num' ? v : null);

function castScalar(x: number, s: Scalar): number {
  switch (s) {
    case 'float': return x;
    case 'int': return Math.trunc(x);
    case 'uint': return Math.trunc(x) >>> 0;
    case 'bool': return x !== 0 ? 1 : 0;
  }
}

// 値を型 to に変換する (広げる・切り詰める・同じ数の並べ替え・成分の種類)。できなければ null
export function convertConst(v: Num, to: Type): Num | null {
  const s = scalarKind(to);
  const from = v.type;
  if (s === null || scalarKind(from) === null) return to.k === 'array' && from.k === 'array' && componentCount(to) === v.values.length ? v : null;
  const m = componentCount(to);
  let values: number[];
  if (from.k === 'scalar') values = Array.from({ length: m }, () => v.values[0]);
  else if (from.k === 'matrix' && to.k === 'matrix') {
    if (to.rows > from.rows || to.cols > from.cols) return null;
    values = [];
    for (let r = 0; r < to.rows; r++) for (let c = 0; c < to.cols; c++) values.push(v.values[r * from.cols + c]);
  } else if (m <= v.values.length) values = v.values.slice(0, m);
  else return null;
  return { kind: 'num', type: to, values: values.map(x => castScalar(x, s)) };
}

// 型 shape の大きさにそろえる (スカラーは広げる)
function fit(v: Num, shape: Type, s: Scalar): number[] | null {
  if (v.type.k === 'scalar') return Array.from({ length: componentCount(shape) }, () => castScalar(v.values[0], s));
  return convertConst(v, withScalar(shape, s))?.values ?? null;
}

const BITWISE = new Set(['|', '&', '^', '<<', '>>']);
const ARITHMETIC = new Set(['+', '-', '*', '/', '%']);

function evalBinary(op: string, a: Num, b: Num): Num | null {
  const ka = scalarKind(a.type);
  const kb = scalarKind(b.type);
  if (ka === null || kb === null) return null;
  if (BITWISE.has(op)) {
    // ステートの RED | GREEN など。整数だけ
    if (ka === 'float' || kb === 'float') return null;
    const r = binaryResultType('+', a.type, b.type);
    if (!r) return null;
    const type = withScalar(r.type, 'int');
    const x = fit(a, type, 'int');
    const y = fit(b, type, 'int');
    if (!x || !y) return null;
    const f = { '|': (p: number, q: number) => p | q, '&': (p: number, q: number) => p & q, '^': (p: number, q: number) => p ^ q,
      '<<': (p: number, q: number) => p << q, '>>': (p: number, q: number) => p >> q }[op as '|'];
    return { kind: 'num', type, values: x.map((p, i) => f(p, y[i])) };
  }
  const r = binaryResultType(op, a.type, b.type);
  if (!r) return null;
  let s: Scalar;
  if (ARITHMETIC.has(op)) s = scalarKindOf(r.type);
  else if (op === '&&' || op === '||') s = 'bool';
  else s = ka === 'bool' && kb === 'bool' ? 'bool' : arithmeticScalar(ka, kb);
  const x = fit(a, r.type, s);
  const y = fit(b, r.type, s);
  if (!x || !y) return null;
  const isInt = s !== 'float';
  const values: number[] = [];
  for (let i = 0; i < x.length; i++) {
    const p = x[i];
    const q = y[i];
    let v: number;
    switch (op) {
      case '+': v = p + q; break;
      case '-': v = p - q; break;
      case '*': v = p * q; break;
      case '/': if (isInt && q === 0) return null; v = isInt ? Math.trunc(p / q) : p / q; break;
      case '%': if (q === 0) return null; v = p % q; break; // JS の % は fmod と同じく被除数の符号
      case '<': v = Number(p < q); break;
      case '>': v = Number(p > q); break;
      case '<=': v = Number(p <= q); break;
      case '>=': v = Number(p >= q); break;
      case '==': v = Number(p === q); break;
      case '!=': v = Number(p !== q); break;
      case '&&': v = Number(p !== 0 && q !== 0); break;
      case '||': v = Number(p !== 0 || q !== 0); break;
      default: return null;
    }
    values.push(ARITHMETIC.has(op) ? castScalar(v, scalarKindOf(r.type)) : v);
  }
  return { kind: 'num', type: r.type, values };
}

function scalarKindOf(t: Type): Scalar {
  return scalarKind(t) ?? 'float';
}

const UNARY_FNS: Record<string, (x: number) => number> = {
  abs: Math.abs, saturate: x => Math.min(1, Math.max(0, x)), sqrt: Math.sqrt, floor: Math.floor, ceil: Math.ceil,
  frac: x => x - Math.floor(x), sin: Math.sin, cos: Math.cos, tan: Math.tan, exp: Math.exp, exp2: x => 2 ** x,
  log: Math.log, log2: Math.log2,
};
const BINARY_FNS: Record<string, (x: number, y: number) => number> = { min: Math.min, max: Math.max, pow: (x, y) => x ** y };
const VECTOR_FNS = new Set(['lerp', 'normalize', 'length', 'dot']);

function evalIntrinsic(name: string, args: Num[]): Num | null {
  if (!Object.hasOwn(UNARY_FNS, name) && !Object.hasOwn(BINARY_FNS, name) && !VECTOR_FNS.has(name)) return null;
  const res = resolveIntrinsic(name, args.map(a => a.type));
  if (!res.ok) return null;
  const xs: number[][] = [];
  for (let i = 0; i < args.length; i++) {
    const c = convertConst(args[i], res.params[i]);
    if (!c) return null;
    xs.push(c.values);
  }
  const sumSq = (v: number[]) => v.reduce((s, x) => s + x * x, 0);
  let values: number[];
  if (Object.hasOwn(UNARY_FNS, name)) values = xs[0].map(UNARY_FNS[name]);
  else if (Object.hasOwn(BINARY_FNS, name)) values = xs[0].map((x, i) => BINARY_FNS[name](x, xs[1][i]));
  else if (name === 'lerp') values = xs[0].map((x, i) => x + (xs[1][i] - x) * xs[2][i]);
  else if (name === 'dot') values = [xs[0].reduce((s, x, i) => s + x * xs[1][i], 0)];
  else if (name === 'length') values = [Math.sqrt(sumSq(xs[0]))];
  else {
    const len = Math.sqrt(sumSq(xs[0]));
    values = xs[0].map(x => x / len);
  }
  if (values.some(Number.isNaN)) return null;
  const s = scalarKindOf(res.ret);
  return { kind: 'num', type: res.ret, values: values.map(x => castScalar(x, s)) };
}

// 添字で取り出す (配列の要素・ベクトルの成分・行列の行)
function evalIndex(v: Num, i: number): Num | null {
  const t = v.type;
  let size: number;
  let elem: Type;
  if (t.k === 'array') { size = t.length; elem = t.of; }
  else if (t.k === 'vector') { size = t.n; elem = { k: 'scalar', s: t.s }; }
  else if (t.k === 'matrix') { size = t.rows; elem = vectorOf(t.s, t.cols); }
  else return null;
  if (!Number.isInteger(i) || i < 0 || i >= size) return null;
  const n = componentCount(elem);
  if (n === 0) return null;
  return { kind: 'num', type: elem, values: v.values.slice(i * n, (i + 1) * n) };
}

export function evalConst(e: Expr, env: ConstEnv): ConstValue | null {
  const ev = (x: Expr) => num(evalConst(x, env));
  switch (e.kind) {
    case 'number': return { kind: 'num', type: { k: 'scalar', s: e.isFloat ? 'float' : 'int' }, values: [e.value] };
    case 'bool': return { kind: 'num', type: { k: 'scalar', s: 'bool' }, values: [e.value ? 1 : 0] };
    case 'string': return { kind: 'str', value: e.value };
    case 'ident':
      if (e.sym) return e.sym.kind === 'global' ? env.global(e.sym.name) : null;
      return env.global(e.name);
    case 'convert': {
      const v = ev(e.value);
      return v && convertConst(v, e.to);
    }
    case 'cast': {
      const v = ev(e.value);
      const to = env.resolveType(e.typeRef);
      return v && to && convertConst(v, to);
    }
    case 'construct': {
      const to = env.resolveType(e.typeRef);
      const s = to && scalarKind(to);
      if (!to || !s) return null;
      const vals: number[] = [];
      for (const a of e.args) {
        const v = ev(a);
        if (!v) return null;
        vals.push(...v.values.map(x => castScalar(x, s)));
      }
      const n = componentCount(to);
      if (vals.length === 1 && n > 1) return { kind: 'num', type: to, values: Array.from({ length: n }, () => vals[0]) };
      return vals.length === n ? { kind: 'num', type: to, values: vals } : null;
    }
    case 'unary': {
      const v = ev(e.operand);
      const s = v && scalarKind(v.type);
      if (!v || !s) return null;
      switch (e.op) {
        case '+': return v;
        case '-': {
          const k = s === 'bool' ? 'int' : s;
          return { kind: 'num', type: withScalar(v.type, k), values: v.values.map(x => castScalar(-x, k)) };
        }
        case '!': return { kind: 'num', type: withScalar(v.type, 'bool'), values: v.values.map(x => (x === 0 ? 1 : 0)) };
        case '~': return s === 'float' ? null : { kind: 'num', type: withScalar(v.type, 'int'), values: v.values.map(x => ~x) };
        default: return null;
      }
    }
    case 'binary': {
      const a = ev(e.left);
      const b = ev(e.right);
      return a && b && evalBinary(e.op, a, b);
    }
    case 'ternary': {
      const c = ev(e.cond);
      const a = ev(e.then);
      const b = ev(e.else);
      if (!c || !a || !b) return null;
      if (c.type.k === 'scalar') return c.values[0] !== 0 ? a : b;
      const shape = withScalar(c.type, scalarKindOf(a.type));
      const x = fit(a, shape, scalarKindOf(a.type));
      const y = fit(b, shape, scalarKindOf(a.type));
      if (!x || !y) return null;
      return { kind: 'num', type: shape, values: c.values.map((k, i) => (k !== 0 ? x[i] : y[i])) };
    }
    case 'call': {
      if (e.target && e.target.kind !== 'intrinsic') return null;
      const args: Num[] = [];
      for (const a of e.args) {
        const v = ev(a);
        if (!v) return null;
        args.push(v);
      }
      return evalIntrinsic(e.callee, args);
    }
    case 'member': {
      const v = ev(e.object);
      const s = v && scalarKind(v.type);
      if (!v || !s || !e.access) return null;
      if (e.access.kind === 'swizzle') return { kind: 'num', type: vectorOf(s, e.access.comps.length), values: e.access.comps.map(i => v.values[i]) };
      if (e.access.kind === 'matrix' && v.type.k === 'matrix') {
        const cols = v.type.cols;
        return { kind: 'num', type: vectorOf(s, e.access.elems.length), values: e.access.elems.map(([r, c]) => v.values[r * cols + c]) };
      }
      return null;
    }
    case 'index': {
      const v = ev(e.object);
      const i = ev(e.index);
      return v && i && evalIndex(v, Math.trunc(i.values[0]));
    }
    case 'initList': {
      const vals: number[] = [];
      for (const item of e.items) {
        const v = ev(item);
        if (!v) return null;
        vals.push(...v.values);
      }
      if (vals.length === 0) return null;
      const type = e.type ?? (vals.length <= 4 ? vectorOf('float', vals.length) : { k: 'array', of: { k: 'scalar', s: 'float' }, length: vals.length });
      const base = type.k === 'array' ? arrayBase(type) : type;
      const s = scalarKind(base);
      if (!s || componentCount(type) !== vals.length) return null;
      return { kind: 'num', type, values: vals.map(x => castScalar(x, s)) };
    }
    default: return null;
  }
}

// 配列の一番内側の型
function arrayBase(t: Type): Type {
  return t.k === 'array' ? arrayBase(t.of) : t;
}
