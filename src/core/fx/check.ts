import { t } from '../i18n.ts';
import type {
  AnnotationNode, Expr, FileNode, FunctionDecl, ParamNode, PassNode, ShaderCompile, Stmt, StructDecl, TypedefDecl, TypeRef, VarDecl,
} from './ast.ts';
import { evalConst, type ConstEnv, type ConstValue } from './consteval.ts';
import type { DiagCode, Diagnostics, Loc } from './diagnostics.ts';
import { isIntrinsic, resolveIntrinsic, UNSUPPORTED_INTRINSICS } from './intrinsics.ts';
import {
  arithmeticScalar, binaryResultType, componentCount, conversion, sameType, scalarKind, typeName, vectorOf, withScalar, type Scalar, type Type,
} from './types.ts';

export type { ConstValue } from './consteval.ts';

// --- 型チェック。名前の解決・式の型・暗黙の型変換 (convert)・定数の計算。
// 関数の中身は pass から (呼び出しをたどって) 使われるものだけ確かめる ---

export interface GlobalInfo { decl: VarDecl; type: Type; storage: 'uniform' | 'static' | 'const'; value: ConstValue | null; needsInit: boolean }
// needsInit: static で、初期値が定数に計算できない (main の最初で計算する)
export interface FunctionInfo { decl: FunctionDecl; params: Type[]; ret: Type }
export interface EntryInfo { fn: FunctionInfo; profile: string; uniformArgs: Expr[] } // uniformArgs は型チェック済み (引数の型に変換済み)
export interface CheckedEffect {
  file: FileNode;
  globals: Map<string, GlobalInfo>; // 宣言の順
  structs: Map<string, Type>;
  functions: FunctionInfo[]; // pass から使われる (中身を確かめた) 関数だけ
  entries: Map<PassNode, { vs: EntryInfo | null; ps: EntryInfo | null }>;
  constEval(e: Expr): ConstValue | null;
}

type ExprOf<K extends Expr['kind']> = Extract<Expr, { kind: K }>;
type Local = VarDecl | ParamNode;

// 型の分からない式 (誤りを出したあと)。この型の式からは、その先の誤りを出さない
const ERR: Type = { k: 'void' };
const BOOL: Type = { k: 'scalar', s: 'bool' };
const INT: Type = { k: 'scalar', s: 'int' };
const PROFILES = new Set(['vs_2_0', 'vs_2_a', 'vs_3_0', 'ps_2_0', 'ps_2_a', 'ps_2_b', 'ps_3_0']);
const ARITHMETIC = new Set(['+', '-', '*', '/', '%']);
// 組み込み関数の out の引数の位置
const INTRINSIC_OUT: Record<string, number[]> = { modf: [1], sincos: [1, 2] };

// .xyzw か .rgba (混ぜない)、1〜4 文字、成分の数 n の中
function swizzleOf(name: string, n: number): number[] | null {
  if (name.length < 1 || name.length > 4) return null;
  for (const set of ['xyzw', 'rgba']) {
    const comps = [...name].map(c => set.indexOf(c));
    if (comps.every(i => i >= 0)) return comps.every(i => i < n) ? comps : null;
  }
  return null;
}

// ._m01_m30 (0 から) か ._12_41 (1 から)。行と列は 0 から数えて返す
function matrixElemsOf(name: string, rows: number, cols: number): [number, number][] | null {
  const base = /^(?:_m[0-3][0-3])+$/.test(name) ? 0 : /^(?:_[1-4][1-4])+$/.test(name) ? 1 : -1;
  if (base < 0) return null;
  const elems: [number, number][] = [];
  for (const m of name.matchAll(/_m?(\d)(\d)/g)) {
    const r = Number(m[1]) - base;
    const c = Number(m[2]) - base;
    if (r >= rows || c >= cols) return null;
    elems.push([r, c]);
  }
  return elems.length <= 4 ? elems : null;
}

const hasDuplicate = (xs: unknown[]) => new Set(xs.map(String)).size !== xs.length;
const hasStruct = (ty: Type): boolean => ty.k === 'struct' || (ty.k === 'array' && hasStruct(ty.of));

class Checker {
  readonly globals = new Map<string, GlobalInfo>();
  readonly structs = new Map<string, Type>();
  readonly functions: FunctionInfo[] = []; // 使うと分かった順 (この順に中身を確かめる)
  private readonly diags: Diagnostics;
  private readonly env: ConstEnv;
  private readonly typedefs = new Map<string, Type>();
  private readonly overloads = new Map<string, FunctionInfo[]>();
  private readonly firstUse = new Map<FunctionInfo, Loc>();
  // ユーザーの関数の呼び出し (プロトタイプのあとに中身が来ても、最後に中身の宣言を指し直す)
  private readonly calls: { e: ExprOf<'call'>; info: FunctionInfo }[] = [];
  private scopes: Map<string, Local>[] = []; // 空ならグローバルの文脈
  private fn: { ret: Type; loops: number; switches: number } | null = null;

  constructor(diags: Diagnostics) {
    this.diags = diags;
    this.env = {
      global: name => {
        const g = this.globals.get(name);
        return g && g.storage !== 'uniform' ? g.value : null;
      },
      resolveType: ref => {
        const ty = this.baseType(ref, false);
        return ty === ERR ? null : ty;
      },
    };
  }

  constEval(e: Expr): ConstValue | null {
    return evalConst(e, this.env);
  }

  private error(code: DiagCode, loc: Loc, message: string): void {
    this.diags.error(code, loc, message);
  }
  private mismatch(loc: Loc, from: Type, to: Type): void {
    this.error('FX-TYPE-MISMATCH', loc, t('型が合いません: {from} を {to} にできません', { from: typeName(from), to: typeName(to) }));
  }
  // 誤りを出さずに済んだか (f の中で誤りが増えなければ true)
  private clean(f: () => void): boolean {
    const before = this.diags.errors.length;
    f();
    return this.diags.errors.length === before;
  }

  run(file: FileNode): CheckedEffect['entries'] {
    const entries: CheckedEffect['entries'] = new Map();
    const finish: (() => void)[] = [];
    const passes: { annotations: AnnotationNode[]; pass?: PassNode }[] = [];
    for (const item of file.items) {
      switch (item.kind) {
        case 'struct': this.declareStruct(item); break;
        case 'typedef': this.declareTypedef(item); break;
        case 'global': this.declareGlobal(item.decl); break;
        case 'function': this.registerFunction(item); break;
        case 'technique':
          passes.push({ annotations: item.annotations }, ...item.passes.map(pass => ({ annotations: pass.annotations, pass })));
          break;
      }
    }
    for (const { annotations, pass } of passes) {
      this.checkAnnotations(annotations);
      if (pass) entries.set(pass, this.checkPass(pass, finish));
    }
    for (let i = 0; i < this.functions.length; i++) this.checkFunction(this.functions[i]);
    for (const f of finish) f();
    for (const { e, info } of this.calls) e.target = { kind: 'function', fn: info.decl };
    return entries;
  }

  // --- 型 ---
  private baseType(ref: TypeRef, report: boolean): Type {
    if (ref.kind === 'named') {
      const ty = this.structs.get(ref.name) ?? this.typedefs.get(ref.name);
      if (ty) return ty;
      if (report) this.error('FX-TYPE-UNDEFINED', ref.loc, t('名前 {name} が見つかりません', { name: ref.name }));
      return ERR;
    }
    const ty = ref.type;
    if (ty.k === 'matrix' && (ty.s !== 'float' || ty.rows === 1 || ty.cols === 1)) {
      if (report) this.error('FX-UNSUPPORTED', ref.loc, t('この行列の型には対応していません: {type}', { type: typeName(ty) }));
      return ERR;
    }
    return ty;
  }

  // report が false なら誤りを出さない (使うか分からない関数の引数)。unsized は [] の配列の大きさ
  private resolveType(ref: TypeRef, dims: (Expr | null)[], report: boolean, unsized?: number): Type {
    const base = this.baseType(ref, report);
    if (dims.length === 0 || base === ERR) return base;
    if (dims.length > 1) {
      if (report) this.error('FX-UNSUPPORTED', ref.loc, t('配列の配列には対応していません'));
      return ERR;
    }
    const d = dims[0];
    let length = unsized;
    if (d) {
      const v = this.constEval(d);
      length = v?.kind === 'num' && v.type.k === 'scalar' ? v.values[0] : undefined;
    }
    if (length === undefined || !Number.isInteger(length) || length < 1) {
      if (report) this.error('FX-TYPE-CONST', d?.loc ?? ref.loc, t('配列の大きさは正の整数の定数にしてください'));
      return ERR;
    }
    return { k: 'array', of: base, length };
  }

  private unsizedLength(decl: VarDecl): number | undefined {
    return decl.arrayDims.length === 1 && decl.arrayDims[0] === null && decl.init?.kind === 'initList' ? decl.init.items.length : undefined;
  }

  // --- 宣言 ---
  private redefined(loc: Loc, name: string): void {
    this.error('FX-TYPE-REDEFINED', loc, t('{name} はもう定義されています', { name }));
  }

  private declareStruct(s: StructDecl): void {
    if (this.structs.has(s.name) || this.typedefs.has(s.name)) this.redefined(s.loc, s.name);
    const fields = s.fields.map(f => ({ name: f.name, type: this.resolveType(f.type, f.arrayDims, true), semantic: f.semantic }));
    this.structs.set(s.name, { k: 'struct', name: s.name, fields });
  }

  private declareTypedef(d: TypedefDecl): void {
    if (this.structs.has(d.name) || this.typedefs.has(d.name)) this.redefined(d.loc, d.name);
    this.typedefs.set(d.name, this.resolveType(d.type, d.arrayDims, true));
  }

  private declareGlobal(decl: VarDecl): void {
    const declared = this.resolveType(decl.type, decl.arrayDims, true, this.unsizedLength(decl));
    decl.resolved = declared;
    let type = declared;
    let value: ConstValue | null = null;
    let initOk = true;
    const init = decl.init;
    if (init && declared !== ERR) {
      initOk = this.clean(() => {
        if (declared.k === 'sampler') type = this.checkSamplerState(decl, init, declared);
        else if (init.kind === 'samplerState') this.error('FX-TYPE-MISMATCH', init.loc, t('sampler_state はサンプラーの初期値にだけ使えます'));
        else {
          decl.init = this.checkInit(init, declared);
          value = this.constEval(decl.init);
        }
      });
    }
    const isStatic = decl.storage.includes('static');
    const storage = isStatic ? 'static' : decl.storage.includes('const') && decl.semantic === null && value !== null ? 'const' : 'uniform';
    if (storage === 'uniform' && decl.init && value === null && declared !== ERR && declared.k !== 'sampler' && initOk) {
      this.error('FX-TYPE-CONST', decl.init.loc, t('uniform の初期値は定数にしてください: {name}', { name: decl.name }));
    }
    if (storage === 'uniform' && hasStruct(declared)) {
      this.error('FX-UNSUPPORTED', decl.loc, t('構造体の uniform には対応していません: {name}', { name: decl.name }));
    }
    this.checkAnnotations(decl.annotations);
    if (this.globals.has(decl.name)) {
      this.redefined(decl.loc, decl.name);
      return;
    }
    this.globals.set(decl.name, { decl, type, storage, value, needsInit: isStatic && decl.init !== null && value === null });
  }

  // sampler_state の Texture からサンプラーの向きを決める
  private checkSamplerState(decl: VarDecl, init: Expr, declared: Type & { k: 'sampler' }): Type {
    if (init.kind !== 'samplerState') {
      const ty = this.checkExpr(init);
      if (ty !== ERR) this.mismatch(init.loc, ty, declared);
      return declared;
    }
    init.type = declared;
    let dim = declared.dim;
    for (const st of init.states) {
      if (st.name.toLowerCase() !== 'texture') continue;
      const v = st.value;
      if (v.kind !== 'ident') {
        this.error('FX-TYPE-MISMATCH', st.loc, t('Texture にはテクスチャの名前を書いてください'));
        continue;
      }
      const g = this.globals.get(v.name);
      if (!g) {
        this.error('FX-TYPE-UNDEFINED', v.loc, t('名前 {name} が見つかりません', { name: v.name }));
        continue;
      }
      if (g.type.k !== 'texture') {
        this.error('FX-TYPE-MISMATCH', v.loc, t('{name} はテクスチャではありません', { name: v.name }));
        continue;
      }
      v.sym = { kind: 'global', name: v.name };
      v.type = g.type;
      const td = g.type.dim;
      if (td !== null && dim !== null && td !== dim) this.samplerMismatch(v.loc, decl.name, dim, td);
      else if (td !== null) dim = td;
    }
    return { k: 'sampler', dim };
  }

  private samplerMismatch(loc: Loc, name: string, a: string, b: string): void {
    this.error('FX-TYPE-MISMATCH', loc, t('サンプラー {name} の向きが合いません ({a} と {b})', { name, a, b }));
  }

  // 注釈の値は定数でなければ FX-TYPE-CONST
  private checkAnnotations(list: AnnotationNode[]): void {
    for (const a of list) {
      const ty = this.resolveType(a.type, [], true);
      if (ty === ERR) continue;
      if (this.clean(() => { a.value = this.checkInit(a.value, ty); }) && this.constEval(a.value) === null) {
        this.error('FX-TYPE-CONST', a.value.loc, t('注釈の値は定数にしてください: {name}', { name: a.name }));
      }
    }
  }

  // 関数の名前と引数の型を覚える (プロトタイプと中身は 1 つにまとめる)。誤りはまだ出さない
  private registerFunction(decl: FunctionDecl): void {
    const params = decl.params.map(p => this.resolveType(p.type, p.arrayDims, false));
    const ret = this.resolveType(decl.ret, [], false);
    const list = this.overloads.get(decl.name) ?? [];
    const same = list.find(f => f.params.length === params.length && f.params.every((p, i) => sameType(p, params[i])));
    if (same) {
      if (same.decl.body === null && decl.body !== null) same.decl = decl;
      return;
    }
    list.push({ decl, params, ret });
    this.overloads.set(decl.name, list);
  }

  private useFunction(info: FunctionInfo, loc: Loc): void {
    if (this.firstUse.has(info)) return;
    this.firstUse.set(info, loc);
    this.functions.push(info);
  }

  private checkFunction(info: FunctionInfo): void {
    const decl = info.decl;
    if (!decl.body) {
      this.error('FX-TYPE-UNDEFINED', this.firstUse.get(info) ?? decl.loc, t('関数 {name} の中身がありません', { name: decl.name }));
      return;
    }
    info.params = decl.params.map(p => (p.resolved = this.resolveType(p.type, p.arrayDims, true)));
    info.ret = this.resolveType(decl.ret, [], true);
    // 既定値はグローバル変数だけを見る
    decl.params.forEach((p, i) => {
      if (p.init && info.params[i] !== ERR) p.init = this.checkInit(p.init, info.params[i]);
    });
    const scope = new Map<string, Local>();
    for (const p of decl.params) {
      if (scope.has(p.name)) this.redefined(p.loc, p.name);
      scope.set(p.name, p);
    }
    this.scopes = [scope];
    this.fn = { ret: info.ret, loops: 0, switches: 0 };
    this.checkStmt(decl.body);
    this.scopes = [];
    this.fn = null;
  }

  // --- pass ---
  private checkPass(pass: PassNode, finish: (() => void)[]): { vs: EntryInfo | null; ps: EntryInfo | null } {
    const entry: { vs: EntryInfo | null; ps: EntryInfo | null } = { vs: null, ps: null };
    for (const st of pass.states) {
      if (st.value.kind !== 'compile') continue;
      const name = st.name.toLowerCase();
      const stage = name === 'vertexshader' ? 'vs' : name === 'pixelshader' ? 'ps' : null;
      if (!stage) {
        this.error('FX-UNSUPPORTED', st.loc, t('compile は VertexShader・PixelShader にだけ使えます'));
        continue;
      }
      entry[stage] = this.checkEntry(st.value, stage, finish);
    }
    return entry;
  }

  // compile の関数を、uniform の引数が合うものから選ぶ
  private checkEntry(sc: ShaderCompile, stage: 'vs' | 'ps', finish: (() => void)[]): EntryInfo | null {
    if (!PROFILES.has(sc.profile)) {
      this.error('FX-UNSUPPORTED', sc.loc, t('対応していないプロファイルです: {profile}', { profile: sc.profile }));
      return null;
    }
    if (!sc.profile.startsWith(stage)) {
      this.error('FX-PASS-FUNCTION', sc.loc, t('プロファイル {profile} はこのシェーダーには使えません', { profile: sc.profile }));
      return null;
    }
    const types: Type[] = [];
    if (!this.clean(() => types.push(...sc.args.map(a => this.checkExpr(a))))) return null;
    const cands = this.overloads.get(sc.fn) ?? [];
    let best: { info: FunctionInfo; uniforms: number[] } | null = null;
    let bestCost = Infinity;
    for (const info of cands) {
      const uniforms = info.decl.params.flatMap((p, i) => (p.modifier === 'uniform' ? [i] : []));
      const required = uniforms.filter(i => info.decl.params[i].init === null).length;
      if (types.length < required || types.length > uniforms.length) continue;
      let cost = 0;
      for (let k = 0; k < types.length; k++) cost += conversion(types[k], info.params[uniforms[k]])?.cost ?? Infinity;
      if (cost < bestCost) {
        best = { info, uniforms };
        bestCost = cost;
      }
    }
    if (!best) {
      const message = cands.length === 0
        ? t('pass の関数 {name} が見つかりません', { name: sc.fn })
        : t('pass の関数 {name} の uniform の引数が合いません', { name: sc.fn });
      this.error('FX-PASS-FUNCTION', sc.loc, message);
      return null;
    }
    const { info, uniforms } = best;
    sc.args = sc.args.map((a, k) => this.coerce(a, info.params[uniforms[k]]));
    this.useFunction(info, sc.loc);
    const result: EntryInfo = { fn: info, profile: sc.profile, uniformArgs: [...sc.args] };
    // 省いた引数は既定値で埋める (関数の中身を確かめて、既定値を変換したあとで)
    const given = sc.args.length;
    if (given < uniforms.length) {
      finish.push(() => result.uniformArgs.push(...uniforms.slice(given).map(i => info.decl.params[i].init as Expr)));
    }
    return result;
  }

  // --- 文 ---
  private lookup(name: string): Local | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const l = this.scopes[i].get(name);
      if (l) return l;
    }
    return undefined;
  }

  private inScope(s: Stmt): void {
    this.scopes.push(new Map());
    this.checkStmt(s);
    this.scopes.pop();
  }

  private loop(body: Stmt): void {
    const fn = this.fn as NonNullable<Checker['fn']>;
    fn.loops++;
    this.inScope(body);
    fn.loops--;
  }

  private checkStmt(s: Stmt): void {
    const fn = this.fn as NonNullable<Checker['fn']>;
    switch (s.kind) {
      case 'block':
        this.scopes.push(new Map());
        for (const x of s.body) this.checkStmt(x);
        this.scopes.pop();
        break;
      case 'var': for (const d of s.decls) this.declareLocal(d, false); break;
      case 'expr': this.checkExpr(s.expr); break;
      case 'if':
        s.cond = this.condition(s.cond);
        this.inScope(s.then);
        if (s.else) this.inScope(s.else);
        break;
      case 'for':
        // 初期化の変数はループのあとも見える (補足 10)
        if (s.init?.kind === 'var') for (const d of s.init.decls) this.declareLocal(d, true);
        else if (s.init) this.checkStmt(s.init);
        if (s.cond) s.cond = this.condition(s.cond);
        if (s.step) this.checkExpr(s.step);
        this.loop(s.body);
        break;
      case 'while':
        s.cond = this.condition(s.cond);
        this.loop(s.body);
        break;
      case 'do':
        this.loop(s.body);
        s.cond = this.condition(s.cond);
        break;
      case 'switch': {
        const ty = this.checkExpr(s.value);
        if (ty !== ERR && ty.k !== 'scalar') this.mismatch(s.value.loc, ty, INT);
        else s.value = this.coerce(s.value, INT);
        fn.switches++;
        this.scopes.push(new Map());
        for (const c of s.cases) {
          const label = c.value;
          if (label) {
            this.checkExpr(label);
            c.value = this.coerce(label, INT);
            if (label.type !== ERR && this.constEval(c.value) === null) this.error('FX-TYPE-CONST', label.loc, t('case の値は定数の整数にしてください'));
          }
          for (const x of c.body) this.checkStmt(x);
        }
        this.scopes.pop();
        fn.switches--;
        break;
      }
      case 'break':
        if (fn.loops + fn.switches === 0) this.error('FX-TYPE-MISMATCH', s.loc, t('break はループと switch の中でだけ使えます'));
        break;
      case 'continue':
        if (fn.loops === 0) this.error('FX-TYPE-MISMATCH', s.loc, t('continue はループの中でだけ使えます'));
        break;
      case 'return': {
        if (fn.ret === ERR) break;
        if (s.value === null) {
          if (fn.ret.k !== 'void') this.error('FX-TYPE-MISMATCH', s.loc, t('値を返してください ({type})', { type: typeName(fn.ret) }));
        } else if (fn.ret.k === 'void') {
          this.checkExpr(s.value);
          this.error('FX-TYPE-MISMATCH', s.loc, t('void の関数は値を返せません'));
        } else {
          this.checkExpr(s.value);
          s.value = this.coerce(s.value, fn.ret);
        }
        break;
      }
      case 'discard': case 'empty': break;
    }
  }

  // if・ループの条件はスカラーにして bool へ
  private condition(e: Expr): Expr {
    const ty = this.checkExpr(e);
    if (ty === ERR) return e;
    if (ty.k !== 'scalar') {
      this.error('FX-TYPE-MISMATCH', e.loc, t('条件はスカラーにしてください ({type})', { type: typeName(ty) }));
      return e;
    }
    return this.coerce(e, BOOL);
  }

  // 2 つ目の for (int i …) が同じ名前・同じ型なら、前の変数を使い直す (reuses)
  private declareLocal(decl: VarDecl, forInit: boolean): void {
    if (decl.storage.includes('static')) this.error('FX-UNSUPPORTED', decl.loc, t('関数の中の static 変数には対応していません'));
    const ty = this.resolveType(decl.type, decl.arrayDims, true, this.unsizedLength(decl));
    decl.resolved = ty;
    if (decl.init && ty !== ERR) {
      if (decl.init.kind === 'samplerState') this.error('FX-TYPE-MISMATCH', decl.init.loc, t('sampler_state はサンプラーの初期値にだけ使えます'));
      else decl.init = this.checkInit(decl.init, ty);
    }
    const scope = this.scopes[this.scopes.length - 1];
    const prev = scope.get(decl.name);
    if (!prev) scope.set(decl.name, decl);
    else if (forInit && 'storage' in prev && prev.resolved && sameType(prev.resolved, ty)) decl.reuses = prev;
    else this.redefined(decl.loc, decl.name);
  }

  // 初期値 (式か { } のリスト) を型 ty に合わせる
  private checkInit(init: Expr, ty: Type): Expr {
    if (init.kind !== 'initList') {
      this.checkExpr(init);
      return this.coerce(init, ty);
    }
    init.type = ty;
    const count = (want: number, got: number) =>
      this.error('FX-TYPE-MISMATCH', init.loc, t('初期値の数が合いません (必要 {want}・指定 {got})', { want, got }));
    const s = scalarKind(ty);
    if (ty.k === 'array' || ty.k === 'struct') {
      const parts = ty.k === 'array' ? Array.from({ length: ty.length }, () => ty.of) : ty.fields.map(f => f.type);
      if (init.items.length !== parts.length) count(parts.length, init.items.length);
      else init.items = init.items.map((item, i) => this.checkInit(item, parts[i]));
    } else if (s !== null) {
      let total = 0;
      init.items = init.items.map(item => {
        const it = item.kind === 'initList' ? ERR : this.checkExpr(item);
        if (item.kind === 'initList' || (it !== ERR && scalarKind(it) === null)) {
          this.error('FX-TYPE-MISMATCH', item.loc, t('{type} の初期値のリストには数を並べてください', { type: typeName(ty) }));
        }
        if (it === ERR || scalarKind(it) === null) {
          total = NaN;
          return item;
        }
        total += componentCount(it);
        return this.coerce(item, withScalar(it, s));
      });
      if (!Number.isNaN(total) && total !== componentCount(ty)) count(componentCount(ty), total);
    } else {
      this.error('FX-TYPE-MISMATCH', init.loc, t('{type} には初期値のリストを使えません', { type: typeName(ty) }));
    }
    return init;
  }

  // --- 式 ---
  private checkExpr(e: Expr): Type {
    const ty = this.infer(e);
    e.type = ty;
    return ty;
  }

  // 暗黙の型変換。型が違えば convert を挟む (サンプラーは挟まず、向きを覚える)。切り詰めは警告
  private coerce(e: Expr, to: Type): Expr {
    const from = e.type ?? ERR;
    if (from === ERR || to === ERR || sameType(from, to)) return e;
    const c = conversion(from, to);
    if (!c) {
      this.mismatch(e.loc, from, to);
      return e;
    }
    if (from.k === 'sampler' || from.k === 'texture') {
      this.noteSampler(e, to);
      return e;
    }
    if (c.truncates) this.diags.warn('FX-WARN-TRUNCATION', e.loc, t('{from} を {to} に切り詰めます', { from: typeName(from), to: typeName(to) }));
    return { kind: 'convert', to, value: e, loc: e.loc, type: to };
  }

  // 向きの決まっていないグローバルのサンプラーを、最初に使った関数の向きにする
  private noteSampler(e: Expr, to: Type): void {
    if (to.k !== 'sampler' || to.dim === null || e.kind !== 'ident' || e.sym?.kind !== 'global') return;
    const g = this.globals.get(e.sym.name);
    if (g?.type.k !== 'sampler') return;
    if (g.type.dim === null) g.type = { k: 'sampler', dim: to.dim };
    else if (g.type.dim !== to.dim) this.samplerMismatch(e.loc, e.name, g.type.dim, to.dim);
  }

  private infer(e: Expr): Type {
    switch (e.kind) {
      case 'number': return { k: 'scalar', s: e.isFloat ? 'float' : 'int' };
      case 'bool': return BOOL;
      case 'string': return { k: 'string' };
      case 'ident': return this.inferIdent(e);
      case 'unary': return this.inferUnary(e);
      case 'binary': return this.inferBinary(e);
      case 'assign': return this.inferAssign(e);
      case 'ternary': return this.inferTernary(e);
      case 'call': return this.inferCall(e);
      case 'construct': return this.inferConstruct(e);
      case 'cast': return this.inferCast(e);
      case 'member': return this.inferMember(e);
      case 'index': return this.inferIndex(e);
      case 'sequence': {
        let last = ERR;
        for (const x of e.items) last = this.checkExpr(x);
        return last;
      }
      case 'convert':
        this.checkExpr(e.value);
        return e.to;
      case 'initList':
        this.error('FX-TYPE-MISMATCH', e.loc, t('初期値のリストは変数の初期値にだけ使えます'));
        return ERR;
      case 'samplerState':
        this.error('FX-TYPE-MISMATCH', e.loc, t('sampler_state はサンプラーの初期値にだけ使えます'));
        return ERR;
    }
  }

  private inferIdent(e: ExprOf<'ident'>): Type {
    const local = this.lookup(e.name);
    if (local) {
      e.sym = { kind: 'local', decl: local };
      return local.resolved ?? ERR;
    }
    const g = this.globals.get(e.name);
    if (g) {
      e.sym = { kind: 'global', name: e.name };
      return g.decl.resolved ?? ERR;
    }
    this.error('FX-TYPE-UNDEFINED', e.loc, t('名前 {name} が見つかりません', { name: e.name }));
    return ERR;
  }

  private opError(loc: Loc, op: string, types: Type[]): Type {
    this.error('FX-TYPE-MISMATCH', loc, t('演算子 {op} は {types} に使えません', { op, types: types.map(typeName).join(', ') }));
    return ERR;
  }

  private inferUnary(e: ExprOf<'unary'>): Type {
    const ty = this.checkExpr(e.operand);
    if (ty === ERR) return ERR;
    const s = scalarKind(ty);
    if (s === null || e.op === '~') return this.opError(e.loc, e.op, [ty]);
    switch (e.op) {
      case '!':
        e.operand = this.coerce(e.operand, withScalar(ty, 'bool'));
        return withScalar(ty, 'bool');
      case '++': case '--':
        this.checkLvalue(e.operand);
        return s === 'bool' ? this.opError(e.loc, e.op, [ty]) : ty;
      default: {
        if (s !== 'bool') return ty;
        const to = withScalar(ty, 'int');
        e.operand = this.coerce(e.operand, to);
        return to;
      }
    }
  }

  // 算術はスカラーの側を広げない (成分の種類だけ合わせる)。比較と論理は結果の形に広げる (GLSL の lessThan などは同じ形を取る)
  private inferBinary(e: ExprOf<'binary'>): Type {
    const a = this.checkExpr(e.left);
    const b = this.checkExpr(e.right);
    if (a === ERR || b === ERR) return ERR;
    const r = binaryResultType(e.op, a, b);
    const ka = scalarKind(a);
    const kb = scalarKind(b);
    if (!r || ka === null || kb === null) return this.opError(e.loc, e.op, [a, b]);
    const arithmetic = ARITHMETIC.has(e.op);
    let s: Scalar;
    if (arithmetic) s = scalarKind(r.type) as Scalar;
    else if (e.op === '&&' || e.op === '||') s = 'bool';
    else s = ka === 'bool' && kb === 'bool' ? 'bool' : arithmeticScalar(ka, kb);
    const side = (ty: Type) => withScalar(arithmetic && ty.k === 'scalar' ? ty : r.type, s);
    e.left = this.coerce(e.left, side(a));
    e.right = this.coerce(e.right, side(b));
    return r.type;
  }

  private inferAssign(e: ExprOf<'assign'>): Type {
    const tt = this.checkExpr(e.target);
    const vt = this.checkExpr(e.value);
    if (tt === ERR) return ERR;
    this.checkLvalue(e.target);
    if (vt === ERR) return tt;
    if (e.op === '=') {
      e.value = this.coerce(e.value, tt);
      return tt;
    }
    const s = scalarKind(tt);
    if (s === null || s === 'bool' || !binaryResultType(e.op[0], tt, vt)) {
      this.opError(e.loc, e.op, [tt, vt]);
      return tt;
    }
    e.value = this.coerce(e.value, vt.k === 'scalar' ? withScalar(vt, s) : tt);
    return tt;
  }

  private checkLvalue(e: Expr): void {
    const problem = this.lvalueProblem(e);
    if (problem) this.error('FX-TYPE-LVALUE', e.loc, problem);
  }

  // 代入できない理由 (できるなら null)。const・uniform の変数と uniform の引数は書き換えられない
  private lvalueProblem(e: Expr): string | null {
    switch (e.kind) {
      case 'ident': {
        const sym = e.sym;
        if (!sym) return null;
        let readonly: boolean;
        if (sym.kind === 'local') readonly = 'storage' in sym.decl ? sym.decl.storage.includes('const') : sym.decl.modifier === 'uniform';
        else {
          const g = this.globals.get(sym.name);
          readonly = g !== undefined && (g.storage !== 'static' || g.decl.storage.includes('const'));
        }
        return readonly ? t('{name} は書き換えられません', { name: e.name }) : null;
      }
      case 'member': {
        const a = e.access;
        if ((a?.kind === 'swizzle' && hasDuplicate(a.comps)) || (a?.kind === 'matrix' && hasDuplicate(a.elems))) {
          return t('同じ成分を 2 度含む {name} には代入できません', { name: `.${e.name}` });
        }
        return this.lvalueProblem(e.object);
      }
      case 'index': return this.lvalueProblem(e.object);
      default: return t('代入できない式です');
    }
  }

  // スカラーの条件は then と else の共通の型、ベクトルの条件は成分ごとに選ぶので条件の形にそろえる
  private inferTernary(e: ExprOf<'ternary'>): Type {
    const ct = this.checkExpr(e.cond);
    const a = this.checkExpr(e.then);
    const b = this.checkExpr(e.else);
    if (ct === ERR || a === ERR || b === ERR) return ERR;
    const common = this.commonType(a, b);
    const s = common && scalarKind(common);
    if (!common || scalarKind(ct) === null || (ct.k !== 'scalar' && !s)) return this.opError(e.loc, '?:', [ct, a, b]);
    let result = common;
    if (ct.k === 'scalar') e.cond = this.coerce(e.cond, BOOL);
    else {
      result = withScalar(ct, s as Scalar);
      e.cond = this.coerce(e.cond, withScalar(ct, 'bool'));
    }
    e.then = this.coerce(e.then, result);
    e.else = this.coerce(e.else, result);
    return result;
  }

  private commonType(a: Type, b: Type): Type | null {
    if (sameType(a, b)) return a;
    const ka = scalarKind(a);
    const kb = scalarKind(b);
    const r = binaryResultType('+', a, b);
    if (!r || ka === null || kb === null) return null;
    return ka === 'bool' && kb === 'bool' ? withScalar(r.type, 'bool') : r.type;
  }

  // ユーザーの関数を先に探し、なければ組み込み関数
  private inferCall(e: ExprOf<'call'>): Type {
    const types = e.args.map(a => this.checkExpr(a));
    if (types.includes(ERR)) return ERR;
    const args = () => types.map(typeName).join(', ');
    const users = this.overloads.get(e.callee);
    if (users) {
      const pick = this.pickOverload(users, types);
      if (pick === 'ambiguous') {
        this.error('FX-TYPE-AMBIGUOUS', e.loc, t('{name}({args}) は、どの関数を使うか決められません', { name: e.callee, args: args() }));
        return ERR;
      }
      if (pick) {
        e.args = e.args.map((a, i) => {
          const m = pick.decl.params[i].modifier;
          return m === 'out' || m === 'inout' ? this.outArg(a, pick.params[i]) : this.coerce(a, pick.params[i]);
        });
        e.target = { kind: 'function', fn: pick.decl };
        this.calls.push({ e, info: pick });
        this.useFunction(pick, e.loc);
        return pick.ret;
      }
    }
    if (UNSUPPORTED_INTRINSICS.includes(e.callee)) {
      this.error('FX-UNSUPPORTED', e.loc, t('対応していない組み込み関数です: {name}', { name: e.callee }));
      return ERR;
    }
    if (!users && !isIntrinsic(e.callee)) {
      this.error('FX-TYPE-UNDEFINED', e.loc, t('関数 {name} が見つかりません', { name: e.callee }));
      return ERR;
    }
    const res = resolveIntrinsic(e.callee, types);
    if (!res.ok) {
      if (res.reason === 'ambiguous') this.error('FX-TYPE-AMBIGUOUS', e.loc, t('{name}({args}) は、どの関数を使うか決められません', { name: e.callee, args: args() }));
      else this.error('FX-TYPE-NO-OVERLOAD', e.loc, t('{name}({args}) に合う関数がありません', { name: e.callee, args: args() }));
      return ERR;
    }
    const outs = Object.hasOwn(INTRINSIC_OUT, e.callee) ? INTRINSIC_OUT[e.callee] : [];
    e.args = e.args.map((a, i) => (outs.includes(i) ? this.outArg(a, res.params[i]) : this.coerce(a, res.params[i])));
    e.target = { kind: 'intrinsic', name: e.callee, params: res.params };
    return res.ret;
  }

  // 変換の cost の合計、切り詰める引数の数の順に比べる。同点が 2 つ以上なら ambiguous
  private pickOverload(cands: FunctionInfo[], types: Type[]): FunctionInfo | 'ambiguous' | null {
    let best: FunctionInfo | null = null;
    let bestKey = [Infinity, Infinity];
    let tie = false;
    for (const f of cands) {
      const required = f.decl.params.filter(p => p.init === null).length;
      if (types.length < required || types.length > f.params.length) continue;
      const key = [0, 0];
      for (let i = 0; i < types.length && key[0] < Infinity; i++) {
        const c = conversion(types[i], f.params[i]);
        key[0] += c ? c.cost : Infinity;
        key[1] += c?.truncates ? 1 : 0;
      }
      if (key[0] === Infinity) continue;
      const order = key[0] - bestKey[0] || key[1] - bestKey[1];
      if (order < 0) {
        best = f;
        bestKey = key;
        tie = false;
      } else if (order === 0) tie = true;
    }
    return tie ? 'ambiguous' : best;
  }

  // out・inout の引数は、同じ型の代入できる式
  private outArg(a: Expr, ty: Type): Expr {
    const problem = this.lvalueProblem(a);
    if (problem) this.error('FX-TYPE-LVALUE', a.loc, problem);
    else if (a.type && !sameType(a.type, ty)) {
      this.error('FX-TYPE-MISMATCH', a.loc, t('out の引数には {type} の変数を渡してください', { type: typeName(ty) }));
    }
    return a;
  }

  // float4(…): 成分の数の合計が型と同じ (ベクトルは 1 つのスカラーを広げてもよい)
  private inferConstruct(e: ExprOf<'construct'>): Type {
    const to = this.resolveType(e.typeRef, [], true);
    const types = e.args.map(a => this.checkExpr(a));
    if (to === ERR) return ERR;
    const s = scalarKind(to);
    if (s === null) {
      this.error('FX-TYPE-MISMATCH', e.loc, t('{type} はコンストラクタで作れません', { type: typeName(to) }));
      return ERR;
    }
    if (types.includes(ERR)) return to;
    const bad = types.find(ty => scalarKind(ty) === null);
    if (bad) {
      this.mismatch(e.loc, bad, to);
      return to;
    }
    const total = types.reduce((n, ty) => n + componentCount(ty), 0);
    const broadcast = types.length === 1 && types[0].k === 'scalar' && to.k !== 'matrix';
    if (total !== componentCount(to) && !broadcast) {
      this.error('FX-TYPE-MISMATCH', e.loc, t('{type} を作る引数の成分の数が合いません (必要 {want}・指定 {got})', { type: typeName(to), want: componentCount(to), got: total }));
      return to;
    }
    e.args = e.args.map((a, i) => this.coerce(a, withScalar(types[i], s)));
    return to;
  }

  // 明示のキャストは切り詰めても警告しない。構造体へはスカラーから ((S)0)
  private inferCast(e: ExprOf<'cast'>): Type {
    const to = this.resolveType(e.typeRef, [], true);
    const from = this.checkExpr(e.value);
    if (to === ERR || from === ERR) return to;
    const ok = to.k === 'struct' ? from.k === 'scalar' || sameType(from, to) : conversion(from, to) !== null;
    if (!ok) this.mismatch(e.loc, from, to);
    return to;
  }

  private inferMember(e: ExprOf<'member'>): Type {
    const ty = this.checkExpr(e.object);
    if (ty === ERR) return ERR;
    if (ty.k === 'struct') {
      const f = ty.fields.find(x => x.name === e.name);
      if (!f) {
        this.error('FX-TYPE-UNDEFINED', e.loc, t('{type} にメンバー {name} はありません', { type: ty.name, name: e.name }));
        return ERR;
      }
      e.access = { kind: 'field', name: e.name };
      return f.type;
    }
    if (ty.k === 'scalar' || ty.k === 'vector') {
      const comps = swizzleOf(e.name, ty.k === 'scalar' ? 1 : ty.n);
      if (comps) {
        e.access = { kind: 'swizzle', comps };
        return vectorOf(ty.s, comps.length);
      }
    } else if (ty.k === 'matrix') {
      const elems = matrixElemsOf(e.name, ty.rows, ty.cols);
      if (elems) {
        e.access = { kind: 'matrix', elems };
        return vectorOf(ty.s, elems.length);
      }
    }
    this.error('FX-TYPE-SWIZZLE', e.loc, t('.{name} は {type} に使えません', { name: e.name, type: typeName(ty) }));
    return ERR;
  }

  // 配列の要素・ベクトルの成分・行列の行。添字は int にする
  private inferIndex(e: ExprOf<'index'>): Type {
    const ty = this.checkExpr(e.object);
    const it = this.checkExpr(e.index);
    if (ty === ERR || it === ERR) return ERR;
    let elem: Type;
    let size: number;
    if (ty.k === 'array') { elem = ty.of; size = ty.length; }
    else if (ty.k === 'vector') { elem = { k: 'scalar', s: ty.s }; size = ty.n; }
    else if (ty.k === 'matrix') { elem = vectorOf(ty.s, ty.cols); size = ty.rows; }
    else {
      this.error('FX-TYPE-MISMATCH', e.loc, t('{type} には添字を使えません', { type: typeName(ty) }));
      return ERR;
    }
    if (it.k !== 'scalar') {
      this.error('FX-TYPE-MISMATCH', e.index.loc, t('添字はスカラーにしてください ({type})', { type: typeName(it) }));
      return elem;
    }
    if (it.s !== 'int' && it.s !== 'uint') e.index = this.coerce(e.index, INT);
    const v = this.constEval(e.index);
    if (v?.kind === 'num' && (v.values[0] < 0 || v.values[0] >= size)) {
      this.error('FX-TYPE-MISMATCH', e.index.loc, t('添字 {index} は範囲の外です (大きさ {size})', { index: v.values[0], size }));
    }
    return elem;
  }
}

export function check(file: FileNode, diags: Diagnostics): CheckedEffect {
  const c = new Checker(diags);
  const entries = c.run(file);
  return {
    file, globals: c.globals, structs: c.structs, entries,
    functions: c.functions.filter(f => f.decl.body !== null),
    constEval: e => c.constEval(e),
  };
}
