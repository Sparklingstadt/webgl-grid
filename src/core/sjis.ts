// Shift-JIS に書き出す (ブラウザには書き出す機能がないので、読む機能を逆に使った対応表を初回に作る)
let sjisTable: Map<string, number[]> | null = null;

function buildTable() {
  const table = new Map<string, number[]>();
  const dec = new TextDecoder('shift_jis');
  for (let b = 0xa1; b <= 0xdf; b++) table.set(dec.decode(new Uint8Array([b])), [b]); // 半角カナ
  for (let hi = 0x81; hi <= 0xfc; hi++) {
    if (hi > 0x9f && hi < 0xe0) continue;
    for (let lo = 0x40; lo <= 0xfc; lo++) {
      if (lo === 0x7f) continue;
      const ch = dec.decode(new Uint8Array([hi, lo]));
      if (ch.length === 1 && ch !== '�' && !table.has(ch)) table.set(ch, [hi, lo]);
    }
  }
  return table;
}

export function encodeShiftJis(str: string): Uint8Array {
  sjisTable ??= buildTable();
  const out: number[] = [];
  for (const ch of str) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c);
    else out.push(...(sjisTable.get(ch) ?? [0x3f])); // 表せない文字は ?
  }
  return new Uint8Array(out);
}
