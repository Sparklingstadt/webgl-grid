import { LIGHT_TYPES, type LightType } from '../../../core/light';
import { hexToLinear, linearToHex } from '../../../core/materials/color';
import type { SelInfo } from '../../../engine';
import { useEngine } from '../../EngineContext';
import { BSlider } from '../BSlider';
import { BCheck } from '../controls/BCheck';
import { BSelect } from '../controls/BSelect';
import { ColorField } from '../fields';
import { Panel } from './Panel';

// --- ライト (Cinema 4D のライト): 種類・色・明るさ・高さ・届く距離・スポットの広がり・傾き・エリアの大きさ・影 ---
export function LightPanel({ sel }: { sel: SelInfo }) {
  const engine = useEngine();
  const l = sel.light!;
  const set = engine.setLight.bind(engine);
  return (
    <Panel title="ライト" head={l.type !== 'area' ? <BCheck checked={l.shadows} label="影を落とす" onChange={shadows => set({ shadows })} /> : undefined}>
      <div className="color-field">
        <span>種類</span>
        <BSelect<LightType> label="ライトの種類" value={l.type} onChange={type => set({ type })}
                 options={LIGHT_TYPES.map(t => ({ value: t.key, label: t.name }))} />
      </div>
      <ColorField label="色" value={hexToLinear(l.color)} onChange={c => set({ color: linearToHex(c) })} />
      <BSlider label="明るさ" value={l.intensity} min={0} max={l.type === 'area' ? 50 : 300} step={0.5} digits={1} onChange={intensity => set({ intensity })} />
      <BSlider label="高さ" value={l.height} min={0.05} max={10} step={0.05} digits={2} onChange={height => set({ height })} />
      {l.type !== 'area' && <BSlider label="届く距離" value={l.range} min={0} max={50} step={0.5} digits={1} onChange={range => set({ range })} />}
      {l.type === 'spot' && <>
        <BSlider label="広がり" value={l.angleDeg} min={1} max={89} step={1} digits={0} unit="°" onChange={angleDeg => set({ angleDeg })} />
        <BSlider label="縁のぼけ" value={l.softness} min={0} max={1} step={0.01} onChange={softness => set({ softness })} />
      </>}
      {l.type !== 'point' && <BSlider label="傾き" value={l.tiltDeg} min={-90} max={90} step={1} digits={0} unit="°" onChange={tiltDeg => set({ tiltDeg })} />}
      {l.type === 'area' && <>
        <BSlider label="幅" value={l.width} min={0.1} max={10} step={0.1} digits={1} onChange={width => set({ width })} />
        <BSlider label="奥行き" value={l.depth} min={0.1} max={10} step={0.1} digits={1} onChange={depth => set({ depth })} />
      </>}
      <div className="note">
        {l.range === 0 && l.type !== 'area' ? '届く距離 0 は、果てしなく届きます。' : ''}
        {l.type !== 'point' ? '真下から、物の向き (回転) の前へ傾けて照らします。' : ''}
        {l.type === 'area' ? 'エリアライトは影を落とせません。' : ''}
        レンダリングでは目印を描かず、光だけが写ります。
      </div>
    </Panel>
  );
}
