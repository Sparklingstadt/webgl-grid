import { CLONER_DEFAULT, CLONER_MODES, EFFECTOR_KINDS, newEffector, type ClonerMode, type ClonerSettings, type Effector, type EffectorKind, type Vec3 } from '../../../core/cloner';
import type { SelInfo } from '../../../engine';
import { useEngine } from '../../EngineContext';
import { BCheck } from '../controls/BCheck';
import { BSelect } from '../controls/BSelect';
import { NumField } from '../NumField';
import { Panel } from './Panel';

// --- クローナー (Cinema 4D のクローナー): 選んでいる物を、直線・放射・グリッドに並べる ---
export function ClonerPanel({ sel }: { sel: SelInfo }) {
  const engine = useEngine();
  const c = sel.cloner;
  const set = (patch: Partial<ClonerSettings>) => engine.setCloner(patch);
  const head = <BCheck checked={!!c} label="クローナーにする" onChange={on => engine.setCloner(on ? { ...CLONER_DEFAULT } : null)} />;
  if (!c) {
    return (
      <Panel title="クローナー" head={head}>
        <div className="note">チェックを入れると、この物を直線・放射・グリッドに並べます (Cinema 4D のクローナー)。{sel.kind === 'model' ? 'MMD モデルは、全部が同じ動きで踊ります。' : ''}</div>
      </Panel>
    );
  }
  const obj = engine.selection.current;
  const n = obj ? engine.cloners.count(obj) : 0;
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
                 options={CLONER_MODES.map(m => ({ value: m.key, label: m.name }))} />
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
      <div className="note">クローン {n} 個{obj && n < (c.mode === 'grid' ? c.grid[0] * c.grid[1] * c.grid[2] : c.count) ? ' (多すぎる分は出しません)' : ''}</div>
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
      <Effectors list={c.effectors} isModel={sel.kind === 'model'} onChange={effectors => set({ effectors })} />
      {sel.kind === 'shape' && (
        <button type="button" className="bbtn" onClick={() => engine.bakeCloner()} title="クローンを 1 つずつの物にする (Cinema 4D の「現在の状態をオブジェクト化」)">1 つずつの物にする</button>
      )}
    </Panel>
  );
}

// エフェクタ (Cinema 4D の MoGraph エフェクタ) の並び。上から順にかける
function Effectors({ list, isModel, onChange }: { list: Effector[]; isModel: boolean; onChange: (l: Effector[]) => void }) {
  const update = (i: number, patch: Partial<Effector>) => onChange(list.map((e, k) => (k === i ? { ...e, ...patch } : e)));
  const add = (kind: EffectorKind) => onChange([...list, newEffector(kind)]);
  return (
    <div className="effectors">
      <div className="effectors-head">エフェクタ</div>
      {list.map((e, i) => {
        const name = EFFECTOR_KINDS.find(k => k.key === e.kind)!.name;
        return (
          <div key={i} className="effector" role="group" aria-label={`エフェクタ ${i + 1} ${name}`}>
            <div className="effector-title">
              <BCheck checked={e.enabled} onChange={enabled => update(i, { enabled })}>{name}</BCheck>
              <button type="button" className="hbtn" aria-label={`${name}を外す`} title="外す" onClick={() => onChange(list.filter((_, k) => k !== i))}>×</button>
            </div>
            {e.kind === 'delay' ? (
              <div className="prop cloner">
                <label>遅れ</label>
                <NumField label={`${name}の 1 つごとの遅れ (フレーム)`} value={e.frames} min={0} onCommit={frames => update(i, { frames })} />
              </div>
            ) : (
              <div className="prop cloner">
                <label>位置</label>
                <div className="row">
                  {(['X', 'Y', 'Z'] as const).map((axis, k) => (
                    <NumField key={axis} label={`${name}の位置 ${axis}`} value={e.position[k]} step={0.1} digits={1}
                              onCommit={v => { const p = [...e.position] as Vec3; p[k] = v; update(i, { position: p }); }} />
                  ))}
                </div>
                <label>回転</label>
                <NumField label={`${name}の回転 (度)`} value={e.rotationDeg} step={5} onCommit={rotationDeg => update(i, { rotationDeg })} />
                <label>大きさ</label>
                <NumField label={`${name}の大きさ`} value={e.scale} min={0.01} step={0.1} digits={2} onCommit={scale => update(i, { scale })} />
              </div>
            )}
          </div>
        );
      })}
      <div className="row">
        {EFFECTOR_KINDS.map(k => <button key={k.key} type="button" className="bbtn" onClick={() => add(k.key)}>+ {k.name}</button>)}
      </div>
      {list.some(e => e.kind === 'delay' && e.enabled) && (
        <div className="note">{isModel ? 'ディレイは、再生すると効きます (元のモデルの動きを覚えて、遅れて写す)' : 'ディレイは MMD モデルのクローナーで効きます'}</div>
      )}
    </div>
  );
}
