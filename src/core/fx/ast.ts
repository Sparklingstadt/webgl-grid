import type { Loc } from './diagnostics.ts';
import type { Type } from './types.ts';

// --- 構文木。? の付いた欄は、型チェック (checker.ts) が書き足す ---
export type TypeRef = { kind: 'builtin'; type: Type; loc: Loc } | { kind: 'named'; name: string; loc: Loc };

export type Expr = (
  | { kind: 'number'; value: number; isFloat: boolean }
  | { kind: 'bool'; value: boolean }
  | { kind: 'string'; value: string } // 注釈とステートの値だけ
  | { kind: 'ident'; name: string; sym?: Sym }
  | { kind: 'unary'; op: '-' | '+' | '!' | '~' | '++' | '--'; postfix: boolean; operand: Expr }
  | { kind: 'binary'; op: string; left: Expr; right: Expr }
  | { kind: 'assign'; op: '=' | '+=' | '-=' | '*=' | '/=' | '%='; target: Expr; value: Expr }
  | { kind: 'ternary'; cond: Expr; then: Expr; else: Expr }
  | { kind: 'call'; callee: string; args: Expr[]; target?: CallTarget }
  | { kind: 'construct'; typeRef: TypeRef; args: Expr[] } // float4(...) (type は型チェックが書く式の型なので、型の書き方は typeRef)
  | { kind: 'cast'; typeRef: TypeRef; value: Expr } // (float3)x・(S)0
  | { kind: 'member'; object: Expr; name: string; access?: MemberAccess }
  | { kind: 'index'; object: Expr; index: Expr }
  | { kind: 'initList'; items: Expr[] } // { a, b }
  | { kind: 'sequence'; items: Expr[] } // a, b (for の中)
  | { kind: 'samplerState'; states: StateAssign[] }
  | { kind: 'convert'; to: Type; value: Expr } // 型チェックが入れる暗黙の型変換
) & { loc: Loc; type?: Type };

export type Sym = { kind: 'global'; name: string } | { kind: 'local'; decl: VarDecl | ParamNode };
export type CallTarget = { kind: 'function'; fn: FunctionDecl } | { kind: 'intrinsic'; name: string; params: Type[] };
export type MemberAccess =
  | { kind: 'swizzle'; comps: number[] } // 0〜3
  | { kind: 'field'; name: string }
  | { kind: 'matrix'; elems: [row: number, col: number][] }; // ._m01・._12 (0 から数えた行と列)

export type Stmt = (
  | { kind: 'block'; body: Stmt[] } | { kind: 'var'; decls: VarDecl[] } | { kind: 'expr'; expr: Expr }
  | { kind: 'if'; cond: Expr; then: Stmt; else: Stmt | null }
  | { kind: 'for'; init: Stmt | null; cond: Expr | null; step: Expr | null; body: Stmt }
  | { kind: 'while'; cond: Expr; body: Stmt } | { kind: 'do'; body: Stmt; cond: Expr }
  | { kind: 'switch'; value: Expr; cases: { value: Expr | null; body: Stmt[] }[] }
  | { kind: 'break' } | { kind: 'continue' } | { kind: 'discard' } | { kind: 'return'; value: Expr | null } | { kind: 'empty' }
) & { loc: Loc };

export type Storage = 'static' | 'const' | 'uniform' | 'shared' | 'extern' | 'volatile' | 'row_major' | 'column_major';
export interface AnnotationNode { type: TypeRef; name: string; value: Expr; loc: Loc }
export interface VarDecl {
  name: string; type: TypeRef; arrayDims: (Expr | null)[]; storage: Storage[]; semantic: string | null;
  annotations: AnnotationNode[]; init: Expr | null; loc: Loc; resolved?: Type; reuses?: VarDecl;
}
export interface ParamNode {
  name: string; type: TypeRef; arrayDims: (Expr | null)[]; modifier: 'in' | 'out' | 'inout' | 'uniform';
  semantic: string | null; init: Expr | null; loc: Loc; resolved?: Type;
}
export interface FunctionDecl {
  kind: 'function'; name: string; ret: TypeRef; retSemantic: string | null; params: ParamNode[];
  body: Stmt | null; loc: Loc; // body null はプロトタイプ
}
export interface StructDecl {
  kind: 'struct'; name: string; loc: Loc;
  fields: { name: string; type: TypeRef; arrayDims: (Expr | null)[]; semantic: string | null; loc: Loc }[];
}
export interface TypedefDecl { kind: 'typedef'; name: string; type: TypeRef; arrayDims: (Expr | null)[]; loc: Loc }
export interface GlobalDecl { kind: 'global'; decl: VarDecl }
export interface ShaderCompile { kind: 'compile'; profile: string; fn: string; args: Expr[]; loc: Loc }
export interface StateAssign { name: string; index: number | null; value: Expr | ShaderCompile; loc: Loc }
export interface PassNode { name: string; annotations: AnnotationNode[]; states: StateAssign[]; loc: Loc }
export interface TechniqueNode { kind: 'technique'; name: string; annotations: AnnotationNode[]; passes: PassNode[]; loc: Loc }
export type TopLevel = GlobalDecl | FunctionDecl | StructDecl | TypedefDecl | TechniqueNode;
export interface FileNode { items: TopLevel[] }
