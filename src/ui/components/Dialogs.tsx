import { useRef, type ReactNode } from 'react';
import { t } from '../../core/i18n';
import { useEngine, useUi } from '../EngineContext';
import { BProgress } from './controls/BProgress';

// --- 画面全体を覆う窓 (そのあいだは、場面を触れないようにする) ---
// onBackdrop: 窓の外を押したとき (なければ何もしない)
export function Modal({ label, title, className, onBackdrop, children }: {
  label: string; title: ReactNode; className?: string; onBackdrop?: () => void; children: ReactNode;
}) {
  return (
    <div className="modal-back" onPointerDown={e => { if (onBackdrop && e.target === e.currentTarget) onBackdrop(); }}>
      <div className={`modal ${className ?? ''}`} role="dialog" aria-modal="true" aria-label={label}>
        <div className="modal-title">{title}</div>
        {children}
      </div>
    </div>
  );
}

// 動画をレンダリング中: 進み具合とキャンセル (画面全体を覆い、そのあいだは場面を触れないようにする)
export function RenderProgress() {
  const engine = useEngine();
  const r = useUi(s => s.rendering);
  if (!r) return null;
  const pct = Math.round(r.done / r.total * 100);
  return (
    <Modal label={t('レンダリング中')} title={t('アニメーションをレンダリング中…')}>
      <BProgress max={r.total} value={r.done} label={t('レンダリングの進み具合')} />
      <div className="note">{t('{done} / {total} フレーム ({pct}%)', { done: r.done, total: r.total, pct })}</div>
      <div className="row"><button type="button" className="bbtn" onClick={() => engine.output.cancel()}>{t('キャンセル (Esc)')}</button></div>
    </Modal>
  );
}

// レンダリングした画像 (Blender のレンダーウィンドウ): 見てから保存する
export function RenderResult() {
  const engine = useEngine();
  const r = useUi(s => s.renderResult);
  if (!r) return null;
  return (
    <Modal label={t('レンダー結果')} title={<>{t('レンダー結果')} <span className="note">{r.width} × {r.height}</span></>} className="render-result"
         onBackdrop={() => engine.output.closeResult()}>
      <img src={r.url} alt={t('レンダリングした画像')} />
      <div className="row">
        <button type="button" className="bbtn" onClick={() => engine.output.saveResult()}>{t('画像を保存 ({name})', { name: r.name })}</button>
        <button type="button" className="bbtn" onClick={() => engine.output.closeResult()}>{t('閉じる (Esc)')}</button>
      </div>
    </Modal>
  );
}

// 参照だけのプロジェクト (.wgpj) を開くとき、見つからないファイルを探してもらう。
// フォルダを選ぶと、その中 (サブフォルダも) から名前と大きさで探す
export function MissingFiles() {
  const engine = useEngine();
  const m = useUi(s => s.missingFiles);
  const dirInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  if (!m) return null;
  const take = (input: HTMLInputElement) => {
    const files = [...input.files ?? []];
    input.value = '';
    if (files.length) engine.project.answerMissing(files);
  };
  return (
    <Modal label={t('ファイルを探す')} title={t('{project} が参照しているファイルが見つかりません', { project: m.project })} className="missing-files">
      <div className="note">{t('ファイルが入っているフォルダか、ファイルそのものを選んでください。名前と大きさで対応づけます')}</div>
      <ul aria-label={t('見つからないファイル')}>
        {m.files.map(f => (
          <li key={f.name + f.size}>
            {f.name}{f.size !== undefined && <span className="note"> ({(f.size / 1024 / 1024).toFixed(1)} MB)</span>}
            {f.source && <div className="note">{f.source}</div>}
          </li>
        ))}
      </ul>
      <div className="row">
        <button type="button" className="bbtn" onClick={() => dirInput.current?.click()}>{t('フォルダを選ぶ…')}</button>
        <button type="button" className="bbtn" onClick={() => fileInput.current?.click()}>{t('ファイルを選ぶ…')}</button>
        <button type="button" className="bbtn" onClick={() => engine.project.answerMissing('skip')}>{t('見つかったものだけで開く')}</button>
        <button type="button" className="bbtn" onClick={() => engine.project.answerMissing('cancel')}>{t('やめる (Esc)')}</button>
      </div>
      <input type="file" ref={dirInput} hidden aria-label={t('フォルダを選ぶ')} {...{ webkitdirectory: '' }} onChange={e => take(e.currentTarget)} />
      <input type="file" ref={fileInput} hidden multiple aria-label={t('ファイルを選ぶ')} onChange={e => take(e.currentTarget)} />
    </Modal>
  );
}

// .pmx のテクスチャが見つからないとき、置く前に探してもらう (フォルダを選ぶと、その中から名前で探す)
export function MissingTextures() {
  const engine = useEngine();
  const m = useUi(s => s.missingTextures);
  const dirInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  if (!m) return null;
  const take = (input: HTMLInputElement) => {
    const files = [...input.files ?? []];
    input.value = '';
    if (files.length) engine.loader.answerTextures(files);
  };
  return (
    <Modal label={t('テクスチャを探す')} title={t('{model} のテクスチャが見つかりません', { model: m.model })} className="missing-files">
      <div className="note">{t('.pmx と一緒に、テクスチャの画像を選んでいなかったようです。モデルのフォルダか、画像そのものを選ぶと、テクスチャ付きで置きます (名前で対応づけます)')}</div>
      <ul aria-label={t('見つからないテクスチャ')}>
        {m.files.map(f => <li key={f}>{f}</li>)}
      </ul>
      <div className="row">
        <button type="button" className="bbtn" onClick={() => dirInput.current?.click()}>{t('フォルダを選ぶ…')}</button>
        <button type="button" className="bbtn" onClick={() => fileInput.current?.click()}>{t('ファイルを選ぶ…')}</button>
        <button type="button" className="bbtn" onClick={() => engine.loader.answerTextures([])}>{t('テクスチャなしで置く (Esc)')}</button>
      </div>
      <input type="file" ref={dirInput} hidden aria-label={t('テクスチャのフォルダを選ぶ')} {...{ webkitdirectory: '' }} onChange={e => take(e.currentTarget)} />
      <input type="file" ref={fileInput} hidden multiple accept="image/*,.tga,.bmp,.spa,.sph" aria-label={t('テクスチャの画像を選ぶ')} onChange={e => take(e.currentTarget)} />
    </Modal>
  );
}

