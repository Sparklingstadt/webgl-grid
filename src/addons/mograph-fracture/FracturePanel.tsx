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
  const head = <BCheck checked={!!s} label="分割する" onChange={on => set(on ? { ...FRACTURE_DEFAULT } : null)} />;
  if (!o || !s) {
    return (
      <Panel title="分割" head={head}>
        <div className="note">チェックを入れると、この形を破片に分け、エフェクタで動かせます (Cinema 4D のボロノイ分割・PolyFX)。</div>
      </Panel>
    );
  }
  const problem = fracture.problems.get(o);
  return (
    <Panel title="分割" head={head}>
      <div className="prop cloner">
        <label>分け方</label>
        <BSelect<FractureMode> label="分け方" value={s.mode} onChange={mode => set({ mode })}
                               options={[{ value: 'voronoi', label: 'ボロノイ分割' }, { value: 'polyfx', label: 'PolyFX (面ごと)' }]} />
        <label>{s.mode === 'voronoi' ? '破片の数' : '最大の数'}</label>
        <NumField label="破片の数" value={s.count} min={1} max={MAX_PIECES} onCommit={count => set({ count })} />
        {s.mode === 'voronoi' && <>
          <label>散らばり</label>
          <BSelect<FractureSettings['spread']> label="点の散らばり" value={s.spread} onChange={spread => set({ spread })}
                                               options={[{ value: 'uniform', label: '一様' }, { value: 'center', label: '中心に寄せる' }, { value: 'edge', label: '外に寄せる' }]} />
          <label>シード</label>
          <NumField label="分割のシード" value={s.seed} min={0} onCommit={seed => set({ seed })} />
        </>}
        <label>すき間</label>
        <NumField label="破片のすき間" value={s.gap} min={0} max={0.9} step={0.01} digits={2} onCommit={gap => set({ gap })} />
      </div>
      {problem ? <div className="note addon-error">{problem}</div> : <div className="note">破片 {fracture.count(o)} 個</div>}
      <EffectorList list={s.effectors} c4d={c4d} isModel={false} onChange={effectors => set({ effectors })} />
    </Panel>
  );
}
