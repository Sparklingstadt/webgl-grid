// MME の DefaultEffect 注釈: 「物の名前のパターン = 動作;」の並び。オフスクリーンのなかで、どの .fx で物を描くかを決める
import { normalizePath } from '../fx/source.ts';
import { t } from '../i18n.ts';

export type DefaultAction = { kind: 'effect'; path: string } | { kind: 'hide' } | { kind: 'none' };
export interface DefaultRule { pattern: string; action: DefaultAction }

// "self = hide;*= ./a.fx;" (隣り合う文字列リテラルは連結済み) を読む。壊れた項は警告して捨てる
export function parseDefaultEffect(text: string): { rules: DefaultRule[]; warnings: string[] } {
  const rules: DefaultRule[] = [];
  const warnings: string[] = [];
  const items = text.split(';');
  // 最後の ; のあとの空は項ではない
  if (items.length > 0 && items[items.length - 1].trim() === '') items.pop();
  for (const raw of items) {
    const item = raw.trim();
    if (item === '') {
      warnings.push(t('DefaultEffect に空の項があるので無視します'));
      continue;
    }
    const eq = item.indexOf('=');
    if (eq < 0) {
      warnings.push(t('DefaultEffect の項 "{item}" に = がないので無視します', { item }));
      continue;
    }
    const pattern = item.slice(0, eq).trim();
    const value = item.slice(eq + 1).trim();
    const lower = value.toLowerCase();
    const action: DefaultAction | null = lower === 'hide' ? { kind: 'hide' }
      : lower === 'none' ? { kind: 'none' }
      : normalizePath(value) !== '' ? { kind: 'effect', path: normalizePath(value) }
      : null;
    if (pattern === '' || action === null) {
      warnings.push(t('DefaultEffect の項 "{item}" のパターンか動作が空なので無視します', { item }));
      continue;
    }
    rules.push({ pattern, action });
  }
  return { rules, warnings };
}

// `*` は 0 文字以上、`?` は 1 文字。大文字小文字を無視して全体で合うか (正規表現にせず、戻りは最後の * だけ)
export function matchName(pattern: string, name: string): boolean {
  const p = pattern.toLowerCase();
  const s = name.toLowerCase();
  let pi = 0;
  let si = 0;
  let star = -1;
  let mark = 0;
  while (si < s.length) {
    if (pi < p.length && p[pi] === '*') { star = pi++; mark = si; }
    else if (pi < p.length && (p[pi] === '?' || p[pi] === s[si])) { pi++; si++; }
    else if (star >= 0) { pi = star + 1; si = ++mark; }
    else return false;
  }
  while (pi < p.length && p[pi] === '*') pi++;
  return pi === p.length;
}

// 上から順に最初に合う規則の動作。パターン self は isSelf (宣言している .fx を持つ物自身) のときだけ合う。どれにも合わなければ null (描かない)
export function resolveDefault(rules: DefaultRule[], name: string, isSelf: boolean): DefaultAction | null {
  for (const rule of rules) {
    if (rule.pattern.toLowerCase() === 'self' ? isSelf : matchName(rule.pattern, name)) return rule.action;
  }
  return null;
}
