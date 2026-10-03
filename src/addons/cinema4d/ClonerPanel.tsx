import { CLONER_DEFAULT, CLONER_MODES, type ClonerMode, type ClonerSettings, type Vec3 } from './cloner';
import { EffectorList, Params } from './MoGraphFields';
import type { SelInfo } from '../../engine';
import { useEngine } from '../../ui/EngineContext';
import type { Cinema4d } from './Cinema4d';
import { BCheck } from '../../ui/components/controls/BCheck';
import { BSelect } from '../../ui/components/controls/BSelect';
import { NumField } from '../../ui/components/NumField';
import { Panel } from '../../ui/components/sidebar/Panel';

// --- クローナー (Cinema 4D のクローナー): 選んでいる物を、直線・放射・グリッドに並べる ---
export function ClonerPanel({ sel, c4d }: { sel: SelInfo; c4d: Cinema4d }) {
  const engine = useEngine();
  const obj = engine.selection.current;
  const c = c4d.cloner(obj);
  const set = (patch: Partial<ClonerSettings>) => c4d.setCloner(patch);
  const head = <BCheck checked={!!c} label="クローナーにする" onChange={on => c4d.setCloner(on ? { ...CLONER_DEFAULT } : null)} />;
  if (!c) {
    return (
      <Panel title="クローナー" head={head}>
        <div className="note">チェックを入れると、この物を直線・放射・グリッドに並べます (Cinema 4D のクローナー)。{sel.kind === 'model' ? 'MMD モデルは、全部が同じ動きで踊ります。' : ''}</div>
      </Panel>
    );
  }
  const n = c4d.count(obj);
  const mode = c4d.modes.get(c.mode);
  const known = !!mode || CLONER_MODES.some(m => m.key === c.mode);
  const v3 = (label: string, key: 'step' | 'grid' | 'spacing', opts: { min?: number; step?: number; digits?: number }) => (
    <>
      <label>{label}</label>
      <div className="row">
        {(['X', 'Y', 'Z'] as const).map((axis, i) => (
          <NumField key={axis} label={`${label} ${axis}`} value={c[key][i]} min={opts.min} step={opts.step ?? 0.1} digits={opts.digits ?? 1}
                    onCommit={v => { const next = [...c[key]] as Vec3; next[i] = v; set({ [key]: next }); }} />
        ))}
      </div>
    </>
  );
  return (
    <Panel title="クローナー" head={head}>
      <div className="prop cloner">
        <label>並べ方</label>
        <BSelect<ClonerMode> label="クローナーの並べ方" value={c.mode} onChange={mode => set({ mode })}
                 options={[...CLONER_MODES, ...c4d.modes.list(), ...(known ? [] : [{ key: c.mode, name: `${c.mode} (登録されていない)` }])].map(m => ({ value: m.key, label: m.name }))} />
        {mode && <Params prefix="クローナーの" defs={mode.params} values={c.modeParams} onChange={modeParams => set({ modeParams })} />}
        {c.mode === 'linear' && <>
          <label>数</label>
          <NumField label="クローンの数" value={c.count} min={1} onCommit={count => set({ count })} />
          {v3('ずれ', 'step', {})}
          <label>回転</label>
          <NumField label="1 つごとの回転 (度)" value={c.stepRotDeg} step={5} onCommit={stepRotDeg => set({ stepRotDeg })} />
        </>}
        {c.mode === 'radial' && <>
          <label>数</label>
          <NumField label="クローンの数" value={c.count} min={1} onCommit={count => set({ count })} />
          <label>半径</label>
          <NumField label="半径" value={c.radius} min={0} step={0.1} digits={1} onCommit={radius => set({ radius })} />
          <label>角度</label>
          <div className="row">
            <NumField label="始めの角度 (度)" value={c.startDeg} step={5} onCommit={startDeg => set({ startDeg })} />
            <NumField label="終わりの角度 (度)" value={c.endDeg} step={5} onCommit={endDeg => set({ endDeg })} />
          </div>
        </>}
        {c.mode === 'grid' && <>
          {v3('数', 'grid', { min: 1, step: 1, digits: 0 })}
          {v3('間隔', 'spacing', {})}
        </>}
      </div>
      {c.mode === 'radial' && <BCheck checked={c.align} onChange={align => set({ align })}>外を向く</BCheck>}
      {mode?.description && <div className="note">{mode.description}</div>}
      {!known && <div className="note">この並べ方は登録されていないので、並べません (MoGraph 配置のアドオンを有効にしてください)</div>}
      <div className="note">クローン {n} 個{obj && !mode && n < (c.mode === 'grid' ? c.grid[0] * c.grid[1] * c.grid[2] : c.count) ? ' (多すぎる分は出しません)' : ''}</div>
      <details className="sub">
        <summary>ばらつき (ランダム)</summary>
        <div className="prop cloner">
          <label>位置</label>
          <NumField label="位置のばらつき" value={c.random.position} min={0} step={0.1} digits={1} onCommit={position => set({ random: { ...c.random, position } })} />
          <label>回転</label>
          <NumField label="回転のばらつき (度)" value={c.random.rotationDeg} min={0} step={5} onCommit={rotationDeg => set({ random: { ...c.random, rotationDeg } })} />
          <label>シード</label>
          <NumField label="ばらつきのシード" value={c.random.seed} min={0} onCommit={seed => set({ random: { ...c.random, seed } })} />
        </div>
      </details>
      <EffectorList list={c.effectors} c4d={c4d} isModel={sel.kind === 'model'} onChange={effectors => set({ effectors })} />
      {sel.kind === 'shape' && (
        <button type="button" className="bbtn" onClick={() => c4d.bake()} title="クローンを 1 つずつの物にする (Cinema 4D の「現在の状態をオブジェクト化」)">1 つずつの物にする</button>
      )}
    </Panel>
  );
}
