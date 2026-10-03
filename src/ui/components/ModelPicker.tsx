import { useEffect, useState } from 'react';
import { t } from '../../core/i18n';
import type { ModelFolderEntry } from '../../core/models';
import { errorText } from '../../core/errors';
import { fetchModelFiles, listModelFolder } from '../../engine/io/modelsFolder';
import { useEngine, useUi } from '../EngineContext';

// --- models/ フォルダのモデルを、一覧から選んで読み込む (起動したときと、ファイル > models フォルダから読み込む…) ---
// 一覧は、アプリを配っているサーバー (開発サーバー・プレビュー・MCP サーバー) が教えてくれる。なければ出さない。
// (?nomodels を付けて開くと、起動したときには出さない)
export function ModelPicker() {
  const engine = useEngine();
  const open = useUi(s => s.modelPicker);
  const [models, setModels] = useState<ModelFolderEntry[] | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  // 起動したとき: モデルがあれば一覧を出す
  useEffect(() => {
    let alive = true;
    void listModelFolder().then(list => {
      if (!alive) return;
      setModels(list);
      if (list.length && !new URLSearchParams(location.search).has('nomodels')) engine.ui.set({ modelPicker: true });
    });
    return () => { alive = false; };
  }, [engine]);
  // メニューから開いたとき: 一覧を取り直す
  useEffect(() => { if (open) void listModelFolder().then(setModels); }, [open]);
  if (!open || !models) return null;
  const close = () => engine.ui.set({ modelPicker: false });
  const load = async (m: ModelFolderEntry) => {
    setLoading(m.pmx);
    try {
      const files = await fetchModelFiles(m, (done, total) => engine.ui.toast(t('{name} を読み込み中… ({done} / {total})', { name: m.name, done, total }), 0));
      close();
      await engine.loadFiles(files);
    } catch (err) {
      engine.ui.toast(t('{name} を読み込めませんでした: {error}', { name: m.name, error: errorText(err) }), 8000);
    } finally { setLoading(null); }
  };
  return (
    <div className="model-picker" role="region" aria-label={t('models フォルダのモデル')} onPointerDown={e => e.stopPropagation()}>
      <div className="model-picker-head">
        <b>{t('models フォルダのモデル')}</b>
        <button type="button" className="hbtn" aria-label={t('閉じる')} onClick={close}>×</button>
      </div>
      {models.length ? (
        <ul aria-label={t('モデルの一覧')}>
          {models.map(m => (
            <li key={m.pmx}>
              <button type="button" className="bbtn" disabled={!!loading} onClick={() => void load(m)} title={`models/${m.pmx}`}>
                {m.name}
                <span className="note"> {m.folder && m.folder !== m.name ? `${m.folder} · ` : ''}{t('テクスチャ {n} 枚', { n: m.files.length })} · {(m.size / 1024 / 1024).toFixed(1)} MB</span>
              </button>
            </li>
          ))}
        </ul>
      ) : <div className="note">{t('models フォルダにモデルがありません。モデルのフォルダ (.pmx とテクスチャ) を models/ に置くと、ここから選べます')}</div>}
    </div>
  );
}
