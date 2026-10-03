import { useState } from 'react';
import { msg, t } from '../../core/i18n';
import type { SelInfo } from '../../engine';
import { BCheck } from '../../ui/components/controls/BCheck';
import { BSelect } from '../../ui/components/controls/BSelect';
import { NumField } from '../../ui/components/NumField';
import { Panel } from '../../ui/components/sidebar/Panel';
import { useEngine } from '../../ui/EngineContext';
import type { Cinema4d } from '../cinema4d/Cinema4d';
import { EffectorList } from '../cinema4d/MoGraphFields';
import type { TextUnit } from './layout';
import { TEXT_DEFAULT, type MoText, type TextSettings } from './MoText';

const FONTS = [
  { value: 'sans-serif', label: msg('ゴシック (sans-serif)') }, { value: 'serif', label: msg('明朝 (serif)') },
  { value: 'monospace', label: msg('等幅 (monospace)') }, { value: 'cursive', label: msg('手書き風 (cursive)') }, { value: 'custom', label: msg('フォントの名前を書く…') },
];
const UNITS: { value: TextUnit; label: string }[] = [
  { value: 'letters', label: msg('文字ごと') }, { value: 'words', label: msg('単語ごと') }, { value: 'lines', label: msg('行ごと') }, { value: 'all', label: msg('全体') },
];
// 単位の数の説明 ({n} は数)
const UNIT_NOTES: Record<TextUnit, string> = {
  letters: msg('{n} 個の文字に、エフェクタをかけます。文字の形は、このパソコンのフォントから作ります'),
  words: msg('{n} 個の単語に、エフェクタをかけます。文字の形は、このパソコンのフォントから作ります'),
  lines: msg('{n} 個の行に、エフェクタをかけます。文字の形は、このパソコンのフォントから作ります'),
  all: msg('{n} 個の全体に、エフェクタをかけます。文字の形は、このパソコンのフォントから作ります'),
};
const tr = <V,>(l: { value: V; label: string }[]) => l.map(o => ({ value: o.value, label: t(o.label) }));

// --- MoText (Cinema 4D の MoText) のパネル ---
export function TextPanel({ c4d, motext }: { sel: SelInfo; c4d: Cinema4d; motext: MoText }) {
  const engine = useEngine();
  const o = engine.selection.current;
  const s = motext.get(o);
  const [custom, setCustom] = useState(false);
  const set = (patch: Partial<TextSettings> | null) => { if (o) motext.set(o, patch); };
  const head = <BCheck checked={!!s} label={t('テキストにする')} onChange={on => set(on ? { ...TEXT_DEFAULT } : null)} />;
  if (!o || !s) {
    return <Panel title={t('テキスト (MoText)')} head={head}><div className="note">{t('チェックを入れると、この形を厚みのある文字にして、文字・単語・行ごとにエフェクタで動かせます (Cinema 4D の MoText)。')}</div></Panel>;
  }
  const preset = FONTS.some(f => f.value === s.font) && !custom;
  const problem = motext.problems.get(o);
  return (
    <Panel title={t('テキスト (MoText)')} head={head}>
      <TextArea value={s.text} onCommit={text => set({ text })} />
      <div className="prop cloner">
        <label>{t('フォント')}</label>
        <BSelect<string> label={t('フォント')} value={preset ? s.font : 'custom'} options={tr(FONTS)}
                         onChange={v => { if (v === 'custom') setCustom(true); else { setCustom(false); set({ font: v }); } }} />
        {!preset && <>
          <label>{t('名前')}</label>
          <FontName value={s.font} onCommit={font => set({ font })} />
        </>}
        <label>{t('太字')}</label>
        <BCheck checked={s.weight === 'bold'} label={t('太字')} onChange={b => set({ weight: b ? 'bold' : 'normal' })} />
        <label>{t('大きさ')}</label>
        <NumField label={t('文字の大きさ')} value={s.size} min={0.05} step={0.1} digits={2} onCommit={size => set({ size })} />
        <label>{t('厚み')}</label>
        <NumField label={t('文字の厚み')} value={s.depth} min={0.001} step={0.05} digits={2} onCommit={depth => set({ depth })} />
        <label>{t('面取り')}</label>
        <NumField label={t('文字の面取り')} value={s.bevel} min={0} max={0.5} step={0.05} digits={2} onCommit={bevel => set({ bevel })} />
        <label>{t('字間')}</label>
        <NumField label={t('字間')} value={s.spacing} min={-0.5} max={2} step={0.02} digits={2} onCommit={spacing => set({ spacing })} />
        <label>{t('行間')}</label>
        <NumField label={t('行間')} value={s.lineSpacing} min={0.3} max={5} step={0.1} digits={2} onCommit={lineSpacing => set({ lineSpacing })} />
        <label>{t('揃え')}</label>
        <BSelect<TextSettings['align']> label={t('揃え')} value={s.align} onChange={align => set({ align })}
                                        options={[{ value: 'left', label: t('左') }, { value: 'center', label: t('中央') }, { value: 'right', label: t('右') }]} />
        <label>{t('かける単位')}</label>
        <BSelect<TextUnit> label={t('エフェクタをかける単位')} value={s.unit} onChange={unit => set({ unit })} options={tr(UNITS)} />
      </div>
      {problem ? <div className="note addon-error">{t(problem)}</div> : <div className="note">{t(UNIT_NOTES[s.unit], { n: motext.count(o) })}</div>}
      <EffectorList list={s.effectors} c4d={c4d} isModel={false} onChange={effectors => set({ effectors })} />
    </Panel>
  );
}

// 文字の欄 (複数行。欄を離れるか Ctrl+Enter で決める)
function TextArea({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const done = () => { if (draft !== null && draft !== value) onCommit(draft); setDraft(null); };
  return (
    <textarea className="text-field motext-text" aria-label={t('テキスト')} rows={Math.min(Math.max((draft ?? value).split('\n').length, 2), 6)} value={draft ?? value} spellCheck={false}
              onChange={e => setDraft(e.currentTarget.value)} onBlur={done}
              onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.currentTarget.blur(); } if (e.key === 'Escape') { setDraft(null); e.currentTarget.blur(); } }} />
  );
}
function FontName({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input className="text-field" type="text" aria-label={t('フォントの名前')} placeholder={t('例: Hiragino Mincho ProN')} value={draft ?? value} spellCheck={false}
           onChange={e => setDraft(e.currentTarget.value)}
           onBlur={() => { if (draft !== null && draft.trim() && draft !== value) onCommit(draft.trim()); setDraft(null); }}
           onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
  );
}
