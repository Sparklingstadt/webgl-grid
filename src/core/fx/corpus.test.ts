import { describe, expect, it } from 'vitest';
import { compileEffect, type EffectResult } from './index.ts';
import { corpusFrom, rayConfVariants } from './testing/rayCorpus.ts';

// Ray-MMD 1.5.2 の .fx・.fxsub・.conf をそのまま読む (third_party/ray-mmd-1.5.2 をルートにする)
const PREFIX = '../../../third_party/ray-mmd-1.5.2/';
const raw = import.meta.glob('../../../third_party/ray-mmd-1.5.2/**/*.{fx,fxsub,conf}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

function stripPrefix(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [k.startsWith(PREFIX) ? k.slice(PREFIX.length) : k, v]));
}

const text = (b: Uint8Array) => new TextDecoder().decode(b);
const utf8 = (s: string) => new TextEncoder().encode(s);

const corpus = corpusFrom(stripPrefix(raw));
const listFiles = () => corpus.listFiles();
const entries = corpus.listFiles().filter(p => p.endsWith('.fx'));

// 失敗なら errors の先頭 5 つを「code file:line:column message」で並べて落とす
function expectOk(r: EffectResult): void {
  if (!r.ok) {
    const head = r.errors.slice(0, 5).map(e => `${e.code} ${e.file}:${e.line}:${e.column} ${e.message}`);
    expect.fail(`${r.errors.length} errors\n${head.join('\n')}`);
  }
}

describe('Ray-MMD 1.5.2', () => {
  it('Ray-MMD の .fx が 515 個ある (.fxsub 107 個・.conf 6 個も)', () => {
    expect(entries.length).toBe(515);
    expect(corpus.listFiles().filter(p => p.endsWith('.fxsub')).length).toBe(107);
    expect(corpus.listFiles().filter(p => p.endsWith('.conf')).length).toBe(6);
    expect(rayConfVariants(text(corpus.readFile('ray.conf')!)).length).toBe(52);
  });

  for (const e of entries) {
    it(`${e} をエラー 0 で変換する`, () => expectOk(compileEffect(e, p => corpus.readFile(p), { listFiles })));
  }

  for (const v of rayConfVariants(text(corpus.readFile('ray.conf')!))) {
    it(`ray.fx (${v.name})`, () => expectOk(compileEffect('ray.fx', p => (p === 'ray.conf' ? utf8(v.conf) : corpus.readFile(p)), { listFiles })));
  }

  it('rayConfVariants', () => {
    expect(rayConfVariants('// 0 : None\n// 1 : FXAA\n// 2 : SMAA\n#define AA_QUALITY 1\n').map(v => v.name)).toEqual(['AA_QUALITY=0', 'AA_QUALITY=2']);
    // 改行 (CRLF) とほかの行はそのまま。続いていない「// N :」の行は数えない
    const vs = rayConfVariants('// 0 : off\r\n\r\n// 1 : a\r\n// 2 : b // memo\r\n#define X 1\r\n#define Y 0\r\n');
    expect(vs).toEqual([{ name: 'X=2', conf: '// 0 : off\r\n\r\n// 1 : a\r\n// 2 : b // memo\r\n#define X 2\r\n#define Y 0\r\n' }]);
  });

  it('corpusFrom: ないファイルは null', () => {
    const c = corpusFrom({ 'a.fx': 'x' });
    expect(c.readFile('a.fx')).toEqual(utf8('x'));
    expect(c.readFile('b.fx')).toBeNull();
    expect(c.listFiles()).toEqual(['a.fx']);
  });
});
