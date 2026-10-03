import { DEFORMER_KINDS, newDeformer, type Axis, type Deformer, type DeformerKind } from '../../../core/deform';
import type { SelInfo } from '../../../engine';
import { useEngine } from '../../EngineContext';
import { BSlider } from '../BSlider';
import { BCheck } from '../controls/BCheck';
import { BSelect } from '../controls/BSelect';
import { Panel } from './Panel';

// --- デフォーマ (Cinema 4D のデフォーマ): 選んでいる物を曲げる・ねじる・細くする・ふくらませる。上から順にかける ---
export function DeformerPanel({ sel }: { sel: SelInfo }) {
  const engine = useEngine();
  const list = sel.deformers ?? [];
  const setList = (l: Deformer[]) => engine.setDeformers(l);
  const update = (i: number, patch: Partial<Deformer>) => setList(list.map((d, k) => (k === i ? { ...d, ...patch } : d)));
  return (
    <Panel title="デフォーマ">
      {list.map((d, i) => {
        const k = DEFORMER_KINDS.find(x => x.key === d.kind)!;
        return (
          <div key={i} className="effector" role="group" aria-label={`デフォーマ ${i + 1} ${k.name}`}>
            <div className="effector-title">
              <BCheck checked={d.enabled} onChange={enabled => update(i, { enabled })}>{k.name}</BCheck>
              <button type="button" className="hbtn" aria-label={`${k.name}を外す`} title="外す" onClick={() => setList(list.filter((_, j) => j !== i))}>×</button>
            </div>
            <div className="prop cloner">
              <label>軸</label>
              <BSelect<Axis> label={`${k.name}の軸`} value={d.axis} onChange={axis => update(i, { axis })}
                       options={[{ value: 'y', label: 'Y (縦)' }, { value: 'x', label: 'X' }, { value: 'z', label: 'Z' }]} />
            </div>
            <BSlider label={d.kind === 'bend' || d.kind === 'twist' ? '角度' : '強さ'} value={d.amount} min={k.min} max={k.max} step={k.step}
                     digits={k.step < 1 ? 2 : 0} unit={k.unit} onChange={amount => update(i, { amount })} />
            {d.kind === 'bend' && (
              <BSlider label="向き" value={d.directionDeg} min={-180} max={180} step={1} digits={0} unit="°" onChange={directionDeg => update(i, { directionDeg })} />
            )}
          </div>
        );
      })}
      <div className="row deformer-add">
        {DEFORMER_KINDS.map(k => <button key={k.key} type="button" className="bbtn" onClick={() => setList([...list, newDeformer(k.key as DeformerKind)])}>+ {k.name}</button>)}
      </div>
      {!list.length && <div className="note">形を変えずに、曲げる・ねじる・先を細くする・まん中をふくらませることができます{sel.kind === 'model' ? ' (MMD モデルは、ボーンで動かす前の形にかけます)' : ''}</div>}
    </Panel>
  );
}
