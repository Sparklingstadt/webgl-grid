import { t } from '../../core/i18n';
import type { SelInfo } from '../../engine';
import { BCheck } from '../../ui/components/controls/BCheck';
import { BSelect } from '../../ui/components/controls/BSelect';
import { NumField } from '../../ui/components/NumField';
import { Panel } from '../../ui/components/sidebar/Panel';
import { useEngine } from '../../ui/EngineContext';
import type { Cinema4d } from '../cinema4d/Cinema4d';
import { EffectorList } from '../cinema4d/MoGraphFields';
import { FRACTURE_DEFAULT, MAX_PIECES, type Fracture, type FractureMode, type FractureSettings } from './Fracture';

// --- 分割 (Cinema 4D のボロノイ分割・PolyFX) のパネル ---
export function FracturePanel({ c4d, fracture }: { sel: SelInfo; c4d: Cinema4d; fracture: Fracture }) {
  const engine = useEngine();
  const o = engine.selection.current;
  const s = fracture.get(o);
  const set = (patch: Partial<FractureSettings> | null) => { if (o) fracture.set(o, patch); };
  const head = <BCheck checked={!!s} label={t('分割する')} onChange={on => set(on ? { ...FRACTURE_DEFAULT } : null)} />;
  if (!o || !s) {
    return (
      <Panel title={t('分割')} head={head}>
        <div className="note">{t('チェックを入れると、この形を破片に分け、エフェクタで動かせます (Cinema 4D のボロノイ分割・PolyFX)。')}</div>
      </Panel>
    );
  }
  const problem = fracture.problems.get(o);
  return (
    <Panel title={t('分割')} head={head}>
      <div className="prop cloner">
        <label>{t('分け方')}</label>
        <BSelect<FractureMode> label={t('分け方')} value={s.mode} onChange={mode => set({ mode })}
                               options={[{ value: 'voronoi', label: t('ボロノイ分割') }, { value: 'polyfx', label: t('PolyFX (面ごと)') }]} />
        <label>{s.mode === 'voronoi' ? t('破片の数') : t('最大の数')}</label>
        <NumField label={t('破片の数')} value={s.count} min={1} max={MAX_PIECES} onCommit={count => set({ count })} />
        {s.mode === 'voronoi' && <>
          <label>{t('散らばり')}</label>
          <BSelect<FractureSettings['spread']> label={t('点の散らばり')} value={s.spread} onChange={spread => set({ spread })}
                                               options={[{ value: 'uniform', label: t('一様') }, { value: 'center', label: t('中心に寄せる') }, { value: 'edge', label: t('外に寄せる') }]} />
          <label>{t('シード')}</label>
          <NumField label={t('分割のシード')} value={s.seed} min={0} onCommit={seed => set({ seed })} />
        </>}
        <label>{t('すき間')}</label>
        <NumField label={t('破片のすき間')} value={s.gap} min={0} max={0.9} step={0.01} digits={2} onCommit={gap => set({ gap })} />
      </div>
      {problem ? <div className="note addon-error">{t(problem)}</div> : <div className="note">{t('破片 {n} 個', { n: fracture.count(o) })}</div>}
      <EffectorList list={s.effectors} c4d={c4d} isModel={false} onChange={effectors => set({ effectors })} />
    </Panel>
  );
}
