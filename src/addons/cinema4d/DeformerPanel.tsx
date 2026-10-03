import { t } from '../../core/i18n';
import { DEFORMER_KINDS, newDeformer, type Axis, type Deformer, type DeformerKind } from './deform';
import type { SelInfo } from '../../engine';
import { useEngine } from '../../ui/EngineContext';
import type { Cinema4d } from './Cinema4d';
import { BSlider } from '../../ui/components/BSlider';
import { BCheck } from '../../ui/components/controls/BCheck';
import { BSelect } from '../../ui/components/controls/BSelect';
import { Panel } from '../../ui/components/sidebar/Panel';

// --- デフォーマ (Cinema 4D のデフォーマ): 選んでいる物を曲げる・ねじる・細くする・ふくらませる。上から順にかける ---
export function DeformerPanel({ sel, c4d }: { sel: SelInfo; c4d: Cinema4d }) {
  const engine = useEngine();
  const list = c4d.deformerList(engine.selection.current);
  const setList = (l: Deformer[]) => c4d.setDeformers(l);
  const update = (i: number, patch: Partial<Deformer>) => setList(list.map((d, k) => (k === i ? { ...d, ...patch } : d)));
  return (
    <Panel title={t('デフォーマ')}>
      {list.map((d, i) => {
        const k = DEFORMER_KINDS.find(x => x.key === d.kind)!;
        const name = t(k.name);
        return (
          <div key={i} className="effector" role="group" aria-label={t('デフォーマ {n} {name}', { n: i + 1, name })}>
            <div className="effector-title">
              <BCheck checked={d.enabled} onChange={enabled => update(i, { enabled })}>{name}</BCheck>
              <button type="button" className="hbtn" aria-label={t('{name}を外す', { name })} title={t('外す')} onClick={() => setList(list.filter((_, j) => j !== i))}>×</button>
            </div>
            <div className="prop cloner">
              <label>{t('軸')}</label>
              <BSelect<Axis> label={t('{name}の軸', { name })} value={d.axis} onChange={axis => update(i, { axis })}
                       options={[{ value: 'y', label: t('Y (縦)') }, { value: 'x', label: 'X' }, { value: 'z', label: 'Z' }]} />
            </div>
            <BSlider label={d.kind === 'bend' || d.kind === 'twist' ? t('角度') : t('強さ')} value={d.amount} min={k.min} max={k.max} step={k.step}
                     digits={k.step < 1 ? 2 : 0} unit={k.unit} onChange={amount => update(i, { amount })} />
            {d.kind === 'bend' && (
              <BSlider label={t('向き')} value={d.directionDeg} min={-180} max={180} step={1} digits={0} unit="°" onChange={directionDeg => update(i, { directionDeg })} />
            )}
          </div>
        );
      })}
      <div className="row deformer-add">
        {DEFORMER_KINDS.map(k => <button key={k.key} type="button" className="bbtn" onClick={() => setList([...list, newDeformer(k.key as DeformerKind)])}>+ {t(k.name)}</button>)}
      </div>
      {!list.length && <div className="note">{t('形を変えずに、曲げる・ねじる・先を細くする・まん中をふくらませることができます')}{sel.kind === 'model' ? ` ${t('(MMD モデルは、ボーンで動かす前の形にかけます)')}` : ''}</div>}
    </Panel>
  );
}
