import { AREA_SHAPES, LIGHT_TYPES, type AreaShape, type LightType } from '../../../core/light';
import { hexToLinear, linearToHex } from '../../../core/materials/color';
import type { SelInfo } from '../../../engine';
import { useEngine } from '../../EngineContext';
import { BSlider } from '../BSlider';
import { BCheck } from '../controls/BCheck';
import { BSelect } from '../controls/BSelect';
import { ColorField } from '../fields';
import { Panel } from './Panel';

// --- ライト (Blender のライトのプロパティ): 種類・色・パワー (サンは強さ)・半径・スポットサイズとブレンド・エリアの形状とサイズ・影 ---
export function LightPanel({ sel }: { sel: SelInfo }) {
  const engine = useEngine();
  const l = sel.light!;
  const set = engine.setLight.bind(engine);
  const t = l.type;
  return (
    <Panel title="ライト" head={t !== 'area' ? <BCheck checked={l.shadows} label="影" onChange={shadows => set({ shadows })} /> : undefined}>
      <div className="color-field">
        <span>種類</span>
        <BSelect<LightType> label="ライトの種類" value={t} onChange={type => set({ type })}
                 options={LIGHT_TYPES.map(x => ({ value: x.key, label: x.name }))} />
      </div>
      <ColorField label="カラー" value={hexToLinear(l.color)} onChange={c => set({ color: linearToHex(c) })} />
      {t === 'sun'
        ? <BSlider label="強さ" value={l.strength} min={0} max={20} step={0.05} digits={2} unit=" W/m²" onChange={strength => set({ strength })} />
        : <BSlider label="パワー" value={l.power} min={0} max={t === 'area' ? 500 : 5000} step={t === 'area' ? 1 : 10} digits={0} unit=" W" onChange={power => set({ power })} />}
      {(t === 'point' || t === 'spot') && <BSlider label="半径" value={l.radius} min={0} max={1} step={0.01} digits={2} unit=" m" onChange={radius => set({ radius })} />}
      {t === 'sun' && <BSlider label="角度" value={l.angleDeg} min={0} max={30} step={0.1} digits={1} unit="°" onChange={angleDeg => set({ angleDeg })} />}
      {t === 'spot' && <>
        <BSlider label="スポットサイズ" value={l.spotSizeDeg} min={1} max={180} step={1} digits={0} unit="°" onChange={spotSizeDeg => set({ spotSizeDeg })} />
        <BSlider label="ブレンド" value={l.blend} min={0} max={1} step={0.01} onChange={blend => set({ blend })} />
      </>}
      {t === 'area' && <>
        <div className="color-field">
          <span>形状</span>
          <BSelect<AreaShape> label="エリアの形状" value={l.shape} onChange={shape => set({ shape })}
                   options={AREA_SHAPES.map(x => ({ value: x.key, label: x.name }))} />
        </div>
        <BSlider label={l.shape === 'square' ? 'サイズ' : 'サイズ X'} value={l.size} min={0.1} max={10} step={0.1} digits={1} unit=" m" onChange={size => set({ size })} />
        {l.shape === 'rectangle' && <BSlider label="サイズ Y" value={l.sizeY} min={0.1} max={10} step={0.1} digits={1} unit=" m" onChange={sizeY => set({ sizeY })} />}
      </>}
      <BSlider label="高さ" value={l.height} min={0.05} max={10} step={0.05} digits={2} unit=" m" onChange={height => set({ height })} />
      {t !== 'point' && <BSlider label="傾き" value={l.tiltDeg} min={-90} max={90} step={1} digits={0} unit="°" onChange={tiltDeg => set({ tiltDeg })} />}
      {(t === 'point' || t === 'spot') && <BSlider label="カスタム距離" value={l.range} min={0} max={50} step={0.5} digits={1} unit=" m" onChange={range => set({ range })} />}
      <div className="note">
        {t === 'sun' ? 'サンは、置いた場所によらず、場面全体を同じ向きから照らします。' : ''}
        {(t === 'point' || t === 'spot') && l.range === 0 ? 'カスタム距離 0 は、果てしなく届きます。' : ''}
        {t !== 'point' ? '真下から、物の向き (回転) の前へ傾けて照らします。' : ''}
        {t === 'area' ? 'エリアは影を落とせません。' : ''}
        レンダリングでは目印を描かず、光だけが写ります。
      </div>
    </Panel>
  );
}
