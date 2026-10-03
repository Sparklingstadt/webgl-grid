import { CLONER_DEFAULT, CLONER_MODES, type ClonerMode, type ClonerSettings, type Effector, type Vec3 } from './cloner';
import { newEffector, paramOf, type EffectorDef, type EffectorParam, type EffectorValue } from './effectors';
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
      <Effectors list={c.effectors} defs={c4d.effectors.list()} isModel={sel.kind === 'model'} onChange={effectors => set({ effectors })} />
      {sel.kind === 'shape' && (
        <button type="button" className="bbtn" onClick={() => c4d.bake()} title="クローンを 1 つずつの物にする (Cinema 4D の「現在の状態をオブジェクト化」)">1 つずつの物にする</button>
      )}
    </Panel>
  );
}

// エフェクタ (Cinema 4D の MoGraph エフェクタ) の並び。上から順にかける。
// 足せる種類と、種類ごとの設定の欄は、登録されたエフェクタ (MoGraph エフェクタのアドオン) から作る
function Effectors({ list, defs, isModel, onChange }: { list: Effector[]; defs: EffectorDef[]; isModel: boolean; onChange: (l: Effector[]) => void }) {
  const update = (i: number, patch: Partial<Effector>) => onChange(list.map((e, k) => (k === i ? { ...e, ...patch } : e)));
  const setParam = (i: number, key: string, v: EffectorValue) => update(i, { params: { ...list[i].params, [key]: v } });
  const notes = new Set(list.filter(e => e.enabled).map(e => defs.find(d => d.key === e.kind)?.note?.(isModel)).filter(Boolean));
  return (
    <div className="effectors">
      <div className="effectors-head">エフェクタ</div>
      {list.map((e, i) => {
        const def = defs.find(d => d.key === e.kind);
        const name = def?.name ?? e.kind;
        return (
          <div key={i} className="effector" role="group" aria-label={`エフェクタ ${i + 1} ${name}`}>
            <div className="effector-title">
              <BCheck checked={e.enabled} onChange={enabled => update(i, { enabled })}>{name}</BCheck>
              <button type="button" className="hbtn" aria-label={`${name}を外す`} title="外す" onClick={() => onChange(list.filter((_, k) => k !== i))}>×</button>
            </div>
            {!def ? <div className="note">この種類のエフェクタは登録されていないので、働きません (MoGraph エフェクタのアドオンを有効にしてください)</div> : (
              <div className="prop cloner">
                {(def.params ?? []).map(p => <ParamField key={p.key} name={name} param={p} value={paramOf(def, e, p.key)!} onChange={v => setParam(i, p.key, v)} />)}
                {def.transform !== false && <>
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
                </>}
              </div>
            )}
          </div>
        );
      })}
      {defs.length ? (
        <div className="row effector-add">
          {defs.map(d => <button key={d.key} type="button" className="bbtn" title={d.description} onClick={() => onChange([...list, newEffector(d)])}>+ {d.name}</button>)}
        </div>
      ) : <div className="note">エフェクタの種類がありません。アドオンマネージャーで「MoGraph エフェクタ」を有効にすると足せます</div>}
      {[...notes].map(n => <div key={n} className="note">{n}</div>)}
    </div>
  );
}

// エフェクタの種類ごとの設定 1 つ
function ParamField({ name, param: p, value, onChange }: { name: string; param: EffectorParam; value: EffectorValue; onChange: (v: EffectorValue) => void }) {
  const label = `${name}の${p.label}${p.unit ? ` (${p.unit})` : ''}`;
  return (
    <>
      <label>{p.label}</label>
      {p.type === 'boolean' ? <BCheck checked={!!value} label={label} onChange={onChange} />
        : p.type === 'select' ? <BSelect<string> label={label} value={String(value)} onChange={onChange} options={p.options ?? []} />
          : <NumField label={label} value={Number(value)} min={p.min} max={p.max} step={p.step ?? 1} digits={p.digits ?? 0} onCommit={onChange} />}
    </>
  );
}
