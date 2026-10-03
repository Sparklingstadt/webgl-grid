import { describe, expect, it } from 'vitest';
import { addDictionary, detectLang, msg, setLang, t } from '../core/i18n';
import en from './en';
import zhHans from './zh-Hans';
import zhHant from './zh-Hant';

// 画面の文 (src の t('…')・msg('…') に書いた日本語) を集める (テストと辞書と、取り込んだ部品を除く)
const files = import.meta.glob(['../**/*.ts', '../**/*.tsx', '!../**/*.test.*', '!../vendor/**', '!../i18n/**', '!../core/i18n.ts'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const sources = () => Object.values(files);
export function keysOf(code: string[]) {
  const keys = new Set<string>();
  const re = /\b(?:t|msg)\(\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\$]|\\.)*)`)/g;
  for (const c of code) for (const m of c.matchAll(re)) {
    const raw = m[1] ?? m[2] ?? m[3];
    keys.add(raw.replace(/\\(['"`\\])/g, '$1').replace(/\\n/g, '\n'));
  }
  return keys;
}
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');

describe('画面の言語', () => {
  it('訳を引き、{名前} を置き換える。辞書になければ日本語のまま', () => {
    addDictionary('en', { 'テストの文 {n} 個': '{n} test items' });
    setLang('en');
    expect(t('テストの文 {n} 個', { n: 3 })).toBe('3 test items');
    expect(t('辞書にない文')).toBe('辞書にない文');
    setLang('ja');
    expect(t('テストの文 {n} 個', { n: 3 })).toBe('テストの文 3 個');
    expect(msg('名前')).toBe('名前');
  });
  it('ブラウザの言語から選ぶ', () => {
    expect(detectLang(['ja-JP'])).toBe('ja');
    expect(detectLang(['zh-TW'])).toBe('zh-Hant');
    expect(detectLang(['zh-Hant-HK'])).toBe('zh-Hant');
    expect(detectLang(['zh-CN'])).toBe('zh-Hans');
    expect(detectLang(['fr-FR', 'en-US'])).toBe('en');
    expect(detectLang(['de'])).toBe('en');
  });
  const keys = keysOf(sources());
  for (const [name, dict] of [['英語', en], ['中国語 (簡体字)', zhHans], ['中国語 (繁体字)', zhHant]] as const) {
    it(`${name}の辞書に、画面の文が全部あり、{名前} がそろっている`, () => {
      const missing = [...keys].filter(k => !(k in dict));
      expect(missing).toEqual([]);
      const wrong = Object.entries(dict).filter(([k, v]) => keys.has(k) && placeholders(k) !== placeholders(v)).map(([k]) => k);
      expect(wrong).toEqual([]);
    });
  }
});
