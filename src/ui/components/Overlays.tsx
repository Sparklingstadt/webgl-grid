import { useLayoutEffect, useRef } from 'react';
import { PALETTE, PALETTE_NAMES, paletteCss } from '../../core/constants';
import { useEngine, useUi } from '../EngineContext';
import { BProgress } from './controls/BCheck';

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
    <div className="palette" role="group" aria-label="色" ref={ref}>
      {PALETTE.map((_, i) => (
        <button key={i} type="button" aria-label={PALETTE_NAMES[i]} aria-pressed={palette.c === i}
                style={{ background: paletteCss(i) }} onClick={() => engine.picker.pick(i)} />
      ))}
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
    <div className="modal-back">
      <div className="modal" role="dialog" aria-modal="true" aria-label="レンダリング中">
        <div className="modal-title">アニメーションをレンダリング中…</div>
        <BProgress max={r.total} value={r.done} label="レンダリングの進み具合" />
        <div className="note">{r.done} / {r.total} フレーム ({pct}%)</div>
        <div className="row"><button type="button" className="bbtn" onClick={() => engine.cancelRender()}>キャンセル (Esc)</button></div>
      </div>
    </div>
  );
}

// レンダリングした画像 (Blender のレンダーウィンドウ): 見てから保存する
export function RenderResult() {
  const engine = useEngine();
  const r = useUi(s => s.renderResult);
  if (!r) return null;
  return (
    <div className="modal-back" onPointerDown={e => { if (e.target === e.currentTarget) engine.closeRenderResult(); }}>
      <div className="modal render-result" role="dialog" aria-modal="true" aria-label="レンダー結果">
        <div className="modal-title">レンダー結果 <span className="note">{r.width} × {r.height}</span></div>
        <img src={r.url} alt="レンダリングした画像" />
        <div className="row">
          <button type="button" className="bbtn" onClick={() => engine.saveRenderResult()}>画像を保存 ({r.name})</button>
          <button type="button" className="bbtn" onClick={() => engine.closeRenderResult()}>閉じる (Esc)</button>
        </div>
      </div>
    </div>
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
    if (files.length) engine.answerMissingFiles(files);
  };
  return (
    <div className="modal-back">
      <div className="modal missing-files" role="dialog" aria-modal="true" aria-label="ファイルを探す">
        <div className="modal-title">{m.project} が参照しているファイルが見つかりません</div>
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
          <button type="button" className="bbtn" onClick={() => engine.answerMissingFiles('skip')}>見つかったものだけで開く</button>
          <button type="button" className="bbtn" onClick={() => engine.answerMissingFiles('cancel')}>やめる (Esc)</button>
        </div>
        <input type="file" ref={dirInput} hidden aria-label="フォルダを選ぶ" {...{ webkitdirectory: '' }} onChange={e => take(e.currentTarget)} />
        <input type="file" ref={fileInput} hidden multiple aria-label="ファイルを選ぶ" onChange={e => take(e.currentTarget)} />
      </div>
    </div>
  );
}
