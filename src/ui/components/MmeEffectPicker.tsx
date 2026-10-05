import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { errorText } from '../../core/errors';
import type { FxFolderEntry, FxListing } from '../../core/fxFolder';
import { t } from '../../core/i18n';
import { fetchFxFiles, listFxFolder } from '../../engine/io/fxFolder';
import { filesFromDrop } from '../dropFiles';
import { useEngine } from '../EngineContext';
import { Modal } from './Dialogs';

const mb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

// --- MME 互換の .fx を読む: .fx が入っているフォルダを選ぶ (ボタン) か落とす。中の .fx が 1 つならそれを、
// いくつかあれば、見つかった .fx (フォルダからの相対パス) の一覧から選んでもらう。
// アプリを配るサーバーが fx/ の一覧を教えてくれるときは、「fx/ から選ぶ」でそのフォルダを、フォルダを選んだときと同じように読む (なければ出さない) ---
// children は結果などの中身。その下にボタン (label と buttons) を並べる。落とす先は全体
export function MmeEffectPicker({ label, inputLabel, onPick, buttons, children }: {
  label: string; inputLabel: string; onPick: (files: File[], entry: string) => void; buttons?: ReactNode; children?: ReactNode;
}) {
  const engine = useEngine();
  const input = useRef<HTMLInputElement>(null);
  const [choice, setChoice] = useState<{ files: File[]; entries: string[] } | null>(null);
  // fx/ の一覧 (サーバーがなければ null で、ボタンを出さない)。fxOpen: 一覧の窓を出している。loading: 読み込み中のフォルダの名前
  const [fxList, setFxList] = useState<FxListing | null>(null);
  const [fxOpen, setFxOpen] = useState(false);
  const [loading, setLoading] = useState<{ name: string; done: number; total: number } | null>(null);
  useEffect(() => {
    let alive = true;
    void listFxFolder().then(l => { if (alive) setFxList(l); });
    return () => { alive = false; };
  }, []);
  const take = (files: File[]) => {
    if (!files.length) return;
    const entries = engine.mme.fxFilesIn(files);
    if (entries.length === 0) engine.ui.toast(t('選んだフォルダに .fx がありません'));
    else if (entries.length === 1) onPick(files, entries[0]);
    else setChoice({ files, entries });
  };
  // fx/ の一覧を開く (開くたびに取り直す)。なくなっていれば閉じたまま、ボタンも消す
  const openFx = async () => {
    const l = await listFxFolder();
    setFxList(l);
    if (l) setFxOpen(true);
  };
  // fx/ のフォルダを読み込んで、フォルダを選んだときと同じ流れ (take) に渡す
  const loadFx = async (folder: FxFolderEntry) => {
    setLoading({ name: folder.name, done: 0, total: folder.files.length });
    try {
      const files = await fetchFxFiles(folder, (done, total) => setLoading({ name: folder.name, done, total }));
      setFxOpen(false);
      if (folder.truncated) engine.ui.toast(t('{name} はファイルが多いか深すぎるので、一部だけ読み込みました', { name: folder.name }), 8000);
      take(files);
    } catch (err) {
      engine.ui.toast(t('{name} を読み込めませんでした: {error}', { name: folder.name, error: errorText(err) }), 8000);
    } finally {
      setLoading(null);
    }
  };
  // 一覧を出しているあいだは、場面のショートカットを効かせない (Esc でやめる。fx/ のフォルダを読み込んでいるあいだはやめない)
  const dialog = choice || fxOpen;
  useEffect(() => {
    if (!dialog) return;
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Escape' && !loading) { setChoice(null); setFxOpen(false); }
    };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  }, [dialog, loading]);
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
        {fxList && <button type="button" className="bbtn" onClick={() => void openFx()}>{t('fx/ から選ぶ')}</button>}
        {buttons}
      </div>
      <input type="file" ref={input} hidden aria-label={inputLabel} {...{ webkitdirectory: '' }}
             onChange={e => { const files = [...e.currentTarget.files ?? []]; e.currentTarget.value = ''; take(files); }} />
      {fxOpen && fxList && createPortal(
        <Modal label={t('fx/ のフォルダ')} title={t('どのフォルダを読みますか')} className="missing-files" onBackdrop={() => { if (!loading) setFxOpen(false); }}>
          <div className="note">{t('fx/ に置いたエフェクトのフォルダを、フォルダを選んだときと同じように読み込みます')}</div>
          <div className="mme-fx-list" role="group" aria-label={t('fx/ のフォルダの一覧')}>
            {fxList.folders.map(f => (
              <button key={f.dir} type="button" className="bbtn" disabled={!!loading} onClick={() => void loadFx(f)}>
                {f.name}
                <span className="note"> {t('.fx {n} 個', { n: f.fx.length })} · {mb(f.size)}{f.truncated && <> · {t('一部だけ')}</>}</span>
              </button>
            ))}
          </div>
          {loading && <div className="note" role="status">{t('{name} を読み込み中… ({done} / {total})', loading)}</div>}
          <div className="row"><button type="button" className="bbtn" disabled={!!loading} onClick={() => setFxOpen(false)}>{t('やめる (Esc)')}</button></div>
        </Modal>,
        document.body,
      )}
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
