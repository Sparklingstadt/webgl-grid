import { t } from '../../../core/i18n';
import { useEngine, useUi } from '../../EngineContext';
import { BSlider } from '../BSlider';
import { Empty, Panel } from './Panel';

// --- カメラのタブ (Blender のカメラのデータのプロパティ): 視野角・高さ・傾き。このカメラから見る ---
export function CameraPage() {
  const engine = useEngine();
  const sel = useUi(s => s.sel);
  useUi(s => s.sceneVersion);
  const c = sel?.camera;
  if (!c) return <Panel title={t('カメラ')}><Empty>{t('カメラを選ぶと、ここで視野角・高さ・傾きを変えられます。')}</Empty></Panel>;
  const isScene = engine.cameras.scene?.id === sel!.id;
  return (
    <Panel title={t('カメラ')}>
      <BSlider label={t('視野角')} value={c.fov} min={5} max={150} step={1} digits={0} unit="°" onChange={fov => engine.setCamera({ fov })} />
      <BSlider label={t('高さ')} value={c.height} min={0.05} max={10} step={0.05} digits={2} unit=" m" onChange={height => engine.setCamera({ height })} />
      <BSlider label={t('傾き')} value={c.tiltDeg} min={-89} max={89} step={1} digits={0} unit="°" onChange={tiltDeg => engine.setCamera({ tiltDeg })} />
      <button type="button" className="bbtn" onClick={() => engine.toggleCameraView()}>{t('場面のカメラから見る (テンキー 0)')}</button>
      <div className="note">
        {isScene ? t('このカメラが場面のカメラです。レンダリング (F12) はここから撮ります。') : t('場面のカメラは、アウトライナーでいちばん上のカメラです (ドラッグで並べ替えると変わります)。')}
        {t('向きは物の回転 (G・R・オブジェクトのタブ) で変えます。')}
      </div>
    </Panel>
  );
}
