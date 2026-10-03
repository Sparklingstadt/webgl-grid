import { useLayoutEffect, useRef } from 'react';
import { PALETTE, PALETTE_NAMES, paletteCss } from '../../core/constants';
import { getLang, t } from '../../core/i18n';
import { useEngine, useUi } from '../EngineContext';

// 画面上部のお知らせ (読み込み中・エラーなど)
export function Toast() {
  const toast = useUi(s => s.toast);
  return <div className="toast" role="status" hidden={!toast}>{toast?.text}</div>;
}

// スマホで形をタップしたときに出す 8 色のパレット。
// タップした位置の上に出し、画面からはみ出す場合は下に出す。左右は端から 16px 以上離す
export function Palette() {
  const engine = useEngine();
  const palette = useUi(s => s.palette);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !palette) return;
    const w = el.offsetWidth, h = el.offsetHeight, { x, y } = palette;
    el.style.left = `${Math.min(Math.max(x - w / 2, 16), innerWidth - w - 16)}px`;
    el.style.top = `${y - h - 24 >= 16 ? y - h - 24 : Math.min(y + 24, innerHeight - h - 16)}px`;
  }, [palette]);
  if (!palette) return null;
  return (
    <div className="palette" role="group" aria-label={t('色')} ref={ref}>
      {PALETTE.map((_, i) => (
        <button key={i} type="button" aria-label={t(PALETTE_NAMES[i])} aria-pressed={palette.c === i}
                style={{ background: paletteCss(i) }} onClick={() => engine.picker.pick(i)} />
      ))}
    </div>
  );
}

// 自動保存した前回の続きがあるときの知らせ (ビューポートの左下。操作のじゃまにならないよう小さく)
export function RecoverBanner() {
  const engine = useEngine();
  const r = useUi(s => s.recovery);
  if (!r?.banner) return null;
  const when = new Date(r.time).toLocaleString(getLang(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return (
    <div className="recover" role="region" aria-label={t('前回の続き')} onPointerDown={e => e.stopPropagation()}>
      <span>{t('前回の続きがあります')} <span className="note">({when}{r.name ? `・${r.name}` : ''})</span></span>
      <button type="button" className="bbtn" onClick={() => void engine.autosave.recover()}>{t('開く')}</button>
      <button type="button" className="bbtn" aria-label={t('閉じる')} onClick={() => engine.autosave.dismiss()}>×</button>
    </div>
  );
}
