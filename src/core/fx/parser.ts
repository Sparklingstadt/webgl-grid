import { t } from '../i18n.ts';
import type { Diagnostics, Loc } from './diagnostics.ts';
import { numberValue, type Token } from './lexer.ts';
import { builtinType, matrixOf, vectorOf } from './types.ts';
import type {
  AnnotationNode, Expr, FileNode, FunctionDecl, GlobalDecl, ParamNode, PassNode, StateAssign, Stmt, Storage, StructDecl,
  TechniqueNode, TopLevel, TypedefDecl, TypeRef, VarDecl,
} from './ast.ts';

// --- 構文解析 (再帰下降)。最初の構文の誤りで FX-PARSE を fatal にする ---
const STORAGE = new Set<string>(['static', 'const', 'uniform', 'shared', 'extern', 'volatile', 'row_major', 'column_major']);
// 意味を持たないので読み飛ばす修飾子
const IGNORED_MODIFIERS = new Set(['inline', 'precise', 'linear', 'centroid', 'nointerpolation', 'noperspective']);
// SM4 以降の型。使うと FX-UNSUPPORTED
const UNSUPPORTED_TYPES = new Set(['Texture1D', 'Texture2D', 'Texture3D', 'TextureCube', 'SamplerState', 'SamplerComparisonState']);
const UNSUPPORTED_WORDS = new Set(['asm', 'cbuffer', 'tbuffer', 'technique10', 'technique11']);
const KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue', 'return', 'discard', 'struct', 'typedef',
]);
const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=']);
const UNSUPPORTED_ASSIGN_OPS = new Set(['&=', '|=', '^=', '<<=', '>>=']);
const UNARY_OPS = new Set(['-', '+', '!', '~', '++', '--']);
// 二項演算子を、結びつきの弱い順に
const BINARY_LEVELS: string[][] = [
  ['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<', '>', '<=', '>='], ['<<', '>>'], ['+', '-'], ['*', '/', '%'],
];

const isPunct = (tok: Token, text: string) => tok.kind === 'punct' && tok.text === text;
const isIdent = (tok: Token, text: string) => tok.kind === 'ident' && tok.text === text;

// "..." の中身 (\\ と \" と \n と \t だけ読み、ほかの \ はそのまま)
function unquote(text: string): string {
  return text.slice(1, -1).replace(/\\(.)/g, (m, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c === '"' || c === '\\' ? c : m));
}

class Parser {
  private pos = 0;
  // ここまでに出た構造体と typedef の名前 (キャストと宣言の見分けに使う)
  private readonly known = new Set<string>();
  private readonly tokens: Token[];
  private readonly diags: Diagnostics;

  constructor(tokens: Token[], diags: Diagnostics) {
    this.tokens = [...tokens]; // 注釈の閉じの >> を割るので、呼び出し側の列は触らない
    this.diags = diags;
  }

  // --- 字句の読み取り ---
  // 位置 i の字句 (終わりを越えたら eof)
  private tokenAt(i: number): Token {
    return this.tokens[Math.min(i, this.tokens.length - 1)];
  }
  private peek(n = 0): Token {
    return this.tokenAt(this.pos + n);
  }
  private next(): Token {
    const tok = this.peek();
    if (this.pos < this.tokens.length - 1) this.pos++;
    return tok;
  }
  private at(text: string, n = 0): boolean {
    return isPunct(this.peek(n), text);
  }
  private accept(text: string): boolean {
    if (!this.at(text)) return false;
    this.next();
    return true;
  }

  private describe(tok: Token): string {
    return tok.kind === 'eof' ? t('入力の終わり') : `'${tok.text}'`;
  }
  private failAt(tok: Token, expected: string): never {
    this.diags.fatal('FX-PARSE', tok.loc, t('{expected} が必要ですが、{found} がありました', { expected, found: this.describe(tok) }));
  }
  private expect(text: string): Token {
    if (!this.at(text)) this.failAt(this.peek(), `'${text}'`);
    return this.next();
  }
  private expectIdent(what = t('識別子')): Token {
    if (this.peek().kind !== 'ident') this.failAt(this.peek(), what);
    return this.next();
  }
  private unsupported(tok: Token, what: string): never {
    this.diags.fatal('FX-UNSUPPORTED', tok.loc, t('対応していない書き方です: {what}', { what }));
  }

  // --- 型の名前の見分け ---
  private isTypeName(tok: Token): boolean {
    return tok.kind === 'ident' && (builtinType(tok.text) !== null || this.known.has(tok.text) || UNSUPPORTED_TYPES.has(tok.text));
  }
  // 位置 i から始まる型の次の位置。型でなければ -1 (診断は出さない)
  private scanTypeEnd(i: number): number {
    const tok = this.tokenAt(i);
    if (!this.isTypeName(tok)) return -1;
    const at = (k: number) => this.tokenAt(k);
    if ((tok.text === 'vector' || tok.text === 'matrix') && isPunct(at(i + 1), '<')) {
      let j = i + 2;
      if (at(j).kind !== 'ident') return -1;
      j++;
      for (let k = tok.text === 'vector' ? 1 : 2; k > 0; k--) {
        if (!isPunct(at(j), ',') || at(j + 1).kind !== 'number') return -1;
        j += 2;
      }
      return isPunct(at(j), '>') ? j + 1 : -1;
    }
    return i + 1;
  }

  // --- 型 ---
  private parseType(): TypeRef {
    const tok = this.peek();
    if (tok.kind !== 'ident') this.failAt(tok, t('型の名前'));
    if (UNSUPPORTED_TYPES.has(tok.text)) this.unsupported(tok, tok.text);
    if ((tok.text === 'vector' || tok.text === 'matrix') && this.at('<', 1)) return this.parseTemplateType();
    const type = builtinType(tok.text);
    if (type) {
      this.next();
      return { kind: 'builtin', type, loc: tok.loc };
    }
    if (this.known.has(tok.text)) {
      this.next();
      return { kind: 'named', name: tok.text, loc: tok.loc };
    }
    return this.failAt(tok, t('型の名前'));
  }

  // vector<float, 3>・matrix<float, 4, 4>
  private parseTemplateType(): TypeRef {
    const kw = this.next();
    this.expect('<');
    const scalarTok = this.expectIdent(t('スカラーの型'));
    const scalar = builtinType(scalarTok.text);
    if (scalar?.k !== 'scalar') this.failAt(scalarTok, t('スカラーの型'));
    this.expect(',');
    const n = this.parseSize();
    if (kw.text === 'vector') {
      this.expect('>');
      return { kind: 'builtin', type: vectorOf(scalar.s, n), loc: kw.loc };
    }
    this.expect(',');
    const cols = this.parseSize();
    this.expect('>');
    return { kind: 'builtin', type: matrixOf(scalar.s, n, cols), loc: kw.loc };
  }

  private parseSize(): number {
    const tok = this.peek();
    if (tok.kind !== 'number' || !/^\d+$/.test(tok.text)) this.failAt(tok, t('1 から 4 の整数'));
    const n = Number(tok.text);
    if (n < 1 || n > 4) this.diags.fatal('FX-PARSE', tok.loc, t('型の大きさは 1〜4 にしてください: {n}', { n: tok.text }));
    this.next();
    return n;
  }

  // --- 宣言 ---
  parseFile(): FileNode {
    const items: TopLevel[] = [];
    while (this.peek().kind !== 'eof') items.push(...this.parseTopLevel());
    return { items };
  }

  private parseTopLevel(): TopLevel[] {
    const tok = this.peek();
    if (this.accept(';')) return [];
    if (tok.kind === 'ident') {
      if (UNSUPPORTED_WORDS.has(tok.text)) this.unsupported(tok, tok.text);
      if (tok.text === 'struct') return [this.parseStruct()];
      if (tok.text === 'typedef') return [this.parseTypedef()];
      if (tok.text === 'technique') return [this.parseTechnique()];
    }
    const storage = this.parseModifiers();
    const type = this.parseType();
    const nameTok = this.expectIdent();
    if (this.at('(')) return [this.parseFunction(type, nameTok)];
    const decls = this.parseDeclarators(type, storage, nameTok);
    this.expect(';');
    return decls.map((decl): GlobalDecl => ({ kind: 'global', decl }));
  }

  // 修飾子 (記憶域は集め、意味のないものは捨てる)
  private parseModifiers(): Storage[] {
    const storage: Storage[] = [];
    for (;;) {
      const tok = this.peek();
      if (tok.kind !== 'ident') return storage;
      if (STORAGE.has(tok.text)) storage.push(tok.text as Storage);
      else if (!IGNORED_MODIFIERS.has(tok.text)) return storage;
      this.next();
    }
  }

  private parseArrayDims(): (Expr | null)[] {
    const dims: (Expr | null)[] = [];
    while (this.accept('[')) {
      dims.push(this.at(']') ? null : this.parseExpression());
      this.expect(']');
    }
    return dims;
  }

  // : SEMANTIC と register(…) (どちらも、順も個数も問わない)。register は小文字の名前 (最後の識別子。register(ps_3_0, s0) なら s0) を取っておく
  private parseSemantic(): { semantic: string | null; register: string | null } {
    let semantic: string | null = null;
    let register: string | null = null;
    for (;;) {
      if (this.at(':')) {
        if (isIdent(this.peek(1), 'register') && this.at('(', 2)) this.next();
        else {
          this.next();
          semantic = this.expectIdent(t('セマンティクス名')).text;
          continue;
        }
      }
      if (isIdent(this.peek(), 'register') && this.at('(', 1)) {
        this.next();
        this.next();
        while (!this.at(')') && this.peek().kind !== 'eof') {
          const tok = this.next();
          if (tok.kind === 'ident') register = tok.text.toLowerCase();
        }
        this.expect(')');
        continue;
      }
      return { semantic, register };
    }
  }

  // 注釈 <型 名前 = 値; …>。閉じが >> の字句なら半分ずつ使う
  private parseAnnotations(): AnnotationNode[] {
    const list: AnnotationNode[] = [];
    if (!this.accept('<')) return list;
    for (;;) {
      const tok = this.peek();
      if (isPunct(tok, '>')) {
        this.next();
        return list;
      }
      if (isPunct(tok, '>>')) {
        this.tokens[this.pos] = { ...tok, text: '>', loc: { ...tok.loc, column: tok.loc.column + 1 } };
        return list;
      }
      const type = this.parseType();
      const nameTok = this.expectIdent();
      this.expect('=');
      const value = this.parseInitializer();
      this.expect(';');
      list.push({ type, name: nameTok.text, value, loc: nameTok.loc });
    }
  }

  // --- technique・pass・ステート ---
  private parseTechnique(): TechniqueNode {
    this.next();
    const nameTok = this.expectIdent();
    const annotations = this.parseAnnotations();
    this.expect('{');
    const passes: PassNode[] = [];
    while (!this.at('}')) {
      if (!isIdent(this.peek(), 'pass')) this.failAt(this.peek(), `'pass' / '}'`);
      passes.push(this.parsePass());
    }
    this.next();
    return { kind: 'technique', name: nameTok.text, annotations, passes, loc: nameTok.loc };
  }

  private parsePass(): PassNode {
    this.next();
    const nameTok = this.expectIdent();
    const annotations = this.parseAnnotations();
    this.expect('{');
    const states = this.parseStates();
    return { name: nameTok.text, annotations, states, loc: nameTok.loc };
  }

  // 名前 [n] = 値; を } まで (} は読む)。名前の最後の数字も index
  private parseStates(): StateAssign[] {
    const states: StateAssign[] = [];
    while (!this.at('}')) {
      const nameTok = this.expectIdent(t('ステートの名前'));
      let name = nameTok.text;
      let index: number | null = null;
      if (this.accept('[')) {
        const n = this.peek();
        if (n.kind !== 'number' || !/^\d+$/.test(n.text)) this.failAt(n, t('1 から 4 の整数'));
        this.next();
        index = Number(n.text);
        this.expect(']');
      } else {
        const m = /^(.*[A-Za-z_])(\d+)$/.exec(name);
        if (m) {
          name = m[1];
          index = Number(m[2]);
        }
      }
      this.expect('=');
      const value = this.parseStateValue();
      this.expect(';');
      states.push({ name, index, value, loc: nameTok.loc });
    }
    this.next();
    return states;
  }

  // compile プロファイル 関数(引数) か、<Tex> (識別子の値)、式 (RED | GREEN も二項式のまま)
  private parseStateValue(): StateAssign['value'] {
    const tok = this.peek();
    if (isIdent(tok, 'compile')) {
      this.next();
      const profile = this.expectIdent(t('プロファイル名')).text;
      const fn = this.expectIdent().text;
      return { kind: 'compile', profile, fn, args: this.parseArgs(), loc: tok.loc };
    }
    if (isPunct(tok, '<') && this.peek(1).kind === 'ident' && this.at('>', 2)) {
      const name = this.peek(1).text;
      this.next();
      this.next();
      this.next();
      return { kind: 'ident', name, loc: tok.loc };
    }
    return this.parseAssign();
  }

  // 型と名前の次から。a[2] : SEM <注釈> = 初期値, b, … (最初の名前は読み終えている)
  private parseDeclarators(type: TypeRef, storage: Storage[], first: Token): VarDecl[] {
    const decls: VarDecl[] = [];
    let nameTok = first;
    for (;;) {
      const arrayDims = this.parseArrayDims();
      const { semantic, register } = this.parseSemantic();
      const annotations = this.parseAnnotations();
      const init = this.accept('=') ? this.parseInitializer() : null;
      decls.push({ name: nameTok.text, type, arrayDims, storage: [...storage], semantic, register, annotations, init, loc: nameTok.loc });
      if (!this.accept(',')) return decls;
      nameTok = this.expectIdent();
    }
  }

  private parseFunction(ret: TypeRef, nameTok: Token): FunctionDecl {
    const params = this.parseParams();
    const { semantic: retSemantic } = this.parseSemantic();
    let body: Stmt | null = null;
    if (this.at('{')) body = this.parseBlock();
    else if (!this.accept(';')) this.failAt(this.peek(), `'{' / ';'`);
    return { kind: 'function', name: nameTok.text, ret, retSemantic, params, body, loc: nameTok.loc };
  }

  private parseParams(): ParamNode[] {
    this.expect('(');
    const params: ParamNode[] = [];
    if (isIdent(this.peek(), 'void') && this.at(')', 1)) this.next();
    else if (!this.at(')')) {
      do params.push(this.parseParam()); while (this.accept(','));
    }
    this.expect(')');
    return params;
  }

  private parseParam(): ParamNode {
    const flags = new Set<string>();
    for (;;) {
      const tok = this.peek();
      if (tok.kind !== 'ident') break;
      if (tok.text === 'in' || tok.text === 'out' || tok.text === 'inout' || tok.text === 'uniform') flags.add(tok.text);
      else if (!STORAGE.has(tok.text) && !IGNORED_MODIFIERS.has(tok.text)) break;
      this.next();
    }
    let modifier: ParamNode['modifier'] = 'in';
    if (flags.has('inout') || (flags.has('in') && flags.has('out'))) modifier = 'inout';
    else if (flags.has('out')) modifier = 'out';
    else if (!flags.has('in') && flags.has('uniform')) modifier = 'uniform';
    const type = this.parseType();
    const nameTok = this.expectIdent();
    const arrayDims = this.parseArrayDims();
    const { semantic } = this.parseSemantic();
    const init = this.accept('=') ? this.parseAssign() : null;
    return { name: nameTok.text, type, arrayDims, modifier, semantic, init, loc: nameTok.loc };
  }

  private parseStruct(): StructDecl {
    this.next();
    const nameTok = this.expectIdent();
    this.expect('{');
    const fields: StructDecl['fields'] = [];
    while (!this.at('}')) {
      if (this.peek().kind === 'eof') this.failAt(this.peek(), `'}'`);
      this.parseModifiers();
      const type = this.parseType();
      do {
        const field = this.expectIdent();
        const arrayDims = this.parseArrayDims();
        const { semantic } = this.parseSemantic();
        fields.push({ name: field.text, type, arrayDims, semantic, loc: field.loc });
      } while (this.accept(','));
      this.expect(';');
    }
    this.next();
    this.expect(';');
    this.known.add(nameTok.text);
    return { kind: 'struct', name: nameTok.text, fields, loc: nameTok.loc };
  }

  private parseTypedef(): TypedefDecl {
    this.next();
    this.parseModifiers();
    const type = this.parseType();
    const nameTok = this.expectIdent();
    const arrayDims = this.parseArrayDims();
    this.expect(';');
    this.known.add(nameTok.text);
    return { kind: 'typedef', name: nameTok.text, type, arrayDims, loc: nameTok.loc };
  }

  // --- 文 ---
  private parseBlock(): Stmt {
    const open = this.expect('{');
    const body: Stmt[] = [];
    while (!this.at('}')) {
      if (this.peek().kind === 'eof') this.failAt(this.peek(), `'}'`);
      body.push(this.parseStatement());
    }
    this.next();
    return { kind: 'block', body, loc: open.loc };
  }

  // 宣言で始まるか: 修飾子か、型のあとに名前が続く
  private isDeclarationStart(): boolean {
    const tok = this.peek();
    if (tok.kind !== 'ident') return false;
    if (STORAGE.has(tok.text) || IGNORED_MODIFIERS.has(tok.text)) return true;
    const end = this.scanTypeEnd(this.pos);
    return end >= 0 && this.tokenAt(end).kind === 'ident';
  }

  private parseVarStatement(): Stmt {
    const loc = this.peek().loc;
    const storage = this.parseModifiers();
    const type = this.parseType();
    const nameTok = this.expectIdent();
    const decls = this.parseDeclarators(type, storage, nameTok);
    this.expect(';');
    return { kind: 'var', decls, loc };
  }

  private parseParenthesized(): Expr {
    this.expect('(');
    const e = this.parseExpression();
    this.expect(')');
    return e;
  }

  private parseStatement(): Stmt {
    // [unroll] [loop] [branch] などの属性は読み飛ばす (文の頭の [ は式にならない)
    while (this.at('[')) {
      this.next();
      let depth = 1;
      while (depth > 0) {
        if (this.peek().kind === 'eof') this.failAt(this.peek(), `']'`);
        const tok = this.next();
        if (isPunct(tok, '[')) depth++;
        else if (isPunct(tok, ']')) depth--;
      }
    }
    const tok = this.peek();
    if (this.at('{')) return this.parseBlock();
    if (this.accept(';')) return { kind: 'empty', loc: tok.loc };
    if (tok.kind === 'ident') {
      switch (tok.text) {
        case 'if': {
          this.next();
          const cond = this.parseParenthesized();
          const then = this.parseStatement();
          let otherwise: Stmt | null = null;
          if (isIdent(this.peek(), 'else')) {
            this.next();
            otherwise = this.parseStatement();
          }
          return { kind: 'if', cond, then, else: otherwise, loc: tok.loc };
        }
        case 'for': return this.parseFor();
        case 'while': {
          this.next();
          const cond = this.parseParenthesized();
          return { kind: 'while', cond, body: this.parseStatement(), loc: tok.loc };
        }
        case 'do': {
          this.next();
          const body = this.parseStatement();
          if (!isIdent(this.peek(), 'while')) this.failAt(this.peek(), `'while'`);
          this.next();
          const cond = this.parseParenthesized();
          this.expect(';');
          return { kind: 'do', body, cond, loc: tok.loc };
        }
        case 'switch': return this.parseSwitch();
        case 'break': case 'continue': case 'discard':
          this.next();
          this.expect(';');
          return { kind: tok.text, loc: tok.loc };
        case 'return': {
          this.next();
          const value = this.at(';') ? null : this.parseExpression();
          this.expect(';');
          return { kind: 'return', value, loc: tok.loc };
        }
        default:
          if (UNSUPPORTED_WORDS.has(tok.text)) this.unsupported(tok, tok.text);
          if (this.isDeclarationStart()) return this.parseVarStatement();
      }
    }
    const e = this.parseExpression();
    this.expect(';');
    return { kind: 'expr', expr: e, loc: tok.loc };
  }

  private parseFor(): Stmt {
    const kw = this.next();
    this.expect('(');
    let init: Stmt | null = null;
    if (this.at(';')) this.next();
    else if (this.isDeclarationStart()) init = this.parseVarStatement();
    else {
      const loc = this.peek().loc;
      init = { kind: 'expr', expr: this.parseExpression(), loc };
      this.expect(';');
    }
    const cond = this.at(';') ? null : this.parseExpression();
    this.expect(';');
    const step = this.at(')') ? null : this.parseExpression();
    this.expect(')');
    return { kind: 'for', init, cond, step, body: this.parseStatement(), loc: kw.loc };
  }

  private parseSwitch(): Stmt {
    const kw = this.next();
    const value = this.parseParenthesized();
    this.expect('{');
    const cases: { value: Expr | null; body: Stmt[] }[] = [];
    while (!this.at('}')) {
      const tok = this.peek();
      if (isIdent(tok, 'case')) {
        this.next();
        const label = this.parseTernary();
        this.expect(':');
        cases.push({ value: label, body: [] });
      } else if (isIdent(tok, 'default')) {
        this.next();
        this.expect(':');
        cases.push({ value: null, body: [] });
      } else if (cases.length === 0 || tok.kind === 'eof') {
        this.failAt(tok, `'case' / 'default' / '}'`);
      } else {
        cases[cases.length - 1].body.push(this.parseStatement());
      }
    }
    this.next();
    return { kind: 'switch', value, cases, loc: kw.loc };
  }

  // --- 式 ---
  // カンマでつないだ式 (a, b)
  private parseExpression(): Expr {
    const first = this.parseAssign();
    if (!this.at(',')) return first;
    const items = [first];
    while (this.accept(',')) items.push(this.parseAssign());
    return { kind: 'sequence', items, loc: first.loc };
  }

  // 変数の初期値: { a, b } か式
  private parseInitializer(): Expr {
    if (!this.at('{')) return this.parseAssign();
    const open = this.next();
    const items: Expr[] = [];
    while (!this.at('}')) {
      items.push(this.parseInitializer());
      if (!this.accept(',')) break;
    }
    this.expect('}');
    return { kind: 'initList', items, loc: open.loc };
  }

  private parseAssign(): Expr {
    const target = this.parseTernary();
    const tok = this.peek();
    if (tok.kind !== 'punct') return target;
    if (ASSIGN_OPS.has(tok.text)) {
      this.next();
      const value = this.parseAssign();
      return { kind: 'assign', op: tok.text as '=', target, value, loc: tok.loc };
    }
    if (UNSUPPORTED_ASSIGN_OPS.has(tok.text)) this.unsupported(tok, tok.text);
    return target;
  }

  private parseTernary(): Expr {
    const cond = this.parseBinary(0);
    const q = this.peek();
    if (!isPunct(q, '?')) return cond;
    this.next();
    const then = this.parseAssign();
    this.expect(':');
    return { kind: 'ternary', cond, then, else: this.parseTernary(), loc: q.loc };
  }

  private parseBinary(level: number): Expr {
    if (level >= BINARY_LEVELS.length) return this.parseUnary();
    let left = this.parseBinary(level + 1);
    for (;;) {
      const tok = this.peek();
      if (tok.kind !== 'punct' || !BINARY_LEVELS[level].includes(tok.text)) return left;
      this.next();
      left = { kind: 'binary', op: tok.text, left, right: this.parseBinary(level + 1), loc: tok.loc };
    }
  }

  // ( のあとが型の名前で ) が続けばキャスト
  private isCastAhead(): boolean {
    if (!this.at('(')) return false;
    const end = this.scanTypeEnd(this.pos + 1);
    return end >= 0 && isPunct(this.tokenAt(end), ')');
  }

  private parseUnary(): Expr {
    const tok = this.peek();
    if (tok.kind === 'punct' && UNARY_OPS.has(tok.text)) {
      this.next();
      return { kind: 'unary', op: tok.text as '-', postfix: false, operand: this.parseUnary(), loc: tok.loc };
    }
    if (this.isCastAhead()) {
      this.next();
      const type = this.parseType();
      this.expect(')');
      return { kind: 'cast', typeRef: type, value: this.parseUnary(), loc: tok.loc };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let e = this.parsePrimary();
    for (;;) {
      const tok = this.peek();
      if (isPunct(tok, '.')) {
        this.next();
        const name = this.expectIdent(t('メンバーの名前'));
        if (this.at('(')) this.unsupported(name, `.${name.text}()`);
        e = { kind: 'member', object: e, name: name.text, loc: tok.loc };
      } else if (isPunct(tok, '[')) {
        this.next();
        const index = this.parseExpression();
        this.expect(']');
        e = { kind: 'index', object: e, index, loc: tok.loc };
      } else if (isPunct(tok, '++') || isPunct(tok, '--')) {
        this.next();
        e = { kind: 'unary', op: tok.text as '++', postfix: true, operand: e, loc: tok.loc };
      } else return e;
    }
  }

  private parseArgs(): Expr[] {
    this.expect('(');
    const args: Expr[] = [];
    if (!this.at(')')) {
      do args.push(this.parseAssign()); while (this.accept(','));
    }
    this.expect(')');
    return args;
  }

  // 隣り合う文字列の字句は 1 つにつなぐ
  private parseString(): Expr {
    const loc: Loc = this.peek().loc;
    let value = '';
    while (this.peek().kind === 'string') value += unquote(this.next().text);
    return { kind: 'string', value, loc };
  }

  private parsePrimary(): Expr {
    const tok = this.peek();
    switch (tok.kind) {
      case 'number': {
        this.next();
        return { kind: 'number', ...numberValue(tok), loc: tok.loc };
      }
      case 'string': return this.parseString();
      case 'punct':
        if (tok.text === '(') return this.parseParenthesized();
        break;
      case 'ident': {
        if (UNSUPPORTED_WORDS.has(tok.text)) this.unsupported(tok, tok.text);
        if (tok.text === 'true' || tok.text === 'false') {
          this.next();
          return { kind: 'bool', value: tok.text === 'true', loc: tok.loc };
        }
        if (KEYWORDS.has(tok.text)) break;
        if (tok.text === 'sampler_state' && this.at('{', 1)) {
          this.next();
          this.next();
          return { kind: 'samplerState', states: this.parseStates(), loc: tok.loc };
        }
        const end = this.scanTypeEnd(this.pos);
        if (end >= 0 && isPunct(this.tokenAt(end), '(')) {
          const type = this.parseType();
          return { kind: 'construct', typeRef: type, args: this.parseArgs(), loc: tok.loc };
        }
        if (builtinType(tok.text) !== null) break; // 型の名前だけでは式にならない
        this.next();
        if (this.at('(')) return { kind: 'call', callee: tok.text, args: this.parseArgs(), loc: tok.loc };
        return { kind: 'ident', name: tok.text, loc: tok.loc };
      }
    }
    return this.failAt(tok, t('式 (数や名前など)'));
  }

}

export function parse(tokens: Token[], diags: Diagnostics): FileNode {
  return new Parser(tokens, diags).parseFile();
}
