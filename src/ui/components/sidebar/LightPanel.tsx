import { t } from '../../../core/i18n';
import { AREA_SHAPES, LIGHT_TYPES, type AreaShape, type LightType } from '../../../core/light';
import type { SelInfo } from '../../../engine';
import { useEngine } from '../../EngineContext';
import { BSlider } from '../BSlider';
import { BCheck } from '../controls/BCheck';
import { HexColorField, keyOptions, SelectField } from '../fields';
import { Panel } from './Panel';

// --- ライト (Blender のライトのプロパティ): 種類・色・パワー (サンは強さ)・半径・スポットサイズとブレンド・エリアの形状とサイズ・影 ---
export function LightPanel({ sel }: { sel: SelInfo }) {
  const engine = useEngine();
  const l = sel.light!;
  const set = engine.setLight.bind(engine);
  const kind = l.type;
  return (
    <Panel title={t('ライト')} head={kind !== 'area' ? <BCheck checked={l.shadows} label={t('影')} onChange={shadows => set({ shadows })} /> : undefined}>
      <SelectField<LightType> label={t('種類')} ariaLabel={t('ライトの種類')} value={kind} onChange={type => set({ type })}
                              options={keyOptions(LIGHT_TYPES).map(o => ({ ...o, label: t(o.label) }))} />
      <HexColorField label={t('カラー')} value={l.color} onChange={color => set({ color })} />
      {kind === 'sun'
        ? <BSlider label={t('強さ')} value={l.strength} min={0} max={20} step={0.05} digits={2} unit=" W/m²" onChange={strength => set({ strength })} />
        : <BSlider label={t('パワー')} value={l.power} min={0} max={kind === 'area' ? 500 : 5000} step={kind === 'area' ? 1 : 10} digits={0} unit=" W" onChange={power => set({ power })} />}
      {(kind === 'point' || kind === 'spot') && <BSlider label={t('半径')} value={l.radius} min={0} max={1} step={0.01} digits={2} unit=" m" onChange={radius => set({ radius })} />}
      {kind === 'sun' && <BSlider label={t('角度')} value={l.angleDeg} min={0} max={30} step={0.1} digits={1} unit="°" onChange={angleDeg => set({ angleDeg })} />}
      {kind === 'spot' && <>
        <BSlider label={t('スポットサイズ')} value={l.spotSizeDeg} min={1} max={180} step={1} digits={0} unit="°" onChange={spotSizeDeg => set({ spotSizeDeg })} />
        <BSlider label={t('ブレンド')} value={l.blend} min={0} max={1} step={0.01} onChange={blend => set({ blend })} />
      </>}
      {kind === 'area' && <>
        <SelectField<AreaShape> label={t('形状')} ariaLabel={t('エリアの形状')} value={l.shape} onChange={shape => set({ shape })}
                                options={keyOptions(AREA_SHAPES).map(o => ({ ...o, label: t(o.label) }))} />
        <BSlider label={l.shape === 'square' ? t('サイズ') : t('サイズ X')} value={l.size} min={0.1} max={10} step={0.1} digits={1} unit=" m" onChange={size => set({ size })} />
        {l.shape === 'rectangle' && <BSlider label={t('サイズ Y')} value={l.sizeY} min={0.1} max={10} step={0.1} digits={1} unit=" m" onChange={sizeY => set({ sizeY })} />}
      </>}
      <BSlider label={t('高さ')} value={l.height} min={0.05} max={10} step={0.05} digits={2} unit=" m" onChange={height => set({ height })} />
      {kind !== 'point' && <BSlider label={t('傾き')} value={l.tiltDeg} min={-90} max={90} step={1} digits={0} unit="°" onChange={tiltDeg => set({ tiltDeg })} />}
      {(kind === 'point' || kind === 'spot') && <BSlider label={t('カスタム距離')} value={l.range} min={0} max={50} step={0.5} digits={1} unit=" m" onChange={range => set({ range })} />}
      <div className="note">
        {kind === 'sun' ? t('サンは、置いた場所によらず、場面全体を同じ向きから照らします。') : ''}
        {(kind === 'point' || kind === 'spot') && l.range === 0 ? t('カスタム距離 0 は、果てしなく届きます。') : ''}
        {kind !== 'point' ? t('真下から、物の向き (回転) の前へ傾けて照らします。') : ''}
        {kind === 'area' ? t('エリアは影を落とせません。') : ''}
        {t('レンダリングでは目印を描かず、光だけが写ります。')}
      </div>
    </Panel>
  );
}
