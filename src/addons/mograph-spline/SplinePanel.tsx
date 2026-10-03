import { useState } from 'react';
import type { SelInfo } from '../../engine';
import { BCheck } from '../../ui/components/controls/BCheck';
import { BSelect } from '../../ui/components/controls/BSelect';
import { NumField } from '../../ui/components/NumField';
import { Panel } from '../../ui/components/sidebar/Panel';
import { useEngine } from '../../ui/EngineContext';
import { SPLINE_DEFAULT, TURTLE_PRESETS, type MoSpline, type SplineSettings } from './MoSpline';


// --- MoSpline のパネル ---
export function SplinePanel({ mospline }: { sel: SelInfo; mospline: MoSpline }) {
  const engine = useEngine();
  const o = engine.selection.current;
  const s = mospline.get(o);
  const set = (patch: Partial<SplineSettings> | null) => { if (o) mospline.set(o, patch); };
  const head = <BCheck checked={!!s} label="MoSpline にする" onChange={on => set(on ? { ...SPLINE_DEFAULT } : null)} />;
  if (!o || !s) return <Panel title="MoSpline" head={head}><div className="note">チェックを入れると、この形を伸びる曲線 (太さを付けた管) にします (Cinema 4D の MoSpline とスイープ)。</div></Panel>;
  const n = (label: string, key: keyof SplineSettings, opts: { min?: number; max?: number; step?: number; digits?: number } = {}) => (
    <>
      <label>{label}</label>
      <NumField label={`MoSpline の${label}`} value={s[key] as number} min={opts.min} max={opts.max} step={opts.step ?? 1} digits={opts.digits ?? 0} onCommit={v => set({ [key]: v })} />
    </>
  );
  const problem = mospline.problems.get(o);
  return (
    <Panel title="MoSpline" head={head}>
      <div className="prop cloner">
        <label>モード</label>
        <BSelect<SplineSettings['mode']> label="MoSpline のモード" value={s.mode} onChange={mode => set({ mode })}
                                         options={[{ value: 'simple', label: 'シンプル' }, { value: 'turtle', label: 'タートル (L-システム)' }]} />
        {s.mode === 'simple' ? <>
          {n('長さ', 'length', { min: 0.01, step: 0.25, digits: 2 })}
          {n('分割数', 'segments', { min: 1, max: 2000 })}
          {n('曲がり', 'bend', { step: 15 })}
          {n('ねじれ', 'twist', { step: 15 })}
        </> : <>
          <label>見本</label>
          <BSelect<string> label="タートルの見本" value="" placeholder="見本を選ぶ…" onChange={k => set(TURTLE_PRESETS.find(p => p.key === k)!.set)}
                           options={TURTLE_PRESETS.map(p => ({ value: p.key, label: p.name }))} />
          <label>前提</label>
          <Text label="タートルの前提" value={s.premise} onCommit={premise => set({ premise })} />
          <label>規則</label>
          <Text label="タートルの規則" value={s.rules} multiline onCommit={rules => set({ rules })} />
          {n('くり返し', 'iterations', { min: 0, max: 8 })}
          {n('角度', 'angle', { step: 2.5, digits: 1 })}
          {n('歩幅', 'step', { min: 0.001, step: 0.02, digits: 3 })}
          {n('枝の縮み', 'shrink', { min: 0.1, max: 2, step: 0.05, digits: 2 })}
        </>}
        {n('始め', 'start', { min: 0, max: 1, step: 0.05, digits: 2 })}
        {n('終わり', 'end', { min: 0, max: 1, step: 0.05, digits: 2 })}
        {n('成長 (秒)', 'grow', { min: 0, step: 0.5, digits: 1 })}
        {s.grow > 0 && n('成長の始め (秒)', 'growStart', { min: 0, step: 0.5, digits: 1 })}
        {n('太さ', 'radius', { min: 0, step: 0.01, digits: 3 })}
        {n('先の太さ', 'radiusEnd', { min: 0, step: 0.01, digits: 3 })}
      </div>
      {problem ? <div className="note addon-error">{problem}</div>
        : <div className="note">{mospline.segments(o)} 区間。{s.mode === 'turtle' ? 'F: 進む・+ -: 曲がる・& ^: 上下・\\ /: ひねる・[ ]: 枝。' : ''}成長を付けると、再生で伸びます。太さ 0 は線</div>}
    </Panel>
  );
}

function Text({ label, value, multiline, onCommit }: { label: string; value: string; multiline?: boolean; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const done = () => { if (draft !== null && draft !== value) onCommit(draft); setDraft(null); };
  const props = { className: 'text-field', 'aria-label': label, value: draft ?? value, spellCheck: false, onBlur: done };
  return multiline
    ? <textarea {...props} rows={3} onChange={e => setDraft(e.currentTarget.value)} onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) e.currentTarget.blur(); }} />
    : <input {...props} type="text" onChange={e => setDraft(e.currentTarget.value)} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} />;
}
