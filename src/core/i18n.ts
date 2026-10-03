import { Emitter } from './events';

// --- 画面の言語 (日本語・英語・中国語 簡体字・繁体字) ---
// 文言は日本語で書き、その日本語を鍵にして、言語ごとの辞書 (src/i18n/*.ts) から訳を引く。辞書になければ日本語のまま。
// 書き方:
//   t('ファイル')                         画面に出す文 (その場で訳す)
//   t('クローン {n} 個', { n })           {名前} は、渡した値に置き換える (語順は言語ごとに辞書で変えられる)
//   msg('プレーン')                       あとで訳す名前 (一覧などのデータに書く。そのまま返すだけ)。出すときに t(name) で訳す
// 訳さないもの: MMD のボーン・表情・マテリアルの名前、ファイル名など (データ)。MCP の説明 (外のプログラム向け)
export type Lang = 'ja' | 'en' | 'zh-Hans' | 'zh-Hant';
export const LANGS: { key: Lang; name: string }[] = [
  { key: 'ja', name: '日本語' }, { key: 'en', name: 'English' }, { key: 'zh-Hans', name: '简体中文' }, { key: 'zh-Hant', name: '繁體中文' },
];
export type Dictionary = Record<string, string>;

const dictionaries: Partial<Record<Lang, Dictionary>> = {};
let current: Lang = 'ja';
export const langEvents = new Emitter<{ changed: [Lang] }>();

export function addDictionary(lang: Lang, dict: Dictionary) {
  dictionaries[lang] = { ...dictionaries[lang], ...dict };
}
export const getLang = () => current;
export function setLang(lang: Lang) {
  if (lang === current || !LANGS.some(l => l.key === lang)) return;
  current = lang;
  langEvents.emit('changed', lang);
}

// ブラウザの言語から選ぶ (ja → 日本語、zh の台湾・香港・マカオ・Hant → 繁体字、ほかの zh → 簡体字、それ以外は英語)
export function detectLang(langs: readonly string[]): Lang {
  for (const raw of langs) {
    const l = raw.toLowerCase();
    if (l.startsWith('ja')) return 'ja';
    if (l.startsWith('zh')) return /hant|-tw|-hk|-mo/.test(l) ? 'zh-Hant' : 'zh-Hans';
    if (l.startsWith('en')) return 'en';
  }
  return 'en';
}

const fill = (s: string, params?: Record<string, string | number>) =>
  params ? s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m)) : s;

// 訳す。辞書になければ日本語 (鍵) のまま
export function t(src: string, params?: Record<string, string | number>): string {
  const d = current === 'ja' ? undefined : dictionaries[current];
  return fill(d?.[src] ?? src, params);
}
// あとで訳す名前の印 (そのまま返す)。辞書を作るとき、ここに書いた文も集める
export const msg = (src: string) => src;
