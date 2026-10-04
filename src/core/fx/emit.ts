import { t } from '../i18n.ts';
import type { Expr, FunctionDecl, ParamNode, Stmt, VarDecl } from './ast.ts';
import type { CheckedEffect, FunctionInfo } from './check.ts';
import type { Diagnostics, Loc } from './diagnostics.ts';
import { arrayLeaf, arrayLengths, componentCount, flatLength, scalarKind, typeName, type Scalar, type Type } from './types.ts';

// --- GLSL ES 3.00 の書き出し (型・名前・式・文・関数)。型チェック済みの AST を、意味を変えずに GLSL に写す。
// 暗黙の型変換は型チェックが入れた convert をそのまま書くだけで、ここでは新しい変換を作らない ---

export interface EmitContext {
  checked: CheckedEffect; stage: 'vertex' | 'fragment';
  helpers: Set<string>; // 使った mme_ の関数 (mme_fmod など)。ddy を使うと 'mme_flipY' (uniform なので emitHelpers は書かない)
  usedGlobals: Set<string>; usedFunctions: Set<FunctionInfo>; usedStructs: Set<string>;
  diags: Diagnostics; // 書き出せない式 (FX-UNSUPPORTED) を積む
}

export function newEmitContext(checked: CheckedEffect, stage: 'vertex' | 'fragment', diags: Diagnostics): EmitContext {
  return { checked, stage, helpers: new Set(), usedGlobals: new Set(), usedFunctions: new Set(), usedStructs: new Set(), diags };
}

// --- 名前 ---
const RESERVED = new Set(`
attribute const uniform varying layout centroid flat smooth noperspective break continue do for while switch case default
if else in out inout float int void bool true false invariant discard return lowp mediump highp precision struct uint
mat2 mat3 mat4 mat2x2 mat2x3 mat2x4 mat3x2 mat3x3 mat3x4 mat4x2 mat4x3 mat4x4 vec2 vec3 vec4 ivec2 ivec3 ivec4
bvec2 bvec3 bvec4 uvec2 uvec3 uvec4 sampler2D sampler3D samplerCube sampler2DShadow samplerCubeShadow sampler2DArray
sampler2DArrayShadow isampler2D isampler3D isamplerCube isampler2DArray usampler2D usampler3D usamplerCube usampler2DArray
coherent volatile restrict readonly writeonly resource atomic_uint patch sample subroutine common partition active asm
class union enum typedef template this goto inline noinline public static extern external interface long short double
half fixed unsigned superp input output hvec2 hvec3 hvec4 dvec2 dvec3 dvec4 fvec2 fvec3 fvec4 sampler3DRect filter
image1D image2D image3D imageCube iimage1D iimage2D iimage3D iimageCube uimage1D uimage2D uimage3D uimageCube
image1DArray image2DArray iimage1DArray iimage2DArray uimage1DArray uimage2DArray imageBuffer iimageBuffer uimageBuffer
sampler1D sampler1DShadow sampler1DArray sampler1DArrayShadow isampler1D isampler1DArray usampler1D usampler1DArray
sampler2DRect sampler2DRectShadow isampler2DRect usampler2DRect samplerBuffer isamplerBuffer usamplerBuffer
sampler2DMS isampler2DMS usampler2DMS sampler2DMSArray isampler2DMSArray usampler2DMSArray sizeof cast namespace using
buffer shared precise main
radians degrees sin cos tan asin acos atan sinh cosh tanh asinh acosh atanh pow exp log exp2 log2 sqrt inversesqrt
abs sign floor trunc round roundEven ceil fract mod min max clamp mix step smoothstep modf isnan isinf floatBitsToInt
floatBitsToUint intBitsToFloat uintBitsToFloat packSnorm2x16 unpackSnorm2x16 packUnorm2x16 unpackUnorm2x16
packHalf2x16 unpackHalf2x16 length distance dot cross normalize faceforward reflect refract matrixCompMult
outerProduct transpose determinant inverse lessThan lessThanEqual greaterThan greaterThanEqual equal notEqual any all
not textureSize texture textureProj textureLod textureOffset texelFetch texelFetchOffset textureProjOffset
textureLodOffset textureProjLod textureProjLodOffset textureGrad textureGradOffset textureProjGrad textureProjGradOffset
dFdx dFdy fwidth`.split(/\s+/).filter(Boolean));

// 書き出しが作る名前 (a_POSITION・v_TEXCOORD0・o_COLOR0・mme_fmod …) とぶつかりうる名前。
// a_・v_・o_ のあとはいつも大文字のセマンティクスなので、小文字が続く名前 (a_x_b) は変えない
const GENERATED = /^(?:(?:a|v|o)_[A-Z0-9]|mme_)/;

// GLSL の予約語・組み込み関数・書き出しが作る名前とぶつかる名前は後ろに _、
// gl_・webgl_・_webgl_ (GL と WebGL が予約) は前に x、__ (予約) は _x_ (後ろに _ を足したあとも)
export function glslName(name: string): string {
  let n = /^(?:gl_|webgl_|_webgl_)/.test(name) ? `x${name}` : name;
  n = n.replace(/__+/g, '_x_');
  if (RESERVED.has(n) || GENERATED.test(n)) n = `${n}_`.replace(/__+/g, '_x_');
  return n;
}

// --- 型 ---
const VEC_PREFIX: Record<Scalar, string> = { float: 'vec', int: 'ivec', uint: 'uvec', bool: 'bvec' };

export function glslType(ty: Type): string {
  switch (ty.k) {
    case 'scalar': return ty.s;
    case 'vector': return `${VEC_PREFIX[ty.s]}${ty.n}`;
    case 'matrix': return ty.rows === ty.cols ? `mat${ty.rows}` : `mat${ty.rows}x${ty.cols}`; // HLSL の行が GLSL の列
    case 'array': return `${glslType(arrayLeaf(ty))}[${flatLength(ty)}]`; // 配列の配列は 1 次元にする (GLSL ES 3.00 にはない)
    case 'struct': return glslName(ty.name);
    case 'sampler': return ty.dim === '3D' ? 'sampler3D' : ty.dim === 'CUBE' ? 'samplerCube' : 'sampler2D'; // 1D は 2D の 1 行
    case 'void': return 'void';
    default: throw new Error(`glslType: ${typeName(ty)}`);
  }
}

export function zeroOf(ty: Type): string {
  switch (ty.k) {
    case 'scalar': return scalarLit(0, ty.s).s;
    case 'vector': case 'matrix': return `${glslType(ty)}(${scalarLit(0, ty.s).s})`;
    case 'array': return `${glslType(ty)}(${Array.from({ length: flatLength(ty) }, () => zeroOf(arrayLeaf(ty))).join(', ')})`;
    case 'struct': return `${glslName(ty.name)}(${ty.fields.map(f => zeroOf(f.type)).join(', ')})`;
    default: throw new Error(`zeroOf: ${typeName(ty)}`);
  }
}

// --- 書き出した式と、その優先順位 (大きいほど強く結びつく。GLSL の順) ---
interface Code { s: string; p: number }
const P = { seq: 1, assign: 2, cond: 3, or: 4, and: 6, eq: 9, rel: 10, add: 12, mul: 13, unary: 14, post: 15 };
const BINARY_PREC: Record<string, number> = {
  '||': P.or, '&&': P.and, '==': P.eq, '!=': P.eq, '<': P.rel, '>': P.rel, '<=': P.rel, '>=': P.rel,
  '+': P.add, '-': P.add, '*': P.mul, '/': P.mul, '%': P.mul,
};
const VEC_COMPARE: Record<string, string> = {
  '<': 'lessThan', '>': 'greaterThan', '<=': 'lessThanEqual', '>=': 'greaterThanEqual', '==': 'equal', '!=': 'notEqual',
};
const XYZW = 'xyzw';

const code = (s: string, p: number): Code => ({ s, p });
const primary = (s: string): Code => code(s, P.post);
const wrap = (c: Code, min: number): string => (c.p < min ? `(${c.s})` : c.s);
const call = (name: string, args: string[]): Code => primary(`${name}(${args.join(', ')})`);
const comp = (c: Code, i: number): string => `${wrap(c, P.post)}.${XYZW[i]}`;

// --- 数 ---
const INF = 'uintBitsToFloat(0x7F800000u)';

function floatLit(v: number): string {
  if (Number.isNaN(v)) return 'uintBitsToFloat(0x7FC00000u)';
  if (!Number.isFinite(Math.fround(v))) return INF; // float に入らない数も無限大
  let s = String(v);
  if (!/[.e]/.test(s)) s += '.0';
  return s.replace(/e([+-])(\d)$/, (_, sign: string, d: string) => `e${sign}0${d}`); // 1e-7 → 1e-07
}

function scalarLit(v: number, s: Scalar): Code {
  const neg = v < 0 || Object.is(v, -0);
  const a = Math.abs(v);
  let str: string;
  switch (s) {
    case 'float': str = floatLit(a); break;
    case 'int': str = a > 0x7FFFFFFF ? `int(${a >>> 0}u)` : String(a); break;
    case 'uint': return primary(`${v >>> 0}u`);
    case 'bool': return primary(v !== 0 ? 'true' : 'false');
  }
  return neg && !Number.isNaN(v) && (s === 'float' || v !== 0) ? code(`-${str}`, P.unary) : primary(str);
}

function castScalar(v: number, s: Scalar): number {
  if (s === 'int') return Math.trunc(v);
  if (s === 'uint') return Math.trunc(v) >>> 0;
  if (s === 'bool') return v !== 0 ? 1 : 0;
  return v;
}

// 数そのもの (と、その符号を変えたもの) の値。たためなければ null
function literalOf(e: Expr): number | null {
  if (e.kind === 'number') return e.value;
  if (e.kind === 'bool') return e.value ? 1 : 0;
  if (e.kind === 'unary' && (e.op === '-' || e.op === '+') && e.operand.kind === 'number') return e.op === '-' ? -e.operand.value : e.operand.value;
  return null;
}

// 数 v を数値の型 to にした値
function foldedConst(to: Type, v: number): Code {
  const s = scalarKind(to) as Scalar;
  const lit = scalarLit(castScalar(v, s), s).s;
  if (to.k === 'scalar') return scalarLit(castScalar(v, s), s);
  if (to.k === 'matrix' && castScalar(v, s) !== 0) return call(glslType(to), Array.from({ length: to.rows * to.cols }, () => lit)); // matN(x) は対角だけ
  return call(glslType(to), [lit]);
}

// 定数の値 (consteval の並び。行列は HLSL の行ごと = GLSL の列ごと) を、型 ty の GLSL の定数式に
export function emitConst(values: number[], ty: Type): string {
  switch (ty.k) {
    case 'scalar': return scalarLit(castScalar(values[0], ty.s), ty.s).s;
    case 'vector': case 'matrix': return call(glslType(ty), values.map(v => scalarLit(castScalar(v, ty.s), ty.s).s)).s;
    case 'array': {
      const leaf = arrayLeaf(ty);
      const n = componentCount(leaf);
      return call(glslType(ty), Array.from({ length: flatLength(ty) }, (_, i) => emitConst(values.slice(i * n, (i + 1) * n), leaf))).s;
    }
    default: throw new Error(`emitConst: ${typeName(ty)}`);
  }
}

// --- 文脈 ---
function unsupported(ctx: EmitContext, loc: Loc, message: string): void {
  ctx.diags.error('FX-UNSUPPORTED', loc, message);
}

// 使う構造体を ctx.usedStructs に記す (配列の中も)
export function noteType(ty: Type, ctx: EmitContext): void {
  if (ty.k === 'array') noteType(ty.of, ctx);
  else if (ty.k === 'struct') ctx.usedStructs.add(ty.name);
}

function addHelper(name: string, ctx: EmitContext): void {
  ctx.helpers.add(name);
  if (name === 'mme_imod') ctx.helpers.add('mme_idiv');
}

function fragmentOnly(name: string, loc: Loc, ctx: EmitContext): void {
  if (ctx.stage === 'vertex') unsupported(ctx, loc, t('{name} はピクセルシェーダーでだけ使えます', { name }));
}

function typeOf(e: Expr): Type {
  if (!e.type) throw new Error(`型のない式: ${e.kind}`);
  return e.type;
}

// 式のすぐ下の式 (Expr の種類を足したら、ここも足す)
export function exprChildren(e: Expr): Expr[] {
  switch (e.kind) {
    case 'unary': return [e.operand];
    case 'binary': return [e.left, e.right];
    case 'assign': return [e.target, e.value];
    case 'ternary': return [e.cond, e.then, e.else];
    case 'call': case 'construct': return e.args;
    case 'cast': case 'convert': return [e.value];
    case 'member': return [e.object];
    case 'index': return [e.object, e.index];
    case 'initList': case 'sequence': return e.items;
    default: return [];
  }
}

// 文の中の式を、それぞれ f に渡す (式の中までは入らない)
export function forEachExpr(s: Stmt, f: (e: Expr) => void): void {
  const st = (x: Stmt | null) => { if (x) forEachExpr(x, f); };
  const ex = (x: Expr | null) => { if (x) f(x); };
  switch (s.kind) {
    case 'block': s.body.forEach(st); break;
    case 'var': s.decls.forEach(d => ex(d.init)); break;
    case 'expr': f(s.expr); break;
    case 'if': f(s.cond); st(s.then); st(s.else); break;
    case 'for': st(s.init); ex(s.cond); ex(s.step); st(s.body); break;
    case 'while': case 'do': f(s.cond); st(s.body); break;
    case 'switch': f(s.value); s.cases.forEach(c => c.body.forEach(st)); break;
    case 'return': ex(s.value); break;
    default: break;
  }
}

// 書き込み先 (代入の左辺・out の引数) がグローバル変数か
function globalTarget(e: Expr): boolean {
  if (e.kind === 'member' || e.kind === 'index') return globalTarget(e.object);
  return e.kind === 'ident' && e.sym?.kind === 'global';
}

// 式がグローバル変数を書き換えうるか (呼ぶユーザーの関数の中も見る)
function writesGlobal(e: Expr): boolean {
  if (e.kind === 'assign' && globalTarget(e.target)) return true;
  if (e.kind === 'unary' && (e.op === '++' || e.op === '--') && globalTarget(e.operand)) return true;
  if (e.kind === 'call' && e.target?.kind === 'function') {
    const fn = e.target.fn;
    if (fnWritesGlobal(fn) || fn.params.some((p, i) => p.modifier !== 'in' && p.modifier !== 'uniform' && i < e.args.length && globalTarget(e.args[i]))) return true;
  }
  if (e.kind === 'call' && (e.callee === 'sincos' || e.callee === 'modf') && e.args.slice(1).some(globalTarget)) return true;
  return exprChildren(e).some(writesGlobal);
}

// 関数がグローバル変数を書き換えうるか。中身のないもの (プロトタイプだけ) は、書き換えうるとみなす
const fnWrites = new WeakMap<FunctionDecl, boolean>();
function fnWritesGlobal(fn: FunctionDecl): boolean {
  const memo = fnWrites.get(fn);
  if (memo !== undefined) return memo;
  fnWrites.set(fn, true); // HLSL に再帰はないが、念のため
  let writes = fn.body === null;
  if (fn.body) forEachExpr(fn.body, e => { writes ||= writesGlobal(e); });
  fnWrites.set(fn, writes);
  return writes;
}

// 副作用がありうる式 (++・--・代入・out の引数を持つ組み込み関数・外から見える副作用のあるユーザーの関数の呼び出し)。
// out・inout の引数がなく、グローバル変数を書き換えない関数は、2 回呼んでも同じなので副作用なしとする
function impure(e: Expr): boolean {
  if (e.kind === 'assign' || (e.kind === 'unary' && (e.op === '++' || e.op === '--'))) return true;
  if (e.kind === 'call' && (e.callee === 'sincos' || e.callee === 'modf')) return true;
  if (e.kind === 'call' && e.target?.kind === 'function') {
    const fn = e.target.fn;
    if (fn.params.some(p => p.modifier === 'out' || p.modifier === 'inout') || fnWritesGlobal(fn)) return true;
  }
  if (e.kind === 'call' && !e.target) return true;
  return exprChildren(e).some(impure);
}

// 2 回以上書き出す式は、副作用がないものだけ
function needPure(es: Expr[], loc: Loc, ctx: EmitContext): void {
  if (es.some(impure)) unsupported(ctx, loc, t('副作用のある式を 2 回書き出すことになるので、対応していません'));
}

// 代入の左辺・out の引数: 行列の複数の成分は vecN(…) になるので代入できない
function checkLvalue(e: Expr, ctx: EmitContext): void {
  if (e.kind === 'member') {
    if (e.access?.kind === 'matrix' && e.access.elems.length > 1) {
      unsupported(ctx, e.loc, t('行列の複数の成分への代入には対応していません: {name}', { name: `.${e.name}` }));
    }
    checkLvalue(e.object, ctx);
  } else if (e.kind === 'index') checkLvalue(e.object, ctx);
}

// --- 式 ---
export function emitExpr(e: Expr, ctx: EmitContext): string {
  return ex(e, ctx).s;
}

const arg = (e: Expr, ctx: EmitContext): string => wrap(ex(e, ctx), P.assign);

function ex(e: Expr, ctx: EmitContext): Code {
  switch (e.kind) {
    case 'number': return scalarLit(e.value, scalarKind(typeOf(e)) ?? (e.isFloat ? 'float' : 'int'));
    case 'bool': return primary(e.value ? 'true' : 'false');
    case 'ident':
      if (e.sym?.kind === 'global') ctx.usedGlobals.add(e.name);
      return primary(glslName(e.name));
    case 'unary': return emitUnary(e, ctx);
    case 'binary': return emitBinary(e, ctx);
    case 'assign': return emitAssign(e, ctx);
    case 'ternary': return emitTernary(e, ctx);
    case 'call': return emitCall(e, ctx);
    case 'construct': case 'initList': {
      const ty = typeOf(e);
      noteType(ty, ctx);
      return call(glslType(ty), (e.kind === 'construct' ? e.args : flatItems(e, ctx)).map(a => arg(a, ctx)));
    }
    case 'cast': return emitCast(typeOf(e), e.value, e.loc, ctx);
    case 'convert': return emitConvert(e.to, e.value, ctx);
    case 'member': return emitMember(e, ctx);
    case 'index': return emitIndex(e, ctx);
    case 'sequence': return code(e.items.map(x => arg(x, ctx)).join(', '), P.seq);
    default: throw new Error(`emitExpr: ${e.kind}`);
  }
}

type ExprOf<K extends Expr['kind']> = Extract<Expr, { kind: K }>;

// 配列の配列の初期値のリストは、入れ子の { } を開いて平らに並べる
function flatItems(e: ExprOf<'initList'>, ctx: EmitContext): Expr[] {
  if (typeOf(e).k !== 'array') return e.items;
  return e.items.flatMap(x => {
    if (typeOf(x).k !== 'array') return [x];
    if (x.kind === 'initList') return flatItems(x, ctx);
    unsupported(ctx, x.loc, t('配列の配列の一部を値として使うことには対応していません'));
    return [];
  });
}

// 配列の配列は 1 次元にして持つので、a[i][j] (T a[N][M]) は a[i * M + j] にする
function emitIndex(e: ExprOf<'index'>, ctx: EmitContext): Code {
  if (typeOf(e).k === 'array') {
    unsupported(ctx, e.loc, t('配列の配列の一部を値として使うことには対応していません'));
    return primary('0');
  }
  const indices: Expr[] = [];
  let base: Expr = e;
  while (base.kind === 'index' && typeOf(base.object).k === 'array') {
    indices.unshift(base.index);
    base = base.object;
  }
  if (indices.length <= 1) return primary(`${wrap(ex(e.object, ctx), P.post)}[${ex(e.index, ctx).s}]`);
  const lengths = arrayLengths(typeOf(base));
  const terms = indices.map((x, k) => {
    const c = typeOf(x).k === 'scalar' && scalarKind(typeOf(x)) === 'uint' ? call('int', [ex(x, ctx).s]) : ex(x, ctx);
    const stride = lengths.slice(k + 1).reduce((a, b) => a * b, 1);
    return k === indices.length - 1 ? wrap(c, P.add + 1) : `${wrap(c, P.mul)} * ${stride}`;
  });
  return primary(`${wrap(ex(base, ctx), P.post)}[${terms.join(' + ')}]`);
}

function emitUnary(e: ExprOf<'unary'>, ctx: EmitContext): Code {
  const x = ex(e.operand, ctx);
  switch (e.op) {
    case '!': return typeOf(e.operand).k === 'vector' ? call('not', [x.s]) : code(`!${wrap(x, P.unary)}`, P.unary);
    case '++': case '--':
      checkLvalue(e.operand, ctx);
      return e.postfix ? primary(`${wrap(x, P.post)}${e.op}`) : code(`${e.op}${wrap(x, P.unary)}`, P.unary);
    default: {
      // - -x が --x にならないよう、符号で始まるものは括弧に入れる
      const inner = /^[-+]/.test(x.s) ? `(${x.s})` : wrap(x, P.unary);
      return code(`${e.op}${inner}`, P.unary);
    }
  }
}

function binop(op: string, a: Code, b: Code): Code {
  const p = BINARY_PREC[op];
  return code(`${wrap(a, p)} ${op} ${wrap(b, p + 1)}`, p);
}

// スカラーの側をベクトルの型 ty に広げる (helper はどちらも同じ型を取る)
function widenTo(e: Expr, ty: Type, ctx: EmitContext): string {
  if (typeOf(e).k !== 'scalar' || ty.k === 'scalar') return arg(e, ctx);
  const lit = literalOf(e.kind === 'convert' ? e.value : e);
  if (lit !== null) return foldedConst(ty, lit).s;
  return call(glslType(ty), [arg(e, ctx)]).s;
}

// % と int の / は helper (行列の % は書けない)。使わないなら null
function divHelper(op: string, ty: Type, loc: Loc, ctx: EmitContext): string | null {
  const s = scalarKind(ty);
  if (op === '%' && ty.k === 'matrix') {
    unsupported(ctx, loc, t('行列に {name} を使うことには対応していません', { name: '%' }));
    return null;
  }
  const name = op === '%' ? (s === 'float' ? 'mme_fmod' : s === 'int' ? 'mme_imod' : null) : op === '/' && s === 'int' ? 'mme_idiv' : null;
  if (name) addHelper(name, ctx);
  return name;
}

function emitBinary(e: ExprOf<'binary'>, ctx: EmitContext): Code {
  const op = e.op;
  const lt = typeOf(e.left);
  const rt = typeOf(e.right);
  const ty = typeOf(e);
  if (op === '&&' || op === '||') {
    if (ty.k !== 'vector') return binop(op, ex(e.left, ctx), ex(e.right, ctx));
    // ベクトルの && || は成分ごとで、短絡しない (HLSL は両方を計算する)。bool を 0・1 の uint にしてビット演算
    const u = `uvec${ty.n}`;
    return call(glslType(ty), [`${u}(${ex(e.left, ctx).s}) ${op[0]} ${u}(${ex(e.right, ctx).s})`]);
  }
  if (Object.hasOwn(VEC_COMPARE, op)) {
    const relational = op !== '==' && op !== '!=';
    // bool の大小は int にして比べる
    const side = (x: Expr, xt: Type): Code => {
      const c = ex(x, ctx);
      return relational && scalarKind(xt) === 'bool' ? call(xt.k === 'vector' ? `ivec${xt.n}` : 'int', [c.s]) : c;
    };
    const a = side(e.left, lt);
    const b = side(e.right, rt);
    return lt.k === 'vector' ? call(VEC_COMPARE[op], [a.s, b.s]) : binop(op, a, b);
  }
  if (op === '*' && lt.k === 'matrix' && rt.k === 'matrix') return call('matrixCompMult', [arg(e.left, ctx), arg(e.right, ctx)]);
  if (op === '%' || op === '/') {
    const fn = divHelper(op, ty, e.loc, ctx);
    if (fn) return call(fn, [widenTo(e.left, ty, ctx), widenTo(e.right, ty, ctx)]);
  }
  return binop(op, ex(e.left, ctx), ex(e.right, ctx));
}

function emitAssign(e: ExprOf<'assign'>, ctx: EmitContext): Code {
  checkLvalue(e.target, ctx);
  const target = ex(e.target, ctx);
  const tt = typeOf(e.target);
  const vt = typeOf(e.value);
  let fn: string | null = null;
  if (e.op === '%=' || e.op === '/=') fn = divHelper(e.op[0], tt, e.loc, ctx);
  else if (e.op === '*=' && tt.k === 'matrix' && vt.k === 'matrix') fn = 'matrixCompMult';
  if (!fn) return code(`${wrap(target, P.unary)} ${e.op} ${wrap(ex(e.value, ctx), P.assign)}`, P.assign);
  // x op= y を x = f(x, y) に開く。左辺を 2 回書くので、副作用のないものだけ
  if (impure(e.target)) unsupported(ctx, e.loc, t('副作用のある式を 2 回書き出すことになるので、対応していません'));
  return code(`${wrap(target, P.unary)} = ${fn}(${target.s}, ${widenTo(e.value, tt, ctx)})`, P.assign);
}

function emitTernary(e: ExprOf<'ternary'>, ctx: EmitContext): Code {
  const ct = typeOf(e.cond);
  const ty = typeOf(e);
  if (ct.k !== 'vector') {
    return code(`${wrap(ex(e.cond, ctx), P.or)} ? ${wrap(ex(e.then, ctx), P.assign)} : ${wrap(ex(e.else, ctx), P.cond)}`, P.cond);
  }
  // 条件がベクトル: float は mix。それ以外は短絡しない算術・ビット演算で選ぶ (枝は 1 回ずつ書き、条件だけ 2 回書く)
  const s = scalarKind(ty);
  if (s === 'float') return call('mix', [arg(e.else, ctx), arg(e.then, ctx), arg(e.cond, ctx)]);
  needPure([e.cond], e.loc, ctx);
  const c = ex(e.cond, ctx).s;
  if (s === 'bool') {
    const u = `uvec${ct.n}`;
    return call(glslType(ty), [`(${u}(${c}) & ${u}(${ex(e.then, ctx).s})) | (${u}(not(${c})) & ${u}(${ex(e.else, ctx).s}))`]);
  }
  // int・uint: a * T(c) + b * T(!c) (0・1 を掛けて足すので値は変わらない)
  const T = glslType(ty);
  return code(`${wrap(ex(e.then, ctx), P.mul)} * ${T}(${c}) + ${wrap(ex(e.else, ctx), P.mul)} * ${T}(not(${c}))`, P.add);
}

// 暗黙の型変換。中身が数なら変換したあとの数を書く
function emitConvert(to: Type, value: Expr, ctx: EmitContext): Code {
  const from = typeOf(value);
  const lit = literalOf(value);
  if (lit !== null && scalarKind(to) !== null) return foldedConst(to, lit);
  noteType(to, ctx);
  const x = ex(value, ctx);
  if (typeName(from) === typeName(to)) return x;
  if (to.k === 'scalar' && from.k === 'matrix') {
    const elem = primary(`${wrap(x, P.post)}[0][0]`);
    return to.s === 'float' ? elem : call(to.s, [elem.s]);
  }
  // スカラーを行列に広げる: matN(x) は対角だけなので、全部の成分を x にする
  if (to.k === 'matrix' && from.k === 'scalar') return call('outerProduct', [`vec${to.cols}(${wrap(x, P.assign)})`, `vec${to.rows}(1.0)`]);
  return call(glslType(to), [wrap(x, P.assign)]);
}

// 明示のキャスト。構造体へはスカラーを各成分に入れる ((S)0)
function emitCast(to: Type, value: Expr, loc: Loc, ctx: EmitContext): Code {
  const from = typeOf(value);
  if (to.k !== 'struct' || typeName(from) === typeName(to)) return emitConvert(to, value, ctx);
  noteType(to, ctx);
  const lit = literalOf(value);
  if (lit === null) needPure([value], loc, ctx);
  const x = lit === null ? ex(value, ctx) : null;
  const fill = (ty: Type): string => {
    if (ty.k === 'struct') return call(glslType(ty), ty.fields.map(f => fill(f.type))).s;
    if (ty.k === 'array') return call(glslType(ty), Array.from({ length: flatLength(ty) }, () => fill(arrayLeaf(ty)))).s;
    if (x === null) return foldedConst(ty, lit as number).s;
    if (ty.k === 'matrix') return call('outerProduct', [`vec${ty.cols}(${wrap(x, P.assign)})`, `vec${ty.rows}(1.0)`]).s;
    return typeName(ty) === typeName(from) ? wrap(x, P.assign) : call(glslType(ty), [wrap(x, P.assign)]).s;
  };
  return primary(fill(to));
}

function emitMember(e: ExprOf<'member'>, ctx: EmitContext): Code {
  const a = e.access;
  if (!a) throw new Error(`access のないメンバー: ${e.name}`);
  const objType = typeOf(e.object);
  if (a.kind === 'matrix' && a.elems.length > 1) needPure([e.object], e.loc, ctx);
  const o = ex(e.object, ctx);
  switch (a.kind) {
    case 'field': return primary(`${wrap(o, P.post)}.${glslName(a.name)}`);
    case 'swizzle':
      // スカラーの .x はそのまま、.xx は vecN(s)
      if (objType.k === 'scalar') return a.comps.length === 1 ? o : call(glslType(typeOf(e)), [wrap(o, P.assign)]);
      return primary(`${wrap(o, P.post)}.${a.comps.map(i => XYZW[i]).join('')}`);
    case 'matrix': {
      const elems = a.elems.map(([r, c]) => `${wrap(o, P.post)}[${r}][${c}]`);
      return elems.length === 1 ? primary(elems[0]) : call(glslType(typeOf(e)), elems);
    }
  }
}

function emitCall(e: ExprOf<'call'>, ctx: EmitContext): Code {
  const target = e.target;
  if (!target) throw new Error(`target のない呼び出し: ${e.callee}`);
  if (target.kind === 'intrinsic') return emitIntrinsic(e, target.params, ctx);
  const fn = target.fn;
  const info = ctx.checked.functions.find(f => f.decl === fn);
  if (!info) throw new Error(`型チェックしていない関数: ${fn.name}`);
  ctx.usedFunctions.add(info);
  // 省いた引数は既定値 (型チェックで変換済み)
  const args = fn.params.map((p, i) => (i < e.args.length ? e.args[i] : p.init)).filter((a): a is Expr => a !== null);
  args.forEach((a, i) => {
    if (fn.params[i].modifier === 'out' || fn.params[i].modifier === 'inout') checkLvalue(a, ctx);
  });
  return call(glslName(fn.name), args.map(a => arg(a, ctx)));
}

// 名前だけ付け替える組み込み関数 (同じ名前のものも)
const RENAMED: Record<string, string> = {
  atan2: 'atan', frac: 'fract', rsqrt: 'inversesqrt', lerp: 'mix', ddx: 'dFdx', fmod: 'mme_fmod', sincos: 'mme_sincos', lit: 'mme_lit',
};
const SAME = new Set(`abs acos asin atan ceil clamp cos cosh degrees exp exp2 floor fwidth isinf isnan log log2 max min modf pow
  radians round sign sin sinh smoothstep sqrt step tan tanh trunc cross distance dot faceforward length normalize reflect refract
  determinant transpose`.split(/\s+/));
const MATRIX_OK = new Set(['mul', 'transpose', 'determinant']);
const FRAGMENT_ONLY = new Set(['ddx', 'ddy', 'fwidth', 'clip']);

function emitIntrinsic(e: ExprOf<'call'>, params: Type[], ctx: EmitContext): Code {
  const name = e.callee;
  const loc = e.loc;
  if (!MATRIX_OK.has(name) && params.some(p => p.k === 'matrix')) {
    unsupported(ctx, loc, t('行列に {name} を使うことには対応していません', { name }));
  }
  if (FRAGMENT_ONLY.has(name) || /^tex\w+bias$/.test(name)) fragmentOnly(name, loc, ctx); // texture(…, bias) もフラグメントだけ
  if (name === 'sincos') e.args.slice(1).forEach(a => checkLvalue(a, ctx));
  if (name === 'modf') checkLvalue(e.args[1], ctx);
  const tex = /^tex(1D|2D|3D|CUBE)(lod|bias|proj|grad)?$/.exec(name);
  if (tex) return emitTexture(tex[1], tex[2] ?? '', e, ctx);
  const c = e.args.map(a => ex(a, ctx));
  const a = c.map(x => wrap(x, P.assign));
  const p0 = params[0];
  if (Object.hasOwn(RENAMED, name)) {
    if (RENAMED[name].startsWith('mme_')) addHelper(RENAMED[name], ctx);
    return call(RENAMED[name], a);
  }
  if (SAME.has(name)) return call(name, a);
  switch (name) {
    case 'mul': {
      const [x, y] = params;
      if (x.k === 'scalar' || y.k === 'scalar') return binop('*', c[0], c[1]);
      if (x.k === 'vector' && y.k === 'vector') return call('dot', a);
      return code(`(${c[1].s}) * (${c[0].s})`, P.mul); // HLSL の行を GLSL の列として持つので、順を入れ替える
    }
    case 'saturate': return call('clamp', [a[0], '0.0', '1.0']);
    case 'ddy':
      ctx.helpers.add('mme_flipY');
      return primary(`(-mme_flipY * dFdy(${a[0]}))`);
    case 'log10': return primary(`(log(${a[0]}) * 0.4342944819)`);
    case 'ldexp': return primary(`(${wrap(c[0], P.mul)} * exp2(${a[1]}))`);
    case 'isfinite': {
      const one = (x: string) => `!(isnan(${x}) || isinf(${x}))`;
      needPure(e.args, loc, ctx); // スカラーでも引数を 2 回書く
      if (p0.k !== 'vector') return code(one(a[0]), P.unary);
      return call(`bvec${p0.n}`, Array.from({ length: p0.n }, (_, i) => one(comp(c[0], i))));
    }
    case 'D3DCOLORtoUBYTE4': return call('ivec4', [`${wrap(c[0], P.post)}.zyxw * 255.001953`]);
    case 'all': case 'any': {
      // bool 以外は 0 と比べる
      const k = scalarKind(p0);
      if (k === 'bool') return p0.k === 'scalar' ? c[0] : call(name, a);
      const zero = scalarLit(0, k ?? 'float').s;
      if (p0.k === 'scalar') return code(`${wrap(c[0], P.rel)} != ${zero}`, P.eq);
      return call(name, [`notEqual(${a[0]}, ${glslType(p0)}(${zero}))`]);
    }
    case 'clip':
      unsupported(ctx, loc, t('clip は文としてだけ使えます'));
      return primary('0');
    default: throw new Error(`知らない組み込み関数: ${name}`);
  }
}

// tex2D → texture など。1D は 2D の 1 行 (vec2(x, 0.5))
function emitTexture(dim: string, suffix: string, e: ExprOf<'call'>, ctx: EmitContext): Code {
  const c = e.args.map(a => ex(a, ctx));
  const a = c.map(x => wrap(x, P.assign));
  const coord = (x: string) => (dim === '1D' ? `vec2(${x}, 0.5)` : x);
  const grad = (x: string) => (dim === '1D' ? `vec2(${x}, 0.0)` : x);
  if (suffix === 'grad' || (suffix === '' && a.length === 4)) return call('textureGrad', [a[0], coord(a[1]), grad(a[2]), grad(a[3])]);
  if (suffix === '') return call('texture', [a[0], coord(a[1])]);
  if (suffix === 'proj' && (dim === '2D' || dim === '3D')) return call('textureProj', a);
  // float4 の座標を分けて使う
  needPure([e.args[1]], e.loc, ctx);
  const q = wrap(c[1], P.post);
  const xyz = `${q}.${dim === '1D' ? 'x' : dim === '2D' ? 'xy' : 'xyz'}`;
  if (suffix === 'proj') return call('texture', [a[0], coord(`${xyz} / ${q}.w`)]);
  return call(suffix === 'lod' ? 'textureLod' : 'texture', [a[0], coord(xyz), `${q}.w`]);
}

// --- 文 ---
const IN = '  ';

// 中身を 1 段深く。ブロックなら中の文を並べる (外側の { } は呼び出し側が書く)
function inner(s: Stmt, ctx: EmitContext, indent: string): string {
  return s.kind === 'block' ? s.body.map(x => emitStmt(x, ctx, indent + IN)).join('') : emitStmt(s, ctx, indent + IN);
}

function declLine(d: VarDecl, init: string, indent: string, ctx: EmitContext): string {
  const ty = d.resolved;
  if (!ty) throw new Error(`型のない変数: ${d.name}`);
  noteType(ty, ctx);
  return `${indent}${glslType(ty)} ${glslName(d.name)} = ${init};\n`;
}

// 局所変数。初期値がなければ 0 (補足 9)。const は外す (GLSL の const は定数式の初期値しか取れない)
function emitVar(d: VarDecl, ctx: EmitContext, indent: string): string {
  const ty = d.resolved;
  if (ty?.k === 'sampler' || ty?.k === 'texture') {
    unsupported(ctx, d.loc, t('関数の中のサンプラーの変数には対応していません'));
    return '';
  }
  return declLine(d, d.init ? emitExpr(d.init, ctx) : zeroOf(ty as Type), indent, ctx);
}

function emitClip(e: ExprOf<'call'>, ctx: EmitContext, indent: string): string {
  const ty = (e.target?.kind === 'intrinsic' ? e.target.params[0] : null) ?? typeOf(e.args[0]);
  fragmentOnly('clip', e.loc, ctx);
  if (ty.k === 'matrix') unsupported(ctx, e.loc, t('行列に {name} を使うことには対応していません', { name: 'clip' }));
  const x = ex(e.args[0], ctx);
  const cond = ty.k === 'scalar' ? `${wrap(x, P.rel + 1)} < 0.0` : `any(lessThan(${x.s}, ${glslType(ty)}(0.0)))`;
  return `${indent}if (${cond}) discard;\n`;
}

export function emitStmt(s: Stmt, ctx: EmitContext, indent: string): string {
  const block = (body: Stmt) => `{\n${inner(body, ctx, indent)}${indent}}`;
  switch (s.kind) {
    case 'block': return `${indent}{\n${s.body.map(x => emitStmt(x, ctx, indent + IN)).join('')}${indent}}\n`;
    case 'var': return s.decls.map(d => emitVar(d, ctx, indent)).join('');
    case 'expr':
      if (s.expr.kind === 'call' && s.expr.target?.kind === 'intrinsic' && s.expr.callee === 'clip') return emitClip(s.expr, ctx, indent);
      return `${indent}${emitExpr(s.expr, ctx)};\n`;
    case 'if': {
      let out = `${indent}if (${emitExpr(s.cond, ctx)}) ${block(s.then)}`;
      let rest = s.else;
      while (rest?.kind === 'if') {
        out += ` else if (${emitExpr(rest.cond, ctx)}) ${block(rest.then)}`;
        rest = rest.else;
      }
      return `${out}${rest ? ` else ${block(rest)}` : ''}\n`;
    }
    case 'for': {
      // 初期化の変数はループの前で宣言する (ループのあとも見える。使い直すものは代入だけ)
      let before = '';
      let init = '';
      if (s.init?.kind === 'var') {
        const parts: string[] = [];
        for (const d of s.init.decls) {
          if (!d.reuses) before += emitVar({ ...d, init: null }, ctx, indent);
          if (d.init) parts.push(`${glslName(d.name)} = ${arg(d.init, ctx)}`);
        }
        init = parts.join(', ');
      } else if (s.init?.kind === 'expr') init = emitExpr(s.init.expr, ctx);
      const cond = s.cond ? emitExpr(s.cond, ctx) : '';
      const step = s.step ? emitExpr(s.step, ctx) : '';
      return `${before}${indent}for (${init}; ${cond}; ${step}) ${block(s.body)}\n`;
    }
    case 'while': return `${indent}while (${emitExpr(s.cond, ctx)}) ${block(s.body)}\n`;
    case 'do': return `${indent}do ${block(s.body)} while (${emitExpr(s.cond, ctx)});\n`;
    case 'switch': {
      let out = `${indent}switch (${emitExpr(s.value, ctx)}) {\n`;
      s.cases.forEach((c, i) => {
        if (c.value) {
          // case の値は定数 (型チェックで確かめた) なので数にして書く
          const v = ctx.checked.constEval(c.value);
          out += `${indent}case ${v?.kind === 'num' ? scalarLit(v.values[0], 'int').s : emitExpr(c.value, ctx)}:\n`;
        } else out += `${indent}default:\n`;
        out += c.body.map(x => emitStmt(x, ctx, indent + IN)).join('');
        if (i === s.cases.length - 1 && c.body.length === 0) out += `${indent + IN}break;\n`; // GLSL は最後のラベルのあとに文が要る
      });
      return `${out}${indent}}\n`;
    }
    case 'break': return `${indent}break;\n`;
    case 'continue': return `${indent}continue;\n`;
    case 'discard':
      fragmentOnly('discard', s.loc, ctx);
      return `${indent}discard;\n`;
    case 'return': return `${indent}return${s.value ? ` ${emitExpr(s.value, ctx)}` : ''};\n`;
    case 'empty': return '';
  }
}

// --- 関数 ---
function paramDecl(p: ParamNode, ty: Type, ctx: EmitContext): string {
  noteType(ty, ctx);
  const q = p.modifier === 'out' || p.modifier === 'inout' ? `${p.modifier} ` : '';
  return `${q}${glslType(ty)} ${glslName(p.name)}`;
}

function signature(f: FunctionInfo, ctx: EmitContext): string {
  noteType(f.ret, ctx);
  return `${glslType(f.ret)} ${glslName(f.decl.name)}(${f.decl.params.map((p, i) => paramDecl(p, f.params[i], ctx)).join(', ')})`;
}

// 使う関数 (roots と、そこから呼ぶもの) のプロトタイプをすべて書いてから、中身を書く
export function emitFunctions(roots: FunctionInfo[], ctx: EmitContext): string {
  for (const r of roots) ctx.usedFunctions.add(r);
  const protos: string[] = [];
  const bodies: string[] = [];
  const done = new Set<FunctionInfo>();
  // 中身を書くと呼ぶ関数が usedFunctions に増え、この繰り返しで続けて書かれる
  for (const f of ctx.usedFunctions) {
    if (done.has(f)) continue;
    done.add(f);
    const body = f.decl.body;
    if (!body) throw new Error(`中身のない関数: ${f.decl.name}`);
    const sig = signature(f, ctx);
    protos.push(`${sig};\n`);
    bodies.push(`${sig} {\n${inner(body, ctx, '')}}\n`);
  }
  return `${protos.join('')}\n${bodies.join('\n')}`;
}

// 使う構造体 (中で使う構造体も) を、宣言の順 (使うものが先に来る順) に
export function emitStructs(ctx: EmitContext): string {
  const need = new Set<string>();
  const visit = (ty: Type | undefined): void => {
    if (ty?.k === 'array') visit(ty.of);
    else if (ty?.k === 'struct' && !need.has(ty.name)) {
      need.add(ty.name);
      for (const f of ty.fields) visit(f.type);
    }
  };
  for (const name of ctx.usedStructs) visit(ctx.checked.structs.get(name));
  const out: string[] = [];
  for (const [name, ty] of ctx.checked.structs) {
    if (!need.has(name) || ty.k !== 'struct') continue;
    out.push(`struct ${glslName(name)} {\n${ty.fields.map(f => `${IN}${glslType(f.type)} ${glslName(f.name)};\n`).join('')}};\n`);
  }
  return out.join('\n');
}

// --- helpers ---
const FLOAT_TYPES = ['float', 'vec2', 'vec3', 'vec4'];
const INT_TYPES = ['int', 'ivec2', 'ivec3', 'ivec4'];
const HELPERS: [string, () => string][] = [
  // fmod は 0 に向けて切り捨てる (GLSL の mod は -∞ に向けて)
  ['mme_fmod', () => FLOAT_TYPES.map(T => `${T} mme_fmod(${T} a, ${T} b) { return a - b * trunc(a / b); }\n`).join('')],
  // SM3 の int は中身が float なので、float で割って 0 に向けて切り捨てる
  ['mme_idiv', () => INT_TYPES.map((T, i) => {
    const F = FLOAT_TYPES[i];
    return `${T} mme_idiv(${T} a, ${T} b) { return ${T}(trunc(${F}(a) / ${F}(b))); }\n`;
  }).join('')],
  ['mme_imod', () => INT_TYPES.map(T => `${T} mme_imod(${T} a, ${T} b) { return a - b * mme_idiv(a, b); }\n`).join('')],
  ['mme_sincos', () => FLOAT_TYPES.map(T => `void mme_sincos(${T} x, out ${T} s, out ${T} c) { s = sin(x); c = cos(x); }\n`).join('')],
  ['mme_lit', () => 'vec4 mme_lit(float l, float h, float m) { return vec4(1.0, max(l, 0.0), (l < 0.0 || h < 0.0) ? 0.0 : pow(h, m), 1.0); }\n'],
];

// helpers にあるものだけ (mme_imod は mme_idiv を使うので、その後に)
export function emitHelpers(ctx: EmitContext): string {
  return HELPERS.filter(([name]) => ctx.helpers.has(name)).map(([, body]) => body()).join('');
}
