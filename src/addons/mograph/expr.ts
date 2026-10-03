// --- フォーミュラの式 (Cinema 4D のフォーミュラ・エフェクタと同じ書き方) ---
// 数・変数・+ - * / % ^・( )・関数だけを読む (JavaScript としては動かさないので、プロジェクトに入っていても安全)。
// 三角関数は度で (Cinema 4D と同じく、既定の式は sin((t*f + id/count)*360))
export type Vars = Record<string, number>;
type Node = (v: Vars) => number;

const D = Math.PI / 180;
const FUNCS: Record<string, (...a: number[]) => number> = {
  sin: a => Math.sin(a * D), cos: a => Math.cos(a * D), tan: a => Math.tan(a * D),
  asin: a => Math.asin(a) / D, acos: a => Math.acos(a) / D, atan: a => Math.atan(a) / D, atan2: (y, x) => Math.atan2(y, x) / D,
  abs: Math.abs, floor: Math.floor, ceil: Math.ceil, round: Math.round, sqrt: Math.sqrt, exp: Math.exp, log: Math.log,
  pow: Math.pow, min: Math.min, max: Math.max, sign: Math.sign, frac: a => a - Math.floor(a),
  clamp: (a, lo = 0, hi = 1) => Math.min(Math.max(a, lo), hi),
  step: (edge, x) => (x < edge ? 0 : 1),
};
const CONSTS: Record<string, number> = { pi: Math.PI, PI: Math.PI, e: Math.E };

export class ExprError extends Error {}

// 式を読んで、変数から値を出す関数にする (読めなければ ExprError)
export function compile(src: string): Node {
  const toks = src.match(/\d+\.?\d*(?:e[+-]?\d+)?|\.\d+|[A-Za-z_]\w*|\*\*|[-+*/%^(),]|\S/g) ?? [];
  let i = 0;
  const peek = () => toks[i];
  const take = (t?: string) => {
    const x = toks[i];
    if (t !== undefined && x !== t) throw new ExprError(`${t} がありません${x ? ` (${x} のところ)` : ''}`);
    i++;
    return x;
  };
  // 足し算 < 掛け算 < べき乗 < 単項 < 値
  function expr(): Node {
    let a = term();
    while (peek() === '+' || peek() === '-') {
      const op = take(), l = a, r = term();
      a = op === '+' ? v => l(v) + r(v) : v => l(v) - r(v);
    }
    return a;
  }
  function term(): Node {
    let a = power();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = take(), l = a, r = power();
      a = op === '*' ? v => l(v) * r(v) : op === '/' ? v => l(v) / r(v) : v => l(v) % r(v);
    }
    return a;
  }
  function power(): Node {
    const a = unary();
    if (peek() === '^' || peek() === '**') { take(); const b = power(); return v => Math.pow(a(v), b(v)); }
    return a;
  }
  function unary(): Node {
    if (peek() === '-') { take(); const a = unary(); return v => -a(v); }
    if (peek() === '+') { take(); return unary(); }
    return atom();
  }
  function atom(): Node {
    const t = take();
    if (t === undefined) throw new ExprError('式が途中で終わっています');
    if (t === '(') { const a = expr(); take(')'); return a; }
    if (/^[\d.]/.test(t)) { const n = Number(t); if (!Number.isFinite(n)) throw new ExprError(`${t} は数ではありません`); return () => n; }
    if (/^[A-Za-z_]/.test(t)) {
      if (peek() === '(') {
        const f = Object.hasOwn(FUNCS, t) ? FUNCS[t] : undefined;
        if (!f) throw new ExprError(`知らない関数です: ${t}`);
        take('(');
        const args: Node[] = [];
        if (peek() !== ')') { args.push(expr()); while (peek() === ',') { take(); args.push(expr()); } }
        take(')');
        return v => f(...args.map(a => a(v)));
      }
      if (Object.hasOwn(CONSTS, t)) { const c = CONSTS[t]; return () => c; }
      return v => { if (!Object.hasOwn(v, t)) throw new ExprError(`知らない変数です: ${t}`); return v[t]; };
    }
    throw new ExprError(`読めない文字です: ${t}`);
  }
  if (!toks.length) throw new ExprError('式がありません');
  const root = expr();
  if (i < toks.length) throw new ExprError(`余分な文字があります: ${toks[i]}`);
  return root;
}

// 読んだ式を覚えておく (毎フレーム読み直さない)。読めない式は、いつも 0 を返す
const cache = new Map<string, { fn: Node | null; error: string | null }>();
export function formula(src: string) {
  let c = cache.get(src);
  if (!c) {
    try { c = { fn: compile(src), error: null }; } catch (err) { c = { fn: null, error: (err as Error).message }; }
    if (cache.size > 200) cache.clear();
    cache.set(src, c);
  }
  return c;
}
export function evaluate(src: string, vars: Vars) {
  const { fn } = formula(src);
  if (!fn) return 0;
  try { const v = fn(vars); return Number.isFinite(v) ? v : 0; } catch { return 0; }
}
