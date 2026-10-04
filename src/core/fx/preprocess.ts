import { t } from '../i18n.ts';
import { Diagnostics, FxError, type Loc } from './diagnostics.ts';
import { lex, numberValue, type Token } from './lexer.ts';
import { decodeSource, dirname, joinPath, resolveFile, type FileAccess } from './source.ts';

// --- 前処理。指令を片づけ、マクロを展開した字句の列を返す ---
export interface PreprocessOptions { defines?: Record<string, string> }

const MAX_INCLUDE_DEPTH = 64;

interface Macro { name: string; params: string[] | null; body: Token[] }
// hs: 展開中のマクロの名前 (この字句はもう、その名前のマクロでは展開しない)
interface HTok { tok: Token; hs: ReadonlySet<string> | null }
// ファイルの字句を、先読みしながら 1 つずつ取る位置 (マクロの引数がファイルの続きにまたがるため)
interface Cursor { toks: Token[]; p: number }

const isPunct = (tok: Token | undefined, text: string) => tok !== undefined && tok.kind === 'punct' && tok.text === text;
const isDirectiveHash = (tok: Token) => tok.lineStart && isPunct(tok, '#');
const joinText = (toks: Token[]) => toks.map((x, i) => (i > 0 && x.spaceBefore ? ' ' : '') + x.text).join('');

function union(a: ReadonlySet<string> | null, b: ReadonlySet<string> | null): ReadonlySet<string> | null {
  if (!a || a.size === 0) return b;
  if (!b || b.size === 0) return a;
  return new Set([...a, ...b]);
}
function intersect(a: ReadonlySet<string> | null, b: ReadonlySet<string> | null): ReadonlySet<string> | null {
  if (!a || !b) return null;
  return new Set([...a].filter(x => b.has(x)));
}

// entry も readFile に渡すパスも、呼び出し側が決めたルートからの相対パス。
// 字句の loc.includedFrom は、#include した場所を外側 (entry) から順に並べたもの
export function preprocess(entry: string, access: FileAccess, options: PreprocessOptions, diags: Diagnostics): Token[] {
  const macros = new Map<string, Macro>();
  const out: Token[] = [];
  let entryDir = '';
  let eof: Token | null = null;

  for (const [name, value] of Object.entries(options.defines ?? {})) {
    const body = lex(value, '<defines>', diags);
    body.pop();
    macros.set(name, { name, params: null, body });
  }

  // マクロ 1 回分の置き換え。引数 args は展開前の字句
  function substitute(m: Macro, args: HTok[][], use: Token, hs: ReadonlySet<string> | null): HTok[] {
    const params = m.params;
    const expandedArgs = new Map<number, HTok[]>();
    const argIndex = (tok: Token | undefined) => (params && tok?.kind === 'ident' ? params.indexOf(tok.text) : -1);
    const useLoc = use.loc;
    const copy = (b: Token): HTok => ({ tok: { ...b, loc: useLoc, lineStart: false }, hs: null });
    const expandedArg = (k: number): HTok[] => {
      let e = expandedArgs.get(k);
      if (!e) { e = expandList(args[k]); expandedArgs.set(k, e); }
      return e;
    };
    const res: HTok[] = [];
    const body = m.body;
    for (let i = 0; i < body.length; i++) {
      const b = body[i];
      let cur: HTok[];
      const stringified = params && isPunct(b, '#') ? argIndex(body[i + 1]) : -1;
      if (stringified >= 0) {
        cur = [{ tok: stringify(args[stringified].map(x => x.tok), use), hs: null }];
        i++;
      } else {
        const k = argIndex(b);
        cur = k < 0 ? [copy(b)] : isPunct(body[i + 1], '##') ? args[k] : expandedArg(k);
      }
      while (isPunct(body[i + 1], '##') && i + 2 < body.length) {
        const rb = body[i + 2];
        const rk = argIndex(rb);
        const right = rk < 0 ? [copy(rb)] : args[rk];
        cur = paste(cur, right, use);
        i += 2;
      }
      res.push(...cur);
    }
    return res.map(h => ({ tok: h.tok, hs: union(h.hs, hs) }));
  }

  function stringify(arg: Token[], use: Token): Token {
    const s = arg.map((x, i) => (i > 0 && x.spaceBefore ? ' ' : '') + (x.kind === 'string' ? x.text.replace(/[\\"]/g, '\\$&') : x.text)).join('');
    return { kind: 'string', text: `"${s}"`, loc: use.loc, lineStart: false, spaceBefore: false };
  }

  // 左の最後の字句と右の最初の字句をつなぐ (どちらかが空ならそのまま並べる)
  function paste(left: HTok[], right: HTok[], use: Token): HTok[] {
    if (left.length === 0 || right.length === 0) return [...left, ...right];
    const a = left[left.length - 1].tok;
    const b = right[0].tok;
    const text = a.text + b.text;
    let lexed: Token[] = [];
    try { lexed = lex(text, use.loc.file, new Diagnostics()); } catch (e) { if (!(e instanceof FxError)) throw e; }
    if (lexed.length !== 2) {
      diags.error('FX-PP-DIRECTIVE', use.loc, t('## で字句をつなげません: {text}', { text }));
      return [...left, ...right];
    }
    const joined: Token = { ...lexed[0], loc: use.loc, lineStart: false, spaceBefore: a.spaceBefore };
    return [...left.slice(0, -1), { tok: joined, hs: null }, ...right.slice(1)];
  }

  // front (末尾が先頭) の字句を、必要ならファイル cursor の続きも読みながら展開する
  function expandStack(front: HTok[], cursor: Cursor | null): HTok[] {
    const res: HTok[] = [];
    const peekFile = (): Token | null => {
      const tok = cursor?.toks[cursor.p];
      return tok && tok.kind !== 'eof' && !isDirectiveHash(tok) ? tok : null;
    };
    const next = (): HTok | null => {
      if (front.length > 0) return front.pop()!;
      const tok = peekFile();
      if (!tok) return null;
      cursor!.p++;
      return { tok, hs: null };
    };
    const peek = (): Token | null => (front.length > 0 ? front[front.length - 1].tok : peekFile());
    const pushFront = (list: HTok[]) => { for (let i = list.length - 1; i >= 0; i--) front.push(list[i]); };

    while (front.length > 0) {
      const h = front.pop()!;
      const tok = h.tok;
      const m = tok.kind === 'ident' && !h.hs?.has(tok.text) ? macros.get(tok.text) : undefined;
      if (!m) { res.push(h); continue; }
      const hide = (close: HTok | null) => union(close ? intersect(h.hs, close.hs) : h.hs, new Set([m.name]));
      if (!m.params) { pushFront(substitute(m, [], tok, hide(null))); continue; }
      if (!isPunct(peek() ?? undefined, '(')) { res.push(h); continue; }
      next();
      const args: HTok[][] = [[]];
      let depth = 0;
      let close: HTok | null = null;
      for (let a = next(); a; a = next()) {
        if (isPunct(a.tok, '(')) depth++;
        else if (isPunct(a.tok, ')')) {
          if (depth === 0) { close = a; break; }
          depth--;
        } else if (isPunct(a.tok, ',') && depth === 0) { args.push([]); continue; }
        args[args.length - 1].push(a);
      }
      if (!close) {
        diags.error('FX-PP-MACRO-ARGS', tok.loc, t('マクロ {name} の引数が閉じていません', { name: m.name }));
        res.push(h);
        break;
      }
      const given = args.length === 1 && args[0].length === 0 ? 0 : args.length;
      if (given !== m.params.length && !(m.params.length === 1 && given === 0)) {
        diags.error('FX-PP-MACRO-ARGS', tok.loc, t('マクロ {name} の引数の数が違います (必要 {want}・指定 {got})', { name: m.name, want: m.params.length, got: given }));
        res.push(h);
        continue;
      }
      pushFront(substitute(m, args, tok, hide(close)));
    }
    return res;
  }

  function expandList(list: HTok[]): HTok[] {
    return expandStack([...list].reverse(), null);
  }

  // --- #if の式 (整数) ---
  const BINARY: Record<string, number> = {
    '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5, '==': 6, '!=': 6, '<': 7, '>': 7, '<=': 7, '>=': 7,
    '<<': 8, '>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10,
  };

  // toks はマクロ展開済み。残った名前は 0。壊れていれば FxError
  function evalExpr(toks: Token[]): number {
    let i = 0;
    const fail = (): never => { throw new FxError(t('#if の式を読めません')); };
    const peek = () => (toks[i]?.kind === 'punct' ? toks[i].text : undefined);

    const primary = (live: boolean): number => {
      const tok = toks[i++];
      if (!tok) return fail();
      if (tok.kind === 'number') return Math.trunc(numberValue(tok).value) | 0;
      if (tok.kind === 'ident') return 0;
      if (isPunct(tok, '(')) {
        const v = ternary(live);
        if (!isPunct(toks[i++], ')')) fail();
        return v;
      }
      return fail();
    };
    const unary = (live: boolean): number => {
      const op = peek();
      if (op === '!' || op === '~' || op === '-' || op === '+') {
        i++;
        const v = unary(live);
        return op === '!' ? (v === 0 ? 1 : 0) : op === '~' ? ~v : op === '-' ? -v | 0 : v;
      }
      return primary(live);
    };
    const binary = (min: number, live: boolean): number => {
      let lhs = unary(live);
      for (;;) {
        const op = peek();
        const prec = op === undefined ? undefined : BINARY[op];
        if (prec === undefined || prec < min) return lhs;
        i++;
        const rhs = binary(prec + 1, op === '&&' ? live && lhs !== 0 : op === '||' ? live && lhs === 0 : live);
        switch (op) {
          case '||': lhs = lhs !== 0 || rhs !== 0 ? 1 : 0; break;
          case '&&': lhs = lhs !== 0 && rhs !== 0 ? 1 : 0; break;
          case '|': lhs |= rhs; break;
          case '^': lhs ^= rhs; break;
          case '&': lhs &= rhs; break;
          case '==': lhs = lhs === rhs ? 1 : 0; break;
          case '!=': lhs = lhs !== rhs ? 1 : 0; break;
          case '<': lhs = lhs < rhs ? 1 : 0; break;
          case '>': lhs = lhs > rhs ? 1 : 0; break;
          case '<=': lhs = lhs <= rhs ? 1 : 0; break;
          case '>=': lhs = lhs >= rhs ? 1 : 0; break;
          case '<<': lhs <<= rhs & 31; break;
          case '>>': lhs >>= rhs & 31; break;
          case '+': lhs = (lhs + rhs) | 0; break;
          case '-': lhs = (lhs - rhs) | 0; break;
          case '*': lhs = Math.imul(lhs, rhs); break;
          default: // '/' '%'
            if (rhs === 0) {
              if (live) throw new FxError(t('#if の式で 0 で割っています'));
              lhs = 0;
            } else lhs = op === '/' ? (lhs / rhs) | 0 : lhs % rhs;
        }
      }
    };
    function ternary(live: boolean): number {
      const c = binary(1, live);
      if (peek() !== '?') return c;
      i++;
      const a = ternary(live && c !== 0);
      if (peek() !== ':') return fail();
      i++;
      const b = ternary(live && c === 0);
      return c !== 0 ? a : b;
    }

    const v = ternary(true);
    if (i < toks.length) fail();
    return v;
  }

  // #if・#elif の式 (line は指令の名前のあとの字句) の真偽
  function condition(line: Token[], at: Loc): boolean {
    const replaced: HTok[] = [];
    for (let i = 0; i < line.length; i++) {
      const tok = line[i];
      if (tok.kind === 'ident' && tok.text === 'defined') {
        const paren = isPunct(line[i + 1], '(');
        const name = line[i + (paren ? 2 : 1)];
        if (name?.kind === 'ident' && (!paren || isPunct(line[i + 3], ')'))) {
          replaced.push({ tok: { ...tok, kind: 'number', text: macros.has(name.text) ? '1' : '0' }, hs: null });
          i += paren ? 3 : 1;
          continue;
        }
      }
      replaced.push({ tok, hs: null });
    }
    try {
      return evalExpr(expandList(replaced).map(h => h.tok)) !== 0;
    } catch (e) {
      if (!(e instanceof FxError)) throw e;
      diags.error('FX-PP-DIRECTIVE', at, e.message);
      return false;
    }
  }

  function define(line: Token[], at: Loc): void {
    const name = line[1];
    if (name?.kind !== 'ident') { badDirective('define', at); return; }
    let params: string[] | null = null;
    let bodyStart = 2;
    if (isPunct(line[2], '(') && !line[2].spaceBefore) {
      params = [];
      let i = 3;
      if (isPunct(line[i], ')')) i++;
      else {
        for (;;) {
          const p = line[i++];
          if (p?.kind !== 'ident') { badDirective('define', at); return; }
          params.push(p.text);
          const sep = line[i++];
          if (isPunct(sep, ')')) break;
          if (!isPunct(sep, ',')) { badDirective('define', at); return; }
        }
      }
      bodyStart = i;
    }
    const macro: Macro = { name: name.text, params, body: line.slice(bodyStart) };
    const old = macros.get(name.text);
    if (old && !sameMacro(old, macro)) {
      diags.warn('FX-WARN-REDEFINE-MACRO', name.loc, t('マクロ {name} を、別の内容で定義し直しました', { name: name.text }));
    }
    macros.set(name.text, macro);
  }

  const sameMacro = (a: Macro, b: Macro) =>
    (a.params?.join(',') ?? null) === (b.params?.join(',') ?? null) && a.body.map(x => x.text).join(' ') === b.body.map(x => x.text).join(' ');
  const badDirective = (name: string, at: Loc) => diags.error('FX-PP-DIRECTIVE', at, t('#{name} の書き方が正しくありません', { name }));

  // #include の相手: 書いたパス。"x" と <x> はどちらも同じ
  function includePath(line: Token[]): string | null {
    const first = line[1];
    if (first?.kind === 'string' && line.length === 2) return first.text.slice(1, -1);
    if (isPunct(first, '<') && isPunct(line[line.length - 1], '>') && line.length > 3) return joinText(line.slice(2, -1));
    return null;
  }

  function include(line: Token[], from: string, chain: { file: string; line: number }[], depth: number): void {
    const at = line[0].loc;
    const rel = includePath(line);
    if (rel === null) { badDirective('include', at); return; }
    if (depth + 1 > MAX_INCLUDE_DEPTH) {
      diags.error('FX-PP-INCLUDE-DEPTH', at, t('#include が深すぎます (上限 {n})', { n: MAX_INCLUDE_DEPTH }));
      return;
    }
    const found = resolveFile(access, joinPath(dirname(from), rel)) ?? resolveFile(access, joinPath(entryDir, rel));
    if (!found) {
      diags.error('FX-PP-INCLUDE-NOT-FOUND', at, t('#include のファイルが見つかりません: {path}', { path: rel }));
      return;
    }
    processFile(found.path, found.bytes, [...chain, { file: from, line: at.line }], depth + 1);
  }

  interface Cond { active: boolean; parentActive: boolean; taken: boolean; sawElse: boolean; loc: Loc }

  function processFile(path: string, bytes: Uint8Array, chain: { file: string; line: number }[], depth: number): void {
    const toks = lex(decodeSource(bytes), path, diags);
    if (chain.length > 0) for (const tok of toks) tok.loc = { ...tok.loc, includedFrom: chain };
    const conds: Cond[] = [];
    const isActive = () => conds.length === 0 || conds[conds.length - 1].active;
    const cursor: Cursor = { toks, p: 0 };

    while (toks[cursor.p].kind !== 'eof') {
      const tok = toks[cursor.p];
      if (isDirectiveHash(tok)) {
        let end = cursor.p + 1;
        while (!toks[end].lineStart) end++;
        const line = toks.slice(cursor.p + 1, end);
        cursor.p = end;
        directive(line, tok.loc);
        continue;
      }
      cursor.p++;
      if (!isActive()) continue;
      if (tok.kind === 'ident' && macros.has(tok.text)) out.push(...expandStack([{ tok, hs: null }], cursor).map(h => h.tok));
      else out.push(tok);
    }
    for (const c of conds) diags.error('FX-PP-UNTERMINATED-IF', c.loc, t('閉じていない #if があります'));
    eof = toks[cursor.p];

    // line は '#' のあとの字句 (line[0] が指令の名前)
    function directive(line: Token[], at: Loc): void {
      const name = line[0]?.text ?? '';
      const top = conds[conds.length - 1];
      switch (name) {
        case 'if': case 'ifdef': case 'ifndef': {
          const parent = isActive();
          let value = false;
          if (parent) {
            if (name === 'if') value = condition(line.slice(1), at);
            else if (line[1]?.kind !== 'ident') badDirective(name, at);
            else value = macros.has(line[1].text) === (name === 'ifdef');
          }
          conds.push({ active: parent && value, parentActive: parent, taken: parent && value, sawElse: false, loc: at });
          return;
        }
        case 'elif':
          if (!top || top.sawElse) { diags.error('FX-PP-DIRECTIVE', at, t('対応する #if がないか、#else のあとです: #elif')); return; }
          top.active = false;
          if (top.parentActive && !top.taken) {
            top.active = condition(line.slice(1), at);
            top.taken = top.active;
          }
          return;
        case 'else':
          if (!top || top.sawElse) { diags.error('FX-PP-DIRECTIVE', at, t('対応する #if がないか、#else のあとです: #else')); return; }
          top.active = top.parentActive && !top.taken;
          top.taken = true;
          top.sawElse = true;
          return;
        case 'endif':
          if (!top) diags.error('FX-PP-DIRECTIVE', at, t('対応する #if がありません: #endif'));
          else conds.pop();
          return;
      }
      if (!isActive()) return;
      switch (name) {
        case '': case 'pragma': case 'line': return;
        case 'define': define(line, at); return;
        case 'undef':
          if (line[1]?.kind !== 'ident') badDirective(name, at);
          else macros.delete(line[1].text);
          return;
        case 'include': include(line, path, chain, depth); return;
        case 'error':
          diags.error('FX-PP-ERROR', at, t('#error: {text}', { text: joinText(line.slice(1)) }));
          return;
        default:
          diags.error('FX-PP-DIRECTIVE', at, t('知らない指令です: #{name}', { name }));
      }
    }
  }

  const root = resolveFile(access, entry);
  if (!root) diags.fatal('FX-IO-NOT-FOUND', { file: entry, line: 1, column: 1 }, t('ファイルが見つかりません: {path}', { path: entry }));
  entryDir = dirname(root.path);
  processFile(root.path, root.bytes, [], 0);
  out.push(eof!);
  return out;
}
