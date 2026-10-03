import { PALETTE, PALETTE_NAMES, paletteCss } from '../../../core/constants';
import { t } from '../../../core/i18n';
import { useEngine, useUi } from '../../EngineContext';
import { BCheck } from '../controls/BCheck';
import { NumField } from '../NumField';
import { LightPanel } from './LightPanel';
import { AddonPanels } from '../addons/AddonPanels';
import { Empty, Panel } from './Panel';

// --- オブジェクト: 選んでいる物の名前・位置・向き・色 ---
export function ObjectPage() {
  const engine = useEngine();
  const sel = useUi(s => s.sel);
  const hairHang = useUi(s => s.hairHang);
  const rigShown = useUi(s => s.rigShown);
  if (!sel) return <><Panel title={t('オブジェクト')}><Empty>{t('何も選んでいません。ビューポートで物をクリックすると選べます。')}</Empty></Panel><AddonPanels tab="object" /></>;
  const deg = ((sel.r * 180 / Math.PI) % 360 + 540) % 360 - 180;
  return (
    <>
      <Panel title={t('オブジェクト')}>
        <div className="prop">
          <label>{t('名前')}</label><span>{t(sel.name)}</span>
          <label htmlFor="obj-x">{t('位置 X')}</label><NumField id="obj-x" label={t('位置 X')} value={+sel.x.toFixed(2)} digits={2} step={0.1} onCommit={v => engine.setObjProp('x', v)} />
          <label>{t('位置 Y')}</label><span className="note">{t('{y} (積み重ねで決まる)', { y: sel.y.toFixed(2) })}</span>
          <label htmlFor="obj-z">{t('位置 Z')}</label><NumField id="obj-z" label={t('位置 Z')} value={+sel.z.toFixed(2)} digits={2} step={0.1} onCommit={v => engine.setObjProp('z', v)} />
          <label htmlFor="obj-r">{t('回転')}</label><NumField id="obj-r" label={t('縦軸まわりの回転 (度)')} value={Math.round(deg)} onCommit={v => engine.setObjProp('r', v)} />
        </div>
      </Panel>
      {sel.kind === 'shape' && (
        <Panel title={t('色')}>
          <div className="swatches" role="group" aria-label={t('色')}>
            {PALETTE.map((_, i) => (
              <button key={i} type="button" aria-label={t(PALETTE_NAMES[i])} title={t(PALETTE_NAMES[i])} aria-pressed={sel.c === i}
                      style={{ background: paletteCss(i) }} onClick={() => engine.setObjColor(i)} />
            ))}
          </div>
        </Panel>
      )}
      {sel.kind === 'model' && (hairHang !== null || engine.physics.hasRig(engine.selection.current)) && (
        <Panel title={t('物理演算')}>
          {hairHang !== null && <>
            <BCheck checked={hairHang} onChange={on => engine.setHairHang(on)}>{t('髪を重力で垂らす')}</BCheck>
            <div className="note">{t('髪の形を保つ「錘」の剛体を外して、髪をまっすぐ垂らします。オフにすると、モデルの作者が作った髪の形 (MMD と同じ) に戻ります')}</div>
          </>}
          <BCheck checked={rigShown} onChange={on => engine.showRig(on)}>{t('剛体と関節を表示')}</BCheck>
          <div className="note">{t('物理演算の剛体 (赤: ボーン追従・緑: 物理・青: 物理 + 位置合わせ) と関節 (黄) を重ねて表示します (レンダリングには写りません)')}</div>
        </Panel>
      )}
      {sel.kind === 'model' && (
        <Panel title={t('モーション')}>
          <div className="note">{sel.animated ? t('VMD モーションを再生中です。タイムラインで動かせます。') : t('モーションはありません。ファイル > MMD を読み込む… で .vmd を選ぶと付きます。')}</div>
        </Panel>
      )}
      {sel.kind === 'light' && <LightPanel sel={sel} />}
      <AddonPanels tab="object" />
      <button type="button" className="bbtn" onClick={() => engine.deleteSelected()}>{t('削除 (X)')}</button>
    </>
  );
}
