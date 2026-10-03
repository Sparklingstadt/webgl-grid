import { useEffect, useRef } from 'react';
import type { PanelDef, PropDef } from '../../../engine/addons/registry';
import { useEngine, useUi } from '../../EngineContext';
import { BSlider } from '../BSlider';
import { BCheck } from '../controls/BCheck';
import { HexColorField, SelectField } from '../fields';
import { NumField } from '../NumField';
import { Panel } from '../sidebar/Panel';

// --- アドオンが足したサイドバーのパネル (タブごと) ---
// 選択・値・フレーム・アドオンの変化で描き直す
export function AddonPanels({ tab }: { tab: string }) {
  const engine = useEngine();
  const sel = useUi(s => s.sel);
  useUi(s => s.addonsVersion);
  useUi(s => s.values);
  useUi(s => s.frame);
  const panels = engine.addons.panels.list().filter(p => p.tab === tab && (p.poll?.(sel) ?? true));
  return <>{panels.map(p => <AddonPanel key={p.key} panel={p} />)}</>;
}

function AddonPanel({ panel }: { panel: PanelDef }) {
  let props: PropDef[] = [];
  let error: string | null = null;
  try { props = panel.props?.() ?? []; } catch (err) { error = (err as Error).message; }
  return (
    <Panel title={panel.title}>
      {props.map((p, i) => <PropRow key={`${panel.key}.${i}`} prop={p} />)}
      {panel.draw && <DrawArea panel={panel} />}
      {error && <div className="note">エラー: {error}</div>}
    </Panel>
  );
}

// 自分で描くパネル: 要素を渡す (片付けは、パネルが消えるときに)
function DrawArea({ panel }: { panel: PanelDef }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = el.current!;
    const cleanup = panel.draw!(host);
    return () => { if (typeof cleanup === 'function') cleanup(); host.replaceChildren(); };
  }, [panel]);
  return <div className="addon-draw" ref={el} />;
}

// 設定 1 つを、アプリの部品で描く
function PropRow({ prop: p }: { prop: PropDef }) {
  switch (p.type) {
    case 'number':
      return p.min !== undefined && p.max !== undefined
        ? <BSlider label={p.label} value={p.get()} min={p.min} max={p.max} step={p.step ?? 0.01} digits={p.digits ?? 2} unit={p.unit ?? ''} onChange={v => p.set(v)} />
        : <div className="color-field"><span>{p.label}</span><NumField label={p.label} value={p.get()} min={p.min} max={p.max} step={p.step ?? 1} digits={p.digits ?? 0} onCommit={v => p.set(v)} /></div>;
    case 'boolean':
      return <BCheck checked={p.get()} onChange={v => p.set(v)}>{p.label}</BCheck>;
    case 'select':
      return <SelectField<string> label={p.label} value={p.get()} onChange={v => p.set(v)} options={p.options} />;
    case 'color':
      return <HexColorField label={p.label} value={p.get()} onChange={v => p.set(v)} />;
    case 'button':
      return <button type="button" className="bbtn" onClick={() => p.run()}>{p.label}</button>;
    case 'text':
      return <div className="note">{p.text}</div>;
  }
}
