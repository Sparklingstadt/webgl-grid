import { useState } from 'react';
import type { SelInfo } from '../../engine';
import { BCheck } from '../../ui/components/controls/BCheck';
import { BSelect } from '../../ui/components/controls/BSelect';
import { HexColorField } from '../../ui/components/fields';
import { NumField } from '../../ui/components/NumField';
import { Panel } from '../../ui/components/sidebar/Panel';
import { useEngine } from '../../ui/EngineContext';
import { TRACER_DEFAULT, type Tracer, type TracerSettings } from './Tracer';

// --- トレーサーのパネル ---
export function TracerPanel({ sel, tracer }: { sel: SelInfo; tracer: Tracer }) {
  const engine = useEngine();
  const o = engine.selection.current;
  const s = tracer.get(o);
  const set = (patch: Partial<TracerSettings> | null) => { if (o) tracer.set(o, patch); };
  const head = <BCheck checked={!!s} label="跡を残す" onChange={on => set(on ? { ...TRACER_DEFAULT, source: sel.kind === 'model' ? 'bones' : 'auto' } : null)} />;
  if (!o || !s) return <Panel title="トレーサー" head={head}><div className="note">チェックを入れると、この物 (クローナーならクローン・MMD モデルならボーン) の通った跡を、線か管にして残します (Cinema 4D のトレーサー)。</div></Panel>;
  return (
    <Panel title="トレーサー" head={head}>
      <div className="prop cloner">
        <label>モード</label>
        <BSelect<TracerSettings['mode']> label="トレーサーのモード" value={s.mode} onChange={mode => set({ mode })}
                                         options={[{ value: 'paths', label: '経路 (通った跡)' }, { value: 'connect', label: '連結 (いまの位置をつなぐ)' }]} />
        <label>跡を取る</label>
        <BSelect<TracerSettings['source']> label="跡を取るもの" value={s.source} onChange={source => set({ source })}
                                           options={[{ value: 'auto', label: '物 (クローン・文字)' }, { value: 'bones', label: 'MMD モデルのボーン' }]} />
        {s.source === 'bones' && <>
          <label>ボーン</label>
          <Bones value={s.bones} onCommit={bones => set({ bones })} />
        </>}
        {s.mode === 'paths' && <>
          <label>長さ</label>
          <NumField label="跡の長さ (フレーム)" value={s.length} min={2} max={600} onCommit={length => set({ length })} />
        </>}
        {s.mode === 'connect' && <>
          <label>閉じる</label>
          <BCheck checked={s.closed} label="最後と最初もつなぐ" onChange={closed => set({ closed })} />
        </>}
        <label>太さ</label>
        <NumField label="跡の太さ" value={s.radius} min={0} max={2} step={0.005} digits={3} onCommit={radius => set({ radius })} />
      </div>
      <HexColorField label="色" value={s.color} onChange={color => set({ color })} />
      <div className="note">
        {tracer.points(o)} 点の跡。{s.mode === 'paths' ? '再生すると伸びます (動画のレンダリングにも写ります。別のフレームへ飛ぶと取り直します)。' : ''}
        {s.source === 'bones' && !tracer.points(o) ? 'そのボーンがありません (ボーンのタブで名前を確かめてください)。' : ''}太さ 0 は線
      </div>
    </Panel>
  );
}

function Bones({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input className="text-field" type="text" aria-label="跡を取るボーン" placeholder="右手首、左手首" value={draft ?? value} spellCheck={false}
           onChange={e => setDraft(e.currentTarget.value)}
           onBlur={() => { if (draft !== null && draft !== value) onCommit(draft); setDraft(null); }}
           onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
  );
}
