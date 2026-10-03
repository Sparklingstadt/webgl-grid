// --- MoText の文字の並べ方 (three.js を使わない計算) ---
// 文字は立てて (XY の面、前は +Z)、物の底面の中心を真ん中に並べる。下の行のベースラインが、床から少し上
export type TextUnit = 'letters' | 'words' | 'lines' | 'all';
export interface TextLayoutOptions {
  size: number;        // 文字の大きさ (em の大きさ)
  spacing: number;     // 字間 (足す幅。em の割合)
  lineSpacing: number; // 行間 (em の倍数)
  align: 'left' | 'center' | 'right';
  advance(ch: string): number; // 送り幅 (em)
}
export interface CharPlace { ch: string; x: number; y: number; line: number; word: number; index: number }
export interface TextLayout { chars: CharPlace[]; width: number; top: number; base: number }

export function layoutText(text: string, o: TextLayoutOptions): TextLayout {
  const lines = text.replace(/\r/g, '').split('\n');
  const lineH = o.lineSpacing * o.size, base = 0.22 * o.size;
  const widths = lines.map(l => [...l].reduce((w, ch, i) => w + (o.advance(ch) + (i ? o.spacing : 0)) * o.size, 0));
  const W = Math.max(...widths, 0);
  const chars: CharPlace[] = [];
  let word = 0, index = 0;
  lines.forEach((line, li) => {
    let x = o.align === 'left' ? -W / 2 : o.align === 'right' ? W / 2 - widths[li] : -widths[li] / 2;
    const y = (lines.length - 1 - li) * lineH + base;
    let inWord = false;
    [...line].forEach((ch, i) => {
      if (i) x += o.spacing * o.size;
      if (/\s/.test(ch)) { if (inWord) word++; inWord = false; }
      else { chars.push({ ch, x, y, line: li, word, index: index++ }); inWord = true; }
      x += o.advance(ch) * o.size;
    });
    if (inWord) word++;
  });
  return { chars, width: W, top: (lines.length - 1) * lineH + base + 0.8 * o.size, base };
}

// エフェクタをかける単位 (文字・単語・行・全体) ごとの、文字の番号
export function unitsOf(l: TextLayout, unit: TextUnit): number[][] {
  const groups = new Map<number, number[]>();
  l.chars.forEach((c, i) => {
    const k = unit === 'letters' ? i : unit === 'words' ? c.word : unit === 'lines' ? c.line : 0;
    const g = groups.get(k);
    if (g) g.push(i); else groups.set(k, [i]);
  });
  return [...groups.values()];
}
