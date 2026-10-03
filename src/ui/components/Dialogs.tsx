import { useRef, type ReactNode } from 'react';
import { useEngine, useUi } from '../EngineContext';
import { BProgress } from './controls/BProgress';

// --- 画面全体を覆う窓 (そのあいだは、場面を触れないようにする) ---
// onBackdrop: 窓の外を押したとき (なければ何もしない)
function Modal({ label, title, className, onBackdrop, children }: {
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
    <Modal label="レンダリング中" title="アニメーションをレンダリング中…">
      <BProgress max={r.total} value={r.done} label="レンダリングの進み具合" />
      <div className="note">{r.done} / {r.total} フレーム ({pct}%)</div>
      <div className="row"><button type="button" className="bbtn" onClick={() => engine.output.cancel()}>キャンセル (Esc)</button></div>
    </Modal>
  );
}

// レンダリングした画像 (Blender のレンダーウィンドウ): 見てから保存する
export function RenderResult() {
  const engine = useEngine();
  const r = useUi(s => s.renderResult);
  if (!r) return null;
  return (
    <Modal label="レンダー結果" title={<>レンダー結果 <span className="note">{r.width} × {r.height}</span></>} className="render-result"
         onBackdrop={() => engine.output.closeResult()}>
      <img src={r.url} alt="レンダリングした画像" />
      <div className="row">
        <button type="button" className="bbtn" onClick={() => engine.output.saveResult()}>画像を保存 ({r.name})</button>
        <button type="button" className="bbtn" onClick={() => engine.output.closeResult()}>閉じる (Esc)</button>
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
    <Modal label="ファイルを探す" title={`${m.project} が参照しているファイルが見つかりません`} className="missing-files">
      <div className="note">ファイルが入っているフォルダか、ファイルそのものを選んでください。名前と大きさで対応づけます</div>
      <ul aria-label="見つからないファイル">
        {m.files.map(f => (
          <li key={f.name + f.size}>
            {f.name}{f.size !== undefined && <span className="note"> ({(f.size / 1024 / 1024).toFixed(1)} MB)</span>}
            {f.source && <div className="note">{f.source}</div>}
          </li>
        ))}
      </ul>
      <div className="row">
        <button type="button" className="bbtn" onClick={() => dirInput.current?.click()}>フォルダを選ぶ…</button>
        <button type="button" className="bbtn" onClick={() => fileInput.current?.click()}>ファイルを選ぶ…</button>
        <button type="button" className="bbtn" onClick={() => engine.project.answerMissing('skip')}>見つかったものだけで開く</button>
        <button type="button" className="bbtn" onClick={() => engine.project.answerMissing('cancel')}>やめる (Esc)</button>
      </div>
      <input type="file" ref={dirInput} hidden aria-label="フォルダを選ぶ" {...{ webkitdirectory: '' }} onChange={e => take(e.currentTarget)} />
      <input type="file" ref={fileInput} hidden multiple aria-label="ファイルを選ぶ" onChange={e => take(e.currentTarget)} />
    </Modal>
  );
}
