import { useMemo, useState } from 'react';
import { msg, t } from '../../../core/i18n';
import { useEngine, useUi } from '../../EngineContext';
import { BSlider } from '../BSlider';
import { Empty, NeedModel, Panel } from './Panel';

// --- 表情 (モーフ) ---
export function MorphPage() {
  return <NeedModel>{id => <MorphList key={id} />}</NeedModel>;
}
function MorphList() {
  const engine = useEngine();
  const version = useUi(s => s.modelVersion);
  useUi(s => s.values); // 値が変わったら描き直す
  const morphs = useMemo(() => { void version; return engine.morphs(); }, [engine, version]);
  const counts = [0, 0, 0, 0, 0];
  for (const m of morphs) counts[m.panel]++;
  // 表情のある最初の分類 (目・口・眉・その他の順に探す)
  const [panel, setPanel] = useState(() => [2, 3, 1, 4].find(i => counts[i]) ?? 2);
  const list = morphs.filter(m => m.panel === panel);
  return (
    <Panel title={t('表情 (モーフ)')}>
      <div className="tabs-row" role="tablist" aria-label={t('表情の分類')}>
        {([[1, msg('眉')], [2, msg('目')], [3, msg('口')], [4, msg('その他')]] as const).map(([p, label]) => (
          <button key={p} type="button" className="bbtn" role="tab" aria-selected={panel === p} disabled={!counts[p]} onClick={() => setPanel(p)}>{t(label)}</button>
        ))}
      </div>
      {!morphs.length ? <Empty>{t('このモデルには表情がありません')}</Empty>
        : !list.length ? <Empty>{t('この分類の表情はありません')}</Empty>
        : list.map(m => (
          <BSlider key={m.index} label={m.name} value={engine.morphValue(m.index)} min={0} max={1} step={0.01} onChange={v => engine.setMorph(m.index, v)} />
        ))}
      <button type="button" className="bbtn" onClick={() => engine.resetMorphs()}>{t('表情を戻す')}</button>
    </Panel>
  );
}
