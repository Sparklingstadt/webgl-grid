import type { Obj } from '../types';

// --- MME のチャンネル (物ごとの名前の一覧) ---
// キーフレームの MME のチャンネル (core/animation.ts の Animation.mme) は、物の mmeChannels の位置を番号にする。
// 名前は、仮のコントローラーの項目 (SSAO+)、仮のアクセサリの値 (X〜Tr)、.fx のパラメータ (<フォルダの id>/<.fx のパス>:<名前>)。
// 番号をキーが覚えているので、一覧からは消さず、並べ替えない

// 名前のチャンネルの番号。なければ一覧の後ろに足す
export function mmeChannel(obj: Obj, name: string): number {
  const list = obj.mmeChannels ??= [];
  const i = list.indexOf(name);
  if (i >= 0) return i;
  list.push(name);
  return list.length - 1;
}

// 保存されていた値をそろえる (物の値 mmeChannels・mmeValues)。番号は位置なので、名前の一覧は詰めない
export function normalizeMmeChannels(raw: unknown): string[] | null {
  return Array.isArray(raw) && raw.length ? raw.map(n => (typeof n === 'string' ? n : String(n))) : null;
}
export function normalizeMmeValues(raw: unknown): Record<string, number> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entries = Object.entries(raw).filter((e): e is [string, number] => typeof e[1] === 'number' && Number.isFinite(e[1]));
  return entries.length ? Object.fromEntries(entries) : null;
}
