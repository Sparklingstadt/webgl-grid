import { addDictionary, detectLang, LANGS, langEvents, setLang, type Lang } from '../core/i18n';
import en from './en';
import zhHans from './zh-Hans';
import zhHant from './zh-Hant';

// --- 画面の言語を始める: 辞書を入れ、前に選んだ言語 (なければブラウザの言語) にする ---
addDictionary('en', en);
addDictionary('zh-Hans', zhHans);
addDictionary('zh-Hant', zhHant);

const KEY = 'webgl-grid.lang';
const htmlLang: Record<Lang, string> = { ja: 'ja', en: 'en', 'zh-Hans': 'zh-Hans', 'zh-Hant': 'zh-Hant' };
langEvents.on('changed', l => {
  try { localStorage.setItem(KEY, l); } catch { /* (覚えられないときは、覚えないだけ) */ }
  if (typeof document !== 'undefined') document.documentElement.lang = htmlLang[l];
});

export function startLang() {
  let saved: string | null = null;
  try { saved = localStorage.getItem(KEY); } catch { /* */ }
  const lang = LANGS.some(l => l.key === saved) ? saved as Lang : detectLang(typeof navigator !== 'undefined' ? navigator.languages ?? [navigator.language] : []);
  setLang(lang);
  if (typeof document !== 'undefined') document.documentElement.lang = htmlLang[lang];
}
