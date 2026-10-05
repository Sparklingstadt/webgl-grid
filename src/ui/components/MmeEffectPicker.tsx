import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../../core/i18n';
import { filesFromDrop } from '../dropFiles';
import { useEngine } from '../EngineContext';
import { Modal } from './Dialogs';

// --- MME 互換の .fx を読む: .fx が入っているフォルダを選ぶ (ボタン) か落とす。中の .fx が 1 つならそれを、
// いくつかあれば、見つかった .fx (フォルダからの相対パス) の一覧から選んでもらう ---
// children は結果などの中身。その下にボタン (label と buttons) を並べる。落とす先は全体
export function MmeEffectPicker({ label, inputLabel, onPick, buttons, children }: {
  label: string; inputLabel: string; onPick: (files: File[], entry: string) => void; buttons?: ReactNode; children?: ReactNode;
}) {
  const engine = useEngine();
  const input = useRef<HTMLInputElement>(null);
  const [choice, setChoice] = useState<{ files: File[]; entries: string[] } | null>(null);
  const take = (files: File[]) => {
    if (!files.length) return;
    const entries = engine.mme.fxFilesIn(files);
    if (entries.length === 0) engine.ui.toast(t('選んだフォルダに .fx がありません'));
    else if (entries.length === 1) onPick(files, entries[0]);
    else setChoice({ files, entries });
  };
  // 一覧を出しているあいだは、場面のショートカットを効かせない (Esc でやめる)
  useEffect(() => {
    if (!choice) return;
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Escape') setChoice(null);
    };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  }, [choice]);
  return (
    <div className="mme-drop"
         onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
         onDrop={e => {
           if (!e.dataTransfer.types.includes('Files')) return;
           e.preventDefault();
           void filesFromDrop(e.dataTransfer).then(take);
         }}>
      {children}
      <div className="row">
        <button type="button" className="bbtn" onClick={() => input.current?.click()}>{label}</button>
        {buttons}
      </div>
      <input type="file" ref={input} hidden aria-label={inputLabel} {...{ webkitdirectory: '' }}
             onChange={e => { const files = [...e.currentTarget.files ?? []]; e.currentTarget.value = ''; take(files); }} />
      {choice && createPortal(
        <Modal label={t('.fx を選ぶ')} title={t('どの .fx を読みますか')} className="missing-files" onBackdrop={() => setChoice(null)}>
          <div className="note">{t('フォルダに .fx がいくつかあります。読むものを選んでください')}</div>
          <div className="mme-fx-list" role="group" aria-label={t('見つかった .fx')}>
            {choice.entries.map(entry => (
              <button key={entry} type="button" className="bbtn" onClick={() => { setChoice(null); onPick(choice.files, entry); }}>{entry}</button>
            ))}
          </div>
          <div className="row"><button type="button" className="bbtn" onClick={() => setChoice(null)}>{t('やめる (Esc)')}</button></div>
        </Modal>,
        document.body,
      )}
    </div>
  );
}
