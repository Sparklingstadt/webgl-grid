import { useEffect, useState } from 'react';
import { errorText } from '../../core/errors';
import { t } from '../../core/i18n';
import type { ModelFolderEntry, ModelsListing, FolderFileEntry } from '../../core/models';
import { fetchFolderFile, fetchModelFiles, listModelFolder } from '../../engine/io/modelsFolder';
import { useEngine, useUi } from '../EngineContext';

const mb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const isEmpty = (l: ModelsListing) => !l.models.length && !l.motions.length && !l.poses.length;

// --- models/ フォルダのモデル・モーション・ポーズを、一覧から選んで読み込む (起動したときと、ファイル > models フォルダから読み込む…) ---
// 一覧は、アプリを配っているサーバー (開発サーバー・プレビュー・MCP サーバー) が教えてくれる。なければ出さない。
// モーション (.vmd)・ポーズと表情 (.vpd) は、選んでいるモデルに付ける (選んでいなければ、置いてあるモデル全員に)。
// 続けて選べるよう、読み込んでも閉じない。
// (?nomodels を付けて開くと、起動したときには出さない)
export function ModelPicker() {
  const engine = useEngine();
  const open = useUi(s => s.modelPicker);
  const sel = useUi(s => s.sel);
  useUi(s => s.modelVersion);
  const [list, setList] = useState<ModelsListing | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  // 起動したとき: 何かあれば一覧を出す
  useEffect(() => {
    let alive = true;
    void listModelFolder().then(l => {
      if (!alive) return;
      setList(l);
      if (!isEmpty(l) && !new URLSearchParams(location.search).has('nomodels')) engine.ui.set({ modelPicker: true });
    });
    return () => { alive = false; };
  }, [engine]);
  // メニューから開いたとき: 一覧を取り直す
  useEffect(() => { if (open) void listModelFolder().then(setList); }, [open]);
  if (!open || !list) return null;
  const close = () => engine.ui.set({ modelPicker: false });
  const run = async (key: string, name: string, fn: () => Promise<void>) => {
    setLoading(key);
    try { await fn(); } catch (err) {
      engine.ui.toast(t('{name} を読み込めませんでした: {error}', { name, error: errorText(err) }), 8000);
    } finally { setLoading(null); }
  };
  const loadModel = (m: ModelFolderEntry) => run(m.pmx, m.name, async () => {
    const files = await fetchModelFiles(m, (done, total) => engine.ui.toast(t('{name} を読み込み中… ({done} / {total})', { name: m.name, done, total }), 0));
    await engine.loadFiles(files);
  });
  // モーション・ポーズ: 選んでいるモデルに (なければ全員に) 付ける
  const loadFile = (m: FolderFileEntry) => run(m.path, m.name, async () => {
    engine.ui.toast(t('{name} を読み込み中…', { name: m.name }), 0);
    await engine.loadFiles([await fetchFolderFile(m)], { toSelected: true });
  });
  const hasModel = engine.world.models.length > 0;
  const target = sel?.kind === 'model' ? sel.name : null;
  const where = target ? t('選んでいる {name} に付けます', { name: target }) : t('置いてあるモデル全員に付けます (モデルを選ぶと、そのモデルだけに)');
  const section = (title: string, label: string, files: FolderFileEntry[], note: string) => files.length > 0 && <>
    <div className="model-picker-sub">{title}</div>
    <div className="note">{note}</div>
    <ul aria-label={label}>
      {files.map(m => (
        <li key={m.path}>
          <button type="button" className="bbtn" disabled={!!loading} onClick={() => void loadFile(m)} title={`models/${m.path}`}>
            {m.name}
            <span className="note"> {m.folder ? `${m.folder} · ` : ''}{mb(m.size)}</span>
          </button>
        </li>
      ))}
    </ul>
  </>;
  return (
    <div className="model-picker" role="region" aria-label={t('models フォルダのモデル')} onPointerDown={e => e.stopPropagation()}>
      <div className="model-picker-head">
        <b>{t('models フォルダのモデル')}</b>
        <button type="button" className="hbtn" aria-label={t('閉じる')} onClick={close}>×</button>
      </div>
      {isEmpty(list) && (
        <div className="note">{t('models フォルダにモデルがありません。モデルのフォルダ (.pmx とテクスチャ) を models/ に置くと、ここから選べます')}</div>
      )}
      {list.models.length > 0 && <>
        <div className="model-picker-sub">{t('モデル')}</div>
        <ul aria-label={t('モデルの一覧')}>
          {list.models.map(m => (
            <li key={m.pmx}>
              <button type="button" className="bbtn" disabled={!!loading} onClick={() => void loadModel(m)} title={`models/${m.pmx}`}>
                {m.name}
                <span className="note"> {m.folder && m.folder !== m.name ? `${m.folder} · ` : ''}{t('テクスチャ {n} 枚', { n: m.files.length })} · {mb(m.size)}</span>
              </button>
            </li>
          ))}
        </ul>
      </>}
      {section(t('モーション'), t('モーションの一覧'), list.motions,
        hasModel ? where : t('モデルを置いてから選ぶと、モデルに付けます (カメラのモーションは、いつでもカメラに)'))}
      {section(t('ポーズ・表情'), t('ポーズの一覧'), list.poses, hasModel ? where : t('モデルを置いてから選ぶと、モデルにポーズと表情を当てます'))}
    </div>
  );
}
