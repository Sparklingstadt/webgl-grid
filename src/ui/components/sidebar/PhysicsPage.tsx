import { t } from '../../../core/i18n';
import { useEngine, useUi } from '../../EngineContext';
import { AddonPanels } from '../addons/AddonPanels';
import { BCheck } from '../controls/BCheck';
import { Empty, Panel } from './Panel';

// --- 物理演算 (Blender の物理演算のプロパティ): MMD モデルの剛体と関節 ---
export function PhysicsPage() {
  const engine = useEngine();
  const sel = useUi(s => s.sel);
  const hairHang = useUi(s => s.hairHang);
  const rigShown = useUi(s => s.rigShown);
  if (sel?.kind !== 'model') return <Panel title={t('物理演算')}><Empty>{t('MMD モデルを選ぶと、ここで物理演算の剛体と関節を扱えます。')}</Empty></Panel>;
  const hasRig = engine.physics.hasRig(engine.selection.current);
  return (
    <>
      <Panel title={t('物理演算')}>
        {!hasRig && hairHang === null && <Empty>{t('このモデルには、物理演算の剛体がありません。')}</Empty>}
        {hairHang !== null && <>
          <BCheck checked={hairHang} onChange={on => engine.setHairHang(on)}>{t('髪を重力で垂らす')}</BCheck>
          <div className="note">{t('髪の形を保つ「錘」の剛体を外して、髪をまっすぐ垂らします。オフにすると、モデルの作者が作った髪の形 (MMD と同じ) に戻ります')}</div>
        </>}
        {hasRig && <>
          <BCheck checked={rigShown} onChange={on => engine.showRig(on)}>{t('剛体と関節を表示')}</BCheck>
          <div className="note">{t('物理演算の剛体 (赤: ボーン追従・緑: 物理・青: 物理 + 位置合わせ) と関節 (黄) を重ねて表示します (レンダリングには写りません)')}</div>
        </>}
      </Panel>
      <AddonPanels tab="physics" />
    </>
  );
}
