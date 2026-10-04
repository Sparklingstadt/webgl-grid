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

export class Diagnostics {
  readonly errors: Diagnostic[] = [];
  readonly warnings: Diagnostic[] = [];

  error(code: DiagCode, loc: Loc, message: string): void {
    if (this.errors.length >= MAX_ERRORS) this.fatal('FX-TYPE-TOO-MANY', loc, t('誤りが多いので、ここで止めました'));
    this.errors.push({ ...loc, severity: 'error', code, message });
  }

  warn(code: DiagCode, loc: Loc, message: string): void {
    this.warnings.push({ ...loc, severity: 'warning', code, message });
  }

  fatal(code: DiagCode, loc: Loc, message: string): never {
    this.errors.push({ ...loc, severity: 'error', code, message });
    throw new FxError(message);
  }
}
