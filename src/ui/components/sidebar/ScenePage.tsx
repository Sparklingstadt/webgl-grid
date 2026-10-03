import { SKY_MODES, type SkyMode } from '../../../core/scene';
import { useEngine, useUi } from '../../EngineContext';
import { BSlider } from '../BSlider';
import { BCheck } from '../controls/BCheck';
import { HexColorField, keyOptions, SelectField } from '../fields';
import { Panel } from './Panel';

// --- シーン (Cinema 4D の空・床・太陽、Blender のワールド): 背景の空・床・太陽の光・部屋の光 ---
export function ScenePage() {
  const engine = useEngine();
  const s = useUi(st => st.scene);
  const env = engine.environment;
  const color = (label: string, hex: string, set: (hex: string) => void) => <HexColorField label={label} value={hex} onChange={set} />;
  return (
    <>
      <Panel title="空">
        <SelectField<SkyMode> label="空" ariaLabel="空の種類" value={s.sky.mode} onChange={mode => env.set({ sky: { mode } })} options={keyOptions(SKY_MODES)} />
        {s.sky.mode !== 'viewport' && color(s.sky.mode === 'gradient' ? '上の色' : '色', s.sky.top, top => env.set({ sky: { top } }))}
        {s.sky.mode === 'gradient' && color('地平線の色', s.sky.bottom, bottom => env.set({ sky: { bottom } }))}
        <div className="note">背景に描く空。レンダリングした画像・動画にも写ります</div>
      </Panel>
      <Panel title="床" head={<BCheck checked={s.floor.enabled} label="床を置く" onChange={enabled => env.set({ floor: { enabled } })} />}>
        {s.floor.enabled ? (
          <>
            {color('色', s.floor.color, c => env.set({ floor: { color: c } }))}
            <BSlider label="粗さ" value={s.floor.roughness} min={0} max={1} step={0.01} onChange={roughness => env.set({ floor: { roughness } })} />
          </>
        ) : <div className="note">チェックを入れると、果てしなく広い床を置きます (影を受けます)</div>}
      </Panel>
      <Panel title="太陽" head={<BCheck checked={s.sun.shadows} label="太陽の影を落とす" onChange={shadows => env.set({ sun: { shadows } })} />}>
        <BSlider label="明るさ" value={s.sun.intensity} min={0} max={5} step={0.01} onChange={intensity => env.set({ sun: { intensity } })} />
        {color('色', s.sun.color, c => env.set({ sun: { color: c } }))}
        <BSlider label="方位" value={s.sun.azimuthDeg} min={-180} max={180} step={1} digits={0} unit="°" onChange={azimuthDeg => env.set({ sun: { azimuthDeg } })} />
        <BSlider label="高さ" value={s.sun.elevationDeg} min={1} max={90} step={1} digits={0} unit="°" onChange={elevationDeg => env.set({ sun: { elevationDeg } })} />
      </Panel>
      <Panel title="部屋の光">
        <BSlider label="明るさ" value={s.environment} min={0} max={2} step={0.01} onChange={environment => env.set({ environment })} />
        <div className="note">まわりから全体を照らす、やわらかい光 (環境光)</div>
      </Panel>
    </>
  );
}
