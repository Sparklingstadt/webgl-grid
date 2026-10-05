import { t } from '../../core/i18n';
import { useEngine, useUi } from '../EngineContext';
import { BSlider } from './BSlider';

// --- MME 互換の「コントローラー」: 仮のコントローラー (ray_controller.pmx など。読み込まない) のうち、場面に置いたコントローラーの物ごとに、
// 項目のスライダー (0〜1) をまとめて出す (Ray-MMD は 50 ほどあるので、見出しを押して開く)。値はその物の値 (元に戻せる)。
// 場面に物がない名前 (engine.mme.missingControllers) は出さない ---
export function MmeControllers() {
  const engine = useEngine();
  const controllers = useUi(s => s.mme.controllers);
  if (controllers.length === 0) return null;
  return (
    <>
      <div className="mme-head">{t('コントローラー')}</div>
      {controllers.map(c => (
        <details key={c.name} className="mme-ctl" aria-label={c.name}>
          <summary title={c.name}>{t('{name} ({n} 項目)', { name: c.name, n: c.items.length })}</summary>
          {c.items.map(({ item, value }) => (
            <BSlider key={item} label={item} value={value} min={0} max={1} step={0.01} onChange={v => engine.mme.setControl(c.name, item, v)} />
          ))}
        </details>
      ))}
    </>
  );
}
