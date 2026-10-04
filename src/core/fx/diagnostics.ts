import { t } from '../i18n.ts';

// --- 診断 (誤りと警告)。テストは文ではなく code で確かめる ---
export interface Loc { file: string; line: number; column: number; includedFrom?: { file: string; line: number }[] }
export type DiagCode =
  | 'FX-IO-NOT-FOUND' | 'FX-PP-INCLUDE-NOT-FOUND' | 'FX-PP-INCLUDE-DEPTH' | 'FX-PP-DIRECTIVE' | 'FX-PP-ERROR'
  | 'FX-PP-UNTERMINATED-IF' | 'FX-PP-MACRO-ARGS' | 'FX-LEX-CHAR' | 'FX-LEX-UNTERMINATED' | 'FX-PARSE'
  | 'FX-TYPE-UNDEFINED' | 'FX-TYPE-MISMATCH' | 'FX-TYPE-NO-OVERLOAD' | 'FX-TYPE-AMBIGUOUS' | 'FX-TYPE-SWIZZLE'
  | 'FX-TYPE-LVALUE' | 'FX-TYPE-CONST' | 'FX-TYPE-REDEFINED' | 'FX-TYPE-TOO-MANY'
  | 'FX-PASS-FUNCTION' | 'FX-PASS-SEMANTIC' | 'FX-UNSUPPORTED' | 'FX-INTERNAL'
  | 'FX-WARN-TRUNCATION' | 'FX-WARN-REDEFINE-MACRO' | 'FX-WARN-STATE' | 'FX-WARN-STATE-EXPR' | 'FX-WARN-SCRIPT' | 'FX-WARN-SEMANTIC';
export interface Diagnostic extends Loc { severity: 'error' | 'warning'; code: DiagCode; message: string }

// 続けられない誤り。投げる前に必ず Diagnostics に積む
export class FxError extends Error {}

const MAX_ERRORS = 20;

function has(list: Diagnostic[], code: DiagCode, loc: Loc, message: string): boolean {
  return list.some(d => d.code === code && d.file === loc.file && d.line === loc.line && d.column === loc.column && d.message === message);
}

export class Diagnostics {
  readonly errors: Diagnostic[] = [];
  readonly warnings: Diagnostic[] = [];

  // 同じもの (code・場所・文が同じ) は 1 回だけ積む (段階・pass ごとに同じ関数を書き出すため)。上限にも数えない
  error(code: DiagCode, loc: Loc, message: string): void {
    if (has(this.errors, code, loc, message)) return;
    if (this.errors.length >= MAX_ERRORS) this.fatal('FX-TYPE-TOO-MANY', loc, t('誤りが多いので、ここで止めました'));
    this.errors.push({ ...loc, severity: 'error', code, message });
  }

  warn(code: DiagCode, loc: Loc, message: string): void {
    if (has(this.warnings, code, loc, message)) return;
    this.warnings.push({ ...loc, severity: 'warning', code, message });
  }

  fatal(code: DiagCode, loc: Loc, message: string): never {
    this.errors.push({ ...loc, severity: 'error', code, message });
    throw new FxError(message);
  }
}
