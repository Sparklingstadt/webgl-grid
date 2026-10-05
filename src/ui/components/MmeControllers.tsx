import { t } from '../../core/i18n';
import { useEngine, useUi } from '../EngineContext';

// --- MME 互換の「コントローラー」: 描いているエフェクトが読む仮のコントローラー (ray_controller.pmx など。読み込まない) の名前ごとに、
// 場面にその名前のコントローラーの物があれば、その物を選ぶリンク (値はサイドバーの「MME」のページ)、なければ「置く」ボタン
// (勝手には置かない。押すとコントローラーの物を置いて選ぶ)。onShowValues: 選んだら「MME」のページを見せる ---
export function MmeControllers({ onShowValues }: { onShowValues?: () => void }) {
  const engine = useEngine();
  const controllers = useUi(s => s.mme.controllers);
  if (controllers.length === 0) return null;
  const show = (id: number) => {
    engine.selectById(id);
    onShowValues?.();
  };
  const place = (name: string) => {
    try {
      engine.addMmeObject({ kind: 'controller', name });
    } catch {
      return; // (置けないことは、お知らせに出ている)
    }
    onShowValues?.();
  };
  return (
    <>
      <div className="mme-head">{t('コントローラー')}</div>
      <ul className="mme-ctls" aria-label={t('仮のコントローラーの一覧')}>
        {controllers.map(c => (
          <li key={c.name} className="mme-ctl-row">
            {c.objId !== null ? (
              <button type="button" className="mme-link" title={t('{name} を選ぶ ({n} 項目)', { name: c.name, n: c.items.length })}
                      onClick={() => show(c.objId!)}>{c.name}</button>
            ) : (
              <>
                <span className="mme-name" title={t('{name} は場面にありません ({n} 項目)', { name: c.name, n: c.items.length })}>{c.name}</span>
                <button type="button" className="bbtn" aria-label={t('{name} を置く', { name: c.name })} onClick={() => place(c.name)}>{t('置く')}</button>
              </>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
