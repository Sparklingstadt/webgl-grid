import { t } from '../i18n.ts';
import type { Expr, ParamNode, PassNode } from './ast.ts';
import type { CheckedEffect, EntryInfo, FunctionInfo, GlobalInfo } from './check.ts';
import type { AttributeRef, Program, UniformRef } from './desc.ts';
import { Diagnostics, type Diagnostic, type Loc } from './diagnostics.ts';
import {
  emitConst, emitExpr, emitFunctions, emitHelpers, emitStructs, exprChildren, forEachExpr, glslName, glslType, newEmitContext, noteType, zeroOf,
  type EmitContext,
} from './emit.ts';
import { typeName, type Type } from './types.ts';

// --- pass ごとの頂点・フラグメントのシェーダー (main・入出力・uniform の一覧) ---

const HEADER = ['#version 300 es', 'precision highp float;', 'precision highp int;', 'precision highp sampler2D;', 'precision highp sampler3D;', 'precision highp samplerCube;'];
const NUMBERED = /^(?:TEXCOORD|COLOR|BLENDWEIGHT|BLENDINDICES)(\d*)$/;
// 補足 5
const VPOS = 'vec2(gl_FragCoord.x - 0.5, (mme_flipY < 0.0 ? gl_FragCoord.y : mme_viewport.y - gl_FragCoord.y) - 0.5)';
const VFACE = '(gl_FrontFacing ? 1.0 : -1.0)';
const PAD = ['0.0', '0.0', '0.0', '1.0']; // 足りない成分は (0, 0, 0, 1)
const XYZW = 'xyzw';

// 大文字にし、TEXCOORD などに番号がなければ 0 を付け、ほかの POSITION0・NORMAL0 などの 0 は取る。
// D3D10 の SV_Position・SV_Target・SV_Depth は D3D9 の POSITION・COLORn・DEPTH にする (fxc の vs_3_0・ps_3_0 と同じ)
export function normalizeSemantic(s: string): string {
  const u = s.toUpperCase().replace(/^SV_(POSITION|DEPTH)$/, '$1').replace(/^SV_TARGET(\d*)$/, 'COLOR$1');
  const m = NUMBERED.exec(u);
  if (m) return m[1] === '' ? `${u}0` : u;
  return u.replace(/^(\D+)0$/, '$1');
}

type Stage = 'vertex' | 'fragment';

// 1 つの段階の書き出しで集めたもの
interface StageIo {
  attributes: string[]; // 頂点: a_ のセマンティクス (最初に使った順)
  varyings: string[]; // 頂点: 書いた v_ / フラグメント: 読んだ v_
  colors: number[]; // フラグメント: o_COLORn の n
  vpos: boolean;
}

interface StageResult { code: string; ctx: EmitContext; io: StageIo; flipY: boolean }

// n 成分の float の式 src (後ろに .x を付けられる式) から、型 ty の値を作る。作れない型は null
function fromFloats(src: string, n: number, ty: Type): string | null {
  if (ty.k !== 'scalar' && ty.k !== 'vector') return null;
  const m = ty.k === 'scalar' ? 1 : ty.n;
  const f = m === n ? src : m < n ? `${src}.${XYZW.slice(0, m)}` : `vec${m}(${src}, ${PAD.slice(n, m).join(', ')})`;
  return ty.s === 'float' ? f : `${glslType(ty)}(${f})`;
}

// 型 ty の式 e (後ろに .x を付けられる式) を vec4 にする。足りない成分は (0, 0, 0, 1)
function toVec4(e: string, ty: Type): string | null {
  if (ty.k !== 'scalar' && ty.k !== 'vector') return null;
  const m = ty.k === 'scalar' ? 1 : ty.n;
  const f = ty.s === 'float' ? e : `${m === 1 ? 'float' : `vec${m}`}(${e})`;
  return m === 4 ? f : `vec4(${f}, ${PAD.slice(m).join(', ')})`;
}

// 型 ty の式 e を float 1 つにする (ベクトルは x)
function toFloat(e: string, ty: Type): string | null {
  if (ty.k !== 'scalar' && ty.k !== 'vector') return null;
  const x = ty.k === 'vector' ? `${e}.x` : e;
  return ty.s === 'float' ? x : `float(${x})`;
}

// 値の型 (0 で埋められ、GLSL の変数にできる型)
const isValueType = (ty: Type): boolean => ['scalar', 'vector', 'matrix', 'array', 'struct'].includes(ty.k);

// 0 で埋めた値 (値の型でなければ誤りのあとなので何か書いておく)
function zero(ty: Type): string {
  return isValueType(ty) ? zeroOf(ty) : '0';
}

// --- 引数をどう読んでいるか (POSITION・PSIZE を実際に読むときだけ警告し、VPOS を読むときだけ mme_viewport を入れるため) ---
interface Reads { whole: boolean; fields: Set<string> }

// 引数 p のメンバー (p.field) を読んだか、丸ごと使ったか
function readsOf(fn: FunctionInfo, p: ParamNode): Reads {
  const r: Reads = { whole: false, fields: new Set() };
  const isP = (e: Expr) => e.kind === 'ident' && e.sym?.kind === 'local' && e.sym.decl === p;
  const visit = (e: Expr): void => {
    if (e.kind === 'member' && isP(e.object) && e.access?.kind === 'field') r.fields.add(e.access.name);
    else if (isP(e)) r.whole = true;
    else exprChildren(e).forEach(visit);
  };
  if (fn.decl.body) forEachExpr(fn.decl.body, visit);
  return r;
}

// --- main ---
function semanticError(diags: Diagnostics, loc: Loc, name: string): void {
  diags.error('FX-PASS-SEMANTIC', loc, t('セマンティクスのない入出力です: {name}', { name }));
}
function ioTypeError(diags: Diagnostics, loc: Loc, name: string, ty: Type): void {
  diags.error('FX-UNSUPPORTED', loc, t('入出力 {name} の型 {type} には対応していません', { name, type: typeName(ty) }));
}

// 入口の関数を呼び、出力をセマンティクスの行き先に書く main の中身 (1 行ずつ)
function mainLines(entry: EntryInfo, stage: Stage, vertexOut: string[], ctx: EmitContext, io: StageIo): string[] {
  const { diags } = ctx;
  const fn = entry.fn;
  const decl = fn.decl;
  const lines: string[] = [];

  // 入力の 1 つ (構造体ではないもの)
  const leafInput = (ty: Type, sem: string, name: string, loc: Loc, read: boolean): string => {
    let src: string | null;
    if (stage === 'vertex') {
      if (!io.attributes.includes(sem)) io.attributes.push(sem);
      src = fromFloats(`a_${sem}`, 4, ty);
    } else if (sem === 'VFACE') src = fromFloats(VFACE, 1, ty);
    else if (sem === 'VPOS') {
      if (!read) return zero(ty); // 読まなければ mme_viewport は要らない
      io.vpos = true;
      src = fromFloats(VPOS, 2, ty);
    } else if (sem === 'POSITION' || sem === 'PSIZE') {
      // 頂点からは来ない (頂点と同じ構造体を受けるのはよくあるので、実際に読むときだけ警告する)
      if (read) diags.warn('FX-WARN-SEMANTIC', loc, t('ピクセルシェーダーでは {semantic} を読めないので 0 にします: {name}', { semantic: sem, name }));
      return zero(ty);
    } else if (vertexOut.includes(sem)) {
      if (!io.varyings.includes(sem)) io.varyings.push(sem);
      src = fromFloats(`v_${sem}`, 4, ty);
    } else {
      diags.warn('FX-WARN-SEMANTIC', loc, t('頂点シェーダーが {semantic} を出していないので 0 にします: {name}', { semantic: sem, name }));
      return zero(ty);
    }
    if (src === null) ioTypeError(diags, loc, name, ty);
    return src ?? zero(ty);
  };

  // 入力 (in・inout の引数) の値。構造体はメンバーごとに作る。read は一番外のメンバーの名前から、読んでいるか
  const input = (ty: Type, sem: string | null, name: string, loc: Loc, read: (top: string | null) => boolean, top: string | null): string => {
    if (ty.k === 'struct') {
      noteType(ty, ctx);
      const fields = ty.fields.map(f => input(f.type, f.semantic, `${name}.${f.name}`, loc, read, top ?? f.name));
      return `${glslName(ty.name)}(${fields.join(', ')})`;
    }
    if (sem === null) {
      semanticError(diags, loc, name);
      return zero(ty);
    }
    // ピクセルの入力の SV_Position は VPOS (fxc の ps_3_0 と同じ)
    const s = stage === 'fragment' && sem.toUpperCase() === 'SV_POSITION' ? 'VPOS' : normalizeSemantic(sem);
    return leafInput(ty, s, name, loc, read(top));
  };

  // 出力 (戻り値・out・inout の引数) を、構造体ならメンバーごとに書く
  const outs: { ty: Type; sem: string | null; name: string; path: string; loc: Loc }[] = [];
  const writes: string[] = [];
  let position = false;
  const output = (ty: Type, sem: string | null, name: string, path: string, loc: Loc): void => {
    if (ty.k === 'struct') {
      for (const f of ty.fields) output(f.type, f.semantic, `${name}.${f.name}`, `${path}.${glslName(f.name)}`, loc);
      return;
    }
    if (sem === null) {
      semanticError(diags, loc, name);
      return;
    }
    const s = normalizeSemantic(sem);
    const color = /^COLOR(\d+)$/.exec(s);
    let line: string | null = null;
    if (stage === 'vertex' && s === 'POSITION') {
      // 深度の範囲 (0〜1 → −1〜1) と上下の向きを直す
      const p = toVec4(path, ty);
      if (p !== null) {
        line = `${position ? '' : 'vec4 '}mme_pos = ${p};\n  gl_Position = vec4(mme_pos.x, mme_pos.y * mme_flipY, 2.0 * mme_pos.z - mme_pos.w, mme_pos.w);`;
        position = true;
      }
    } else if (stage === 'vertex' && s === 'PSIZE') {
      const x = toFloat(path, ty);
      if (x !== null) line = `gl_PointSize = ${x};`;
    } else if (stage === 'vertex') {
      const v = toVec4(path, ty);
      if (v !== null) {
        if (!io.varyings.includes(s)) io.varyings.push(s);
        line = `v_${s} = ${v};`;
      }
    } else if (color) {
      const v = toVec4(path, ty);
      const n = Number(color[1]);
      if (v !== null) {
        if (!io.colors.includes(n)) io.colors.push(n);
        line = `o_COLOR${n} = ${v};`;
      }
    } else if (s === 'DEPTH') {
      const x = toFloat(path, ty);
      if (x !== null) line = `gl_FragDepth = ${x};`;
    } else {
      diags.error('FX-PASS-SEMANTIC', loc, t('ピクセルシェーダーの出力のセマンティクスは COLORn か DEPTH にしてください: {name}', { name }));
      return;
    }
    if (line === null) ioTypeError(diags, loc, name, ty);
    else writes.push(line);
  };

  const args: string[] = [];
  let uniform = 0;
  let local = 0;
  decl.params.forEach((p, i) => {
    const ty = fn.params[i];
    if (p.modifier === 'uniform') {
      const a = entry.uniformArgs[uniform++];
      if (!a) throw new Error(`uniform の引数がありません: ${p.name}`);
      args.push(emitExpr(a, ctx));
      return;
    }
    // 読んでいるか (フラグメントの POSITION・PSIZE・VPOS だけ見る)
    let reads: Reads | null = null;
    const read = (top: string | null): boolean => {
      reads ??= readsOf(fn, p);
      return reads.whole || (top !== null && reads.fields.has(top));
    };
    if (p.modifier === 'in') {
      args.push(input(ty, p.semantic, p.name, p.loc, read, null));
      return;
    }
    const name = `mme_p${local++}`;
    noteType(ty, ctx);
    lines.push(`${glslType(ty)} ${name} = ${p.modifier === 'inout' ? input(ty, p.semantic, p.name, p.loc, read, null) : zero(ty)};`);
    args.push(name);
    outs.push({ ty, sem: p.semantic, name: p.name, path: name, loc: p.loc });
  });
  const callExpr = `${glslName(decl.name)}(${args.join(', ')})`;
  if (fn.ret.k === 'void') lines.push(`${callExpr};`);
  else {
    noteType(fn.ret, ctx);
    lines.push(`${glslType(fn.ret)} mme_r = ${callExpr};`);
    outs.unshift({ ty: fn.ret, sem: decl.retSemantic, name: decl.name, path: 'mme_r', loc: decl.loc });
  }
  for (const o of outs) output(o.ty, o.sem, o.name, o.path, o.loc);
  if (stage === 'vertex' && !position) {
    diags.error('FX-PASS-SEMANTIC', decl.loc, t('頂点シェーダーが POSITION を出していません: {name}', { name: decl.name }));
  }
  return [...lines, ...writes];
}

// --- グローバル変数 ---
// 使う const・static のグローバル変数の宣言と、mme_init で計算する初期値 (どちらも宣言の順)。
// 後ろから見ていくので、初期値が使う (前で宣言した) 変数も拾える
function staticGlobals(checked: CheckedEffect, ctx: EmitContext): { decls: string[]; inits: string[] } {
  const decls: string[] = [];
  const inits: string[] = [];
  const globals = [...checked.globals.values()];
  for (let i = globals.length - 1; i >= 0; i--) {
    const g = globals[i];
    const name = g.decl.name;
    if (g.storage === 'uniform' || !ctx.usedGlobals.has(name)) continue;
    if (!isValueType(g.type)) {
      ctx.diags.error('FX-UNSUPPORTED', g.decl.loc, t('static の {type} には対応していません: {name}', { type: typeName(g.type), name }));
      continue;
    }
    noteType(g.type, ctx);
    const head = `${glslType(g.type)} ${glslName(name)}`;
    if (g.needsInit && g.decl.init) {
      decls.unshift(`${head} = ${zeroOf(g.type)};`);
      inits.unshift(`  ${glslName(name)} = ${emitExpr(g.decl.init, ctx)};`);
    } else {
      // 初期値は計算した値 (GLSL の全体の初期値は定数式でなければならないため。初期化の時点では同じ値)
      decls.unshift(`${g.storage === 'const' ? 'const ' : ''}${head} = ${constOf(g) ?? zeroOf(g.type)};`);
    }
  }
  return { decls, inits };
}

function constOf(g: GlobalInfo): string | null {
  return g.value?.kind === 'num' ? emitConst(g.value.values, g.type) : null;
}

// --- 1 つの段階 ---
const block = (lines: string[]): string => lines.map(l => `${l}\n`).join('');

function copyDiags(from: Diagnostics, to: Diagnostics): void {
  const locOf = (d: Diagnostic): Loc => ({ file: d.file, line: d.line, column: d.column, ...(d.includedFrom ? { includedFrom: d.includedFrom } : {}) });
  for (const d of from.warnings) to.warn(d.code, locOf(d), d.message);
  for (const d of from.errors) to.error(d.code, locOf(d), d.message);
}

function emitStage(checked: CheckedEffect, entry: EntryInfo, stage: Stage, vertexOut: string[], diags: Diagnostics): StageResult {
  // static の初期値が新しい関数を呼ぶときは、それも根にして書き直す (誤りは最後の回のものだけ残す)
  const roots: FunctionInfo[] = [entry.fn];
  for (;;) {
    const local = new Diagnostics();
    let result: StageResult;
    try {
      const ctx = newEmitContext(checked, stage, local);
      const io: StageIo = { attributes: [], varyings: [], colors: [], vpos: false };
      const body = mainLines(entry, stage, vertexOut, ctx, io);
      const functions = emitFunctions(roots, ctx);
      const emitted = new Set(ctx.usedFunctions);
      const { decls, inits } = staticGlobals(checked, ctx);
      const extra = [...ctx.usedFunctions].filter(f => !emitted.has(f));
      if (extra.length > 0) {
        roots.push(...extra);
        continue;
      }
      const flipY = stage === 'vertex' || ctx.helpers.has('mme_flipY') || io.vpos;
      const uniforms = [...checked.globals.values()]
        .filter(g => g.storage === 'uniform' && ctx.usedGlobals.has(g.decl.name))
        .map(g => `uniform ${glslType(g.type)} ${glslName(g.decl.name)};`);
      if (flipY) uniforms.push('uniform float mme_flipY;');
      if (io.vpos) uniforms.push('uniform vec2 mme_viewport;');
      const ios = stage === 'vertex'
        ? [...io.attributes.map(s => `in vec4 a_${s};`), ...io.varyings.map(s => `out vec4 v_${s};`)]
        : [...io.varyings.map(s => `in vec4 v_${s};`), ...[...io.colors].sort((a, b) => a - b).map(n => `layout(location = ${n}) out vec4 o_COLOR${n};`)];
      const init = inits.length > 0 ? `void mme_init() {\n${block(inits)}}\n` : '';
      const main = `void main() {\n${block([...(init ? ['mme_init();'] : []), ...body].map(l => `  ${l}`))}}\n`;
      const sections = [block(HEADER), emitStructs(ctx), block([...uniforms, ...ios]), block(decls), emitHelpers(ctx), functions, init, main];
      result = { code: sections.filter(s => s !== '').join('\n'), ctx, io, flipY };
    } catch (e) {
      copyDiags(local, diags);
      throw e;
    }
    copyDiags(local, diags);
    return result;
  }
}

// --- uniform の一覧 ---
// uniform に使う vec4 の数: スカラー・ベクトルは 1、floatRxC は R、配列は長さを掛ける
function vectorsOf(ty: Type): number {
  if (ty.k === 'matrix') return ty.rows;
  if (ty.k === 'array') return ty.length * vectorsOf(ty.of);
  return 1;
}

function uniformList(checked: CheckedEffect, vs: StageResult, ps: StageResult): UniformRef[] {
  const list: UniformRef[] = [];
  const stagesOf = (used: (r: StageResult) => boolean): UniformRef['stages'] => {
    const s: UniformRef['stages'] = [];
    if (used(vs)) s.push('vertex');
    if (used(ps)) s.push('fragment');
    return s;
  };
  for (const g of checked.globals.values()) {
    if (g.storage !== 'uniform') continue;
    const name = g.decl.name;
    const stages = stagesOf(r => r.ctx.usedGlobals.has(name));
    if (stages.length === 0) continue;
    // 向きの決まらなかった sampler は GLSL と同じく 2D
    const type = g.type.k === 'sampler' && g.type.dim === null ? 'sampler2D' : typeName(g.type);
    list.push({ name, glslName: glslName(name), type, kind: g.type.k === 'sampler' ? 'sampler' : 'value', stages });
  }
  list.push({ name: 'mme_flipY', glslName: 'mme_flipY', type: 'float', kind: 'builtin', stages: stagesOf(r => r.flipY) });
  if (ps.io.vpos) list.push({ name: 'mme_viewport', glslName: 'mme_viewport', type: 'float2', kind: 'builtin', stages: ['fragment'] });
  return list;
}

function vectorCount(checked: CheckedEffect, uniforms: UniformRef[]): number {
  let n = 0;
  for (const u of uniforms) {
    if (u.kind === 'sampler') continue;
    const g = u.kind === 'value' ? checked.globals.get(u.name) : undefined;
    n += g ? vectorsOf(g.type) : 1;
  }
  return n;
}

// pass の Program。vs も ps もなければ null。片方だけなら FX-UNSUPPORTED
export function emitProgram(checked: CheckedEffect, pass: PassNode, diags: Diagnostics): Program | null {
  const entry = checked.entries.get(pass);
  if (!entry || (!entry.vs && !entry.ps)) return null;
  if (!entry.vs || !entry.ps) {
    // もう片方の compile が型チェックで落ちたときは、その誤りが出ている
    const other = entry.vs ? 'pixelshader' : 'vertexshader';
    if (!pass.states.some(s => s.value.kind === 'compile' && s.name.toLowerCase() === other)) {
      diags.error('FX-UNSUPPORTED', pass.loc, t('頂点シェーダーかピクセルシェーダーの片方だけの pass には対応していません'));
    }
    return null;
  }
  const vs = emitStage(checked, entry.vs, 'vertex', [], diags);
  const ps = emitStage(checked, entry.ps, 'fragment', vs.io.varyings, diags);
  const uniforms = uniformList(checked, vs, ps);
  const attributes: AttributeRef[] = vs.io.attributes.map(s => ({ semantic: s, glslName: `a_${s}`, type: 'float4' }));
  const outputs = ps.io.colors.length === 0 ? 0 : Math.max(...ps.io.colors) + 1;
  return { vertex: vs.code, fragment: ps.code, uniforms, attributes, outputs, uniformVectors: vectorCount(checked, uniforms) };
}
