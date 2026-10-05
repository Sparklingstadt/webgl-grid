// 注釈の探し方 (名前は大文字小文字を問わない)
import type { Annotation } from '../fx/desc.ts';

export function annotation(list: Annotation[], name: string): Annotation | undefined {
  const n = name.toLowerCase();
  return list.find(a => a.name.toLowerCase() === n);
}
