import { msg, t } from '../../../core/i18n';
import type { FxKey, FxLevel } from '../../../engine';
import { useEngine, useUi } from '../../EngineContext';
import { BSlider } from '../BSlider';
import { BCheck } from '../controls/BCheck';
import { Panel } from './Panel';

// --- 効果 (MME 風) ---
const FX_ROWS: { key: FxKey; title: string; sliders: { k: keyof FxLevel; label: string; min: number; max: number; step: number }[] }[] = [
  { key: 'bloom', title: msg('光る'), sliders: [{ k: 'bloom', label: msg('強さ'), min: 0, max: 2, step: 0.05 }] },
  { key: 'diffusion', title: msg('ふんわり'), sliders: [{ k: 'diffusion', label: msg('強さ'), min: 0, max: 1, step: 0.02 }] },
  { key: 'dof', title: msg('被写界深度'), sliders: [{ k: 'dof', label: msg('ぼけの大きさ'), min: 0, max: 3, step: 0.05 }] },
  { key: 'ao', title: msg('影の濃さ'), sliders: [{ k: 'ao', label: msg('濃さ'), min: 0, max: 2, step: 0.05 }] },
  { key: 'color', title: msg('色調'), sliders: [
    { k: 'temp', label: msg('色温度'), min: -1, max: 1, step: 0.02 },
    { k: 'sat', label: msg('彩度'), min: 0, max: 2, step: 0.02 },
    { k: 'bright', label: msg('明度'), min: 0, max: 2, step: 0.02 },
  ] },
];
export function FxPage() {
  const engine = useEngine();
  const state = useUi(s => s.fxState);
  const level = useUi(s => s.fxLevel);
  return (
    <>
      <div className="note" style={{ padding: '2px 2px 6px' }}>{t('MME 風の効果。オフの効果のスライダーを動かすとオンになります。設定はブラウザに保存されます')}</div>
      {FX_ROWS.map(row => (
        <Panel key={row.key} title={t(row.title)}
               head={<BCheck checked={state[row.key]} label={t('{name}を使う', { name: t(row.title) })} onChange={on => engine.effects.set(row.key, on)} />}>
          {row.sliders.map(s => (
            <BSlider key={s.k} label={t(s.label)} value={level[s.k]} min={s.min} max={s.max} step={s.step} off={!state[row.key]}
                     onChange={v => engine.effects.setLevel(s.k, v)} />
          ))}
        </Panel>
      ))}
    </>
  );
}
