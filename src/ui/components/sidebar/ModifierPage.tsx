import { t } from '../../../core/i18n';
import { useEngine, useUi } from '../../EngineContext';
import { AddonPanels } from '../addons/AddonPanels';
import { Empty, Panel } from './Panel';

// --- モディファイアー (Blender のモディファイアーのプロパティ): 形を変える・増やす (デフォーマ・クローナー・分割など) ---
// 中身はアドオン (Cinema 4D・MoGraph) が足す
export function ModifierPage() {
  const engine = useEngine();
  const sel = useUi(s => s.sel);
  useUi(s => s.addonsVersion);
  const has = engine.addons.panels.list().some(p => p.tab === 'modifier' && (p.poll?.(sel) ?? true));
  return (
    <>
      {!has && (
        <Panel title={t('モディファイアー')}>
          <Empty>{sel ? t('この物に使えるモディファイアーはありません。Cinema 4D・MoGraph のアドオンを有効にすると、デフォーマ・クローナー・分割が出ます。') : t('物を選ぶと、ここで形を変える・増やす設定 (デフォーマ・クローナーなど) ができます。')}</Empty>
        </Panel>
      )}
      <AddonPanels tab="modifier" />
    </>
  );
}
