// HLSL の型の表現と、型変換・二項演算の決まり。

export type Scalar = 'float' | 'int' | 'uint' | 'bool';
export type Dim = '1D' | '2D' | '3D' | 'CUBE';
export type Type =
  | { k: 'scalar'; s: Scalar }
  | { k: 'vector'; s: Scalar; n: 2 | 3 | 4 }
  | { k: 'matrix'; s: Scalar; rows: 1 | 2 | 3 | 4; cols: 1 | 2 | 3 | 4 } // HLSL の floatRxC (R 行 C 列)
  | { k: 'array'; of: Type; length: number }
  | { k: 'struct'; name: string; fields: { name: string; type: Type; semantic: string | null }[] }
  | { k: 'sampler'; dim: Dim | null } // null は `sampler` (向きは使い方で決まる)
  | { k: 'texture'; dim: Dim | null } // null は `texture`
  | { k: 'string' }
  | { k: 'void' };

type Size = 1 | 2 | 3 | 4;

function checkSize(n: number): Size {
  if (n !== 1 && n !== 2 && n !== 3 && n !== 4) throw new RangeError(`型の大きさは 1〜4: ${n}`);
  return n;
}

// n = 1 ならスカラー
export function vectorOf(s: Scalar, n: number): Type {
  const m = checkSize(n);
  return m === 1 ? { k: 'scalar', s } : { k: 'vector', s, n: m };
}

// 1x1 はスカラー
export function matrixOf(s: Scalar, rows: number, cols: number): Type {
  const r = checkSize(rows);
  const c = checkSize(cols);
  return r === 1 && c === 1 ? { k: 'scalar', s } : { k: 'matrix', s, rows: r, cols: c };
}

const SCALAR_NAMES: Record<string, Scalar> = {
  float: 'float', half: 'float', double: 'float', int: 'int', uint: 'uint', bool: 'bool',
};
const NUMERIC_RE = /^(float|half|double|int|uint|bool)(?:([1-4])(?:x([1-4]))?)?$/;
const DIMS: Record<string, Dim> = { '1D': '1D', '2D': '2D', '3D': '3D', CUBE: 'CUBE' };
const OBJECT_RE = /^(sampler|texture)(1D|2D|3D|CUBE)?$/;

// キーワードの型 ('half3' → float3、'double' → float など)。型でない名前は null
export function builtinType(name: string): Type | null {
  const m = NUMERIC_RE.exec(name);
  if (m) {
    const s = SCALAR_NAMES[m[1]];
    if (m[2] === undefined) return { k: 'scalar', s };
    if (m[3] === undefined) return vectorOf(s, Number(m[2]));
    return matrixOf(s, Number(m[2]), Number(m[3]));
  }
  const o = OBJECT_RE.exec(name);
  if (o) {
    const dim = o[2] === undefined ? null : DIMS[o[2]];
    return o[1] === 'sampler' ? { k: 'sampler', dim } : { k: 'texture', dim };
  }
  if (name === 'string') return { k: 'string' };
  if (name === 'void') return { k: 'void' };
  return null;
}

// HLSL の書き方: 'float4x3'・'float'・'S'・'float4[3]'
export function typeName(t: Type): string {
  switch (t.k) {
    case 'scalar': return t.s;
    case 'vector': return `${t.s}${t.n}`;
    case 'matrix': return `${t.s}${t.rows}x${t.cols}`;
    case 'array': return `${typeName(t.of)}[${t.length}]`;
    case 'struct': return t.name;
    case 'sampler': return t.dim === null ? 'sampler' : `sampler${t.dim}`;
    case 'texture': return t.dim === null ? 'texture' : `texture${t.dim}`;
    case 'string': return 'string';
    case 'void': return 'void';
  }
}

export function sameType(a: Type, b: Type): boolean {
  switch (a.k) {
    case 'scalar': return b.k === 'scalar' && a.s === b.s;
    case 'vector': return b.k === 'vector' && a.s === b.s && a.n === b.n;
    case 'matrix': return b.k === 'matrix' && a.s === b.s && a.rows === b.rows && a.cols === b.cols;
    case 'array': return b.k === 'array' && a.length === b.length && sameType(a.of, b.of);
    case 'struct': return b.k === 'struct' && a.name === b.name;
    case 'sampler': return b.k === 'sampler' && a.dim === b.dim;
    case 'texture': return b.k === 'texture' && a.dim === b.dim;
    case 'string': return b.k === 'string';
    case 'void': return b.k === 'void';
  }
}

export function componentCount(t: Type): number {
  switch (t.k) {
    case 'scalar': return 1;
    case 'vector': return t.n;
    case 'matrix': return t.rows * t.cols;
    case 'array': return t.length * componentCount(t.of);
    case 'struct': return t.fields.reduce((sum, f) => sum + componentCount(f.type), 0);
    default: return 0;
  }
}

// 数値の型を (形, 行, 列) で見る。ベクトルは 1 行 n 列として扱う
interface Shape { form: 'scalar' | 'vector' | 'matrix'; s: Scalar; rows: number; cols: number }

function shapeOf(t: Type): Shape | null {
  switch (t.k) {
    case 'scalar': return { form: 'scalar', s: t.s, rows: 1, cols: 1 };
    case 'vector': return { form: 'vector', s: t.s, rows: 1, cols: t.n };
    case 'matrix': return { form: 'matrix', s: t.s, rows: t.rows, cols: t.cols };
    default: return null;
  }
}

function fromShape(form: Shape['form'], s: Scalar, rows: number, cols: number): Type {
  if (form === 'vector') return vectorOf(s, cols);
  return matrixOf(s, rows, cols);
}

export interface Conversion { cost: number; truncates: boolean }

// 暗黙の型変換。できなければ null
export function conversion(from: Type, to: Type): Conversion | null {
  if (sameType(from, to)) return { cost: 0, truncates: false };
  if (from.k === 'sampler' && to.k === 'sampler') return from.dim === null || to.dim === null ? { cost: 0, truncates: false } : null;
  if (from.k === 'texture' && to.k === 'texture') return from.dim === null || to.dim === null ? { cost: 0, truncates: false } : null;
  const a = shapeOf(from);
  const b = shapeOf(to);
  if (!a || !b) return null;
  const kindDiffers = a.s !== b.s;
  const widen = { cost: 2, truncates: false };
  const truncate = { cost: 4, truncates: true };
  switch (a.form) {
    case 'scalar':
      if (b.form === 'scalar') return { cost: 1, truncates: false };
      return { cost: kindDiffers ? 3 : widen.cost, truncates: false };
    case 'vector':
      if (b.form === 'scalar') return truncate;
      if (b.form === 'vector') {
        if (b.cols === a.cols) return { cost: 1, truncates: false };
        return b.cols < a.cols ? truncate : null;
      }
      return a.cols === b.rows * b.cols ? { cost: 5, truncates: false } : null;
    case 'matrix':
      if (b.form === 'scalar') return truncate;
      if (b.form === 'vector') return a.rows * a.cols === b.cols ? { cost: 5, truncates: false } : null;
      if (a.rows === b.rows && a.cols === b.cols) return { cost: 1, truncates: false };
      return b.rows <= a.rows && b.cols <= a.cols ? truncate : null;
  }
}

const ARITHMETIC = new Set(['+', '-', '*', '/', '%']);
const COMPARISON = new Set(['<', '>', '<=', '>=', '==', '!=', '&&', '||']);

// 算術では、どちらかが float なら float、bool は int にする
function arithmeticScalar(a: Scalar, b: Scalar): Scalar {
  if (a === 'float' || b === 'float') return 'float';
  if (a === 'uint' || b === 'uint') return 'uint';
  return 'int';
}

// 二項演算の結果の型。行列 * 行列は成分ごとの積 (行列の積は mul)。使えない組み合わせは null
export function binaryResultType(op: string, a: Type, b: Type): { type: Type; truncates: boolean } | null {
  const arithmetic = ARITHMETIC.has(op);
  if (!arithmetic && !COMPARISON.has(op)) return null;
  const x = shapeOf(a);
  const y = shapeOf(b);
  if (!x || !y) return null;
  let form: Shape['form'];
  let rows: number;
  let cols: number;
  let truncates = false;
  if (x.form === 'scalar' || y.form === 'scalar') {
    const other = x.form === 'scalar' ? y : x;
    ({ form, rows, cols } = other);
  } else if (x.form === y.form) {
    form = x.form;
    rows = Math.min(x.rows, y.rows);
    cols = Math.min(x.cols, y.cols);
    truncates = rows !== x.rows || rows !== y.rows || cols !== x.cols || cols !== y.cols;
  } else {
    return null; // ベクトルと行列は混ぜない
  }
  const s: Scalar = arithmetic ? arithmeticScalar(x.s, y.s) : 'bool';
  return { type: fromShape(form, s, rows, cols), truncates };
}
