import { t } from '../../core/i18n';
import type { SelInfo } from '../../engine';
import { BCheck } from '../../ui/components/controls/BCheck';
import { NumField } from '../../ui/components/NumField';
import { Panel } from '../../ui/components/sidebar/Panel';
import { useEngine } from '../../ui/EngineContext';
import type { Cinema4d } from '../cinema4d/Cinema4d';
import { EffectorList } from '../cinema4d/MoGraphFields';
import { EXTRUDE_DEFAULT, type Extrude, type ExtrudeSettings } from './Extrude';

// --- MoExtrude (Cinema 4D の MoExtrude) のパネル ---
export function ExtrudePanel({ c4d, extrude }: { sel: SelInfo; c4d: Cinema4d; extrude: Extrude }) {
  const engine = useEngine();
  const o = engine.selection.current;
  const s = extrude.get(o);
  const set = (patch: Partial<ExtrudeSettings> | null) => { if (o) extrude.set(o, patch); };
  const head = <BCheck checked={!!s} label={t('押し出す')} onChange={on => set(on ? { ...EXTRUDE_DEFAULT } : null)} />;
  if (!o || !s) {
    return (
      <Panel title="MoExtrude" head={head}>
        <div className="note">{t('チェックを入れると、この形の面をエフェクタに合わせて押し出します (Cinema 4D の MoExtrude)。')}</div>
      </Panel>
    );
  }
  const problem = extrude.problems.get(o);
  return (
    <Panel title="MoExtrude" head={head}>
      <div className="prop cloner">
        <label>{t('長さ')}</label>
        <NumField label={t('押し出す長さ')} value={s.offset} min={-10} max={10} step={0.05} digits={2} onCommit={offset => set({ offset })} />
        <label>{t('段の数')}</label>
        <NumField label={t('押し出しの段の数')} value={s.steps} min={1} max={20} onCommit={steps => set({ steps })} />
        <label>{t('ふたの大きさ')}</label>
        <NumField label={t('押し出した先の大きさ')} value={s.capScale} min={0} max={5} step={0.05} digits={2} onCommit={capScale => set({ capScale })} />
      </div>
      {problem ? <div className="note addon-error">{t(problem)}</div> : <div className="note">{t('面 {n} 個。エフェクタの大きさで長さが変わり、位置で先がずれます', { n: extrude.faceCount(o) })}</div>}
      <EffectorList list={s.effectors} c4d={c4d} isModel={false} onChange={effectors => set({ effectors })} />
    </Panel>
  );
}
