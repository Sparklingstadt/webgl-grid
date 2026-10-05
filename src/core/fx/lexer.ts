import { t } from '../i18n.ts';
import type { Diagnostics, Loc } from './diagnostics.ts';

// --- 字句解析。コメントは捨て、行末の \ でつないだ行は 1 行にする ---
export type TokenKind = 'ident' | 'number' | 'string' | 'punct' | 'eof';
// lineStart: 論理行の最初の字句か (# の指示行の見分けに使う) / spaceBefore: 直前に空白かコメントがあるか
export interface Token { kind: TokenKind; text: string; loc: Loc; lineStart: boolean; spaceBefore: boolean }

// 長い順に照らす
const PUNCTS = [
  '<<=', '>>=', '...',
  '##', '++', '--', '&&', '||', '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '->',
  ...'+-*/%&|^~!<>=?:;,.(){}[]#',
];
const isDigit = (c: string) => c >= '0' && c <= '9';
const isIdentStart = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isIdentPart = (c: string) => isIdentStart(c) || isDigit(c);
const isHex = (c: string) => isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');

export function lex(text: string, file: string, diags: Diagnostics): Token[] {
  // 行末の \ + 改行を取り除いた文字列と、各文字の元の行・列
  let s = '';
  const lines: number[] = [];
  const cols: number[] = [];
  let line = 1, col = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && text[i + 1] === '\n') { i++; line++; col = 1; continue; }
    s += c; lines.push(line); cols.push(col);
    if (c === '\n') { line++; col = 1; } else col++;
  }
  const endLoc: Loc = { file, line, column: col };
  const locAt = (i: number): Loc => (i < s.length ? { file, line: lines[i], column: cols[i] } : endLoc);

  const tokens: Token[] = [];
  let i = 0, lineStart = true, space = false;
  const push = (kind: TokenKind, start: number, end: number) => {
    tokens.push({ kind, text: s.slice(start, end), loc: locAt(start), lineStart, spaceBefore: space });
    lineStart = false; space = false; i = end;
  };

  while (i < s.length) {
    const c = s[i];
    if (c === '\n') { lineStart = true; space = true; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') { space = true; i++; continue; }
    if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      space = true; continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      if (end < 0) diags.fatal('FX-LEX-UNTERMINATED', locAt(i), t('コメントが閉じていません'));
      i = end + 2; space = true; continue;
    }
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < s.length && isIdentPart(s[j])) j++;
      push('ident', i, j); continue;
    }
    if (isDigit(c) || (c === '.' && isDigit(s[i + 1] ?? ''))) { push('number', i, scanNumber(s, i)); continue; }
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"' && s[j] !== '\n') j += s[j] === '\\' && j + 1 < s.length && s[j + 1] !== '\n' ? 2 : 1;
      if (s[j] !== '"') diags.fatal('FX-LEX-UNTERMINATED', locAt(i), t('文字列が閉じていません'));
      push('string', i, j + 1); continue;
    }
    const p = PUNCTS.find(q => s.startsWith(q, i));
    if (!p) diags.fatal('FX-LEX-CHAR', locAt(i), t('読めない文字です: {c}', { c }));
    push('punct', i, i + p.length);
  }
  tokens.push({ kind: 'eof', text: '', loc: endLoc, lineStart: true, spaceBefore: space });
  return tokens;
}

// 数の終わりの位置: 16 進、または 10 進 (小数・指数) と後ろの接尾辞 (f h u l)
function scanNumber(s: string, start: number): number {
  let j = start;
  if (s[j] === '0' && (s[j + 1] === 'x' || s[j + 1] === 'X') && isHex(s[j + 2] ?? '')) {
    j += 2;
    while (j < s.length && isHex(s[j])) j++;
  } else {
    while (j < s.length && isDigit(s[j])) j++;
    if (s[j] === '.') { j++; while (j < s.length && isDigit(s[j])) j++; }
    if (s[j] === 'e' || s[j] === 'E') {
      let k = j + 1;
      if (s[k] === '+' || s[k] === '-') k++;
      if (isDigit(s[k] ?? '')) { while (k < s.length && isDigit(s[k])) k++; j = k; }
    }
  }
  while (j < s.length && 'fFhHuUlL'.includes(s[j])) j++;
  return j;
}

export function numberValue(tok: Token): { value: number; isFloat: boolean } {
  const s = tok.text;
  if (/^0[xX]/.test(s)) return { value: parseInt(s.replace(/[uUlL]+$/, ''), 16), isFloat: false };
  const suffix = /[fFhHuUlL]*$/.exec(s)![0];
  const body = s.slice(0, s.length - suffix.length);
  const isFloat = /[.eE]/.test(body) || /[fFhH]/.test(suffix);
  return { value: parseFloat(body), isFloat };
}
