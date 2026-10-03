import { t } from '../../core/i18n';
import { useEngine, useUi } from '../EngineContext';
import { Icon } from './icons';

// --- 状態バー (Blender のいちばん下): 左にマウスとキーの使い方、右に場面の数 (選んでいる物 / 置いた物・フレーム) ---
export function StatusBar({ maximized }: { maximized: boolean }) {
  const engine = useEngine();
  const sel = useUi(s => s.sel);
  const mode = useUi(s => s.mode);
  const poseMode = useUi(s => s.poseMode);
  const frame = useUi(s => s.frame);
  useUi(s => s.sceneVersion);
  const count = engine.world.objects.length;
  return (
    <footer className="statusbar" aria-label={t('状態バー')}>
      <span className="hint"><Icon name="mouseLeft" />{poseMode ? t('関節を押してボーンを選ぶ') : t('選択')}</span>
      <span className="hint"><Icon name="mouseLeft" />{t('ドラッグ: {action}', { action: mode === 'orbit' ? t('回転') : t('移動') })}</span>
      <span className="hint"><Icon name="mouseMiddle" />{t('ズーム')}</span>
      <span className="hint"><kbd>{poseMode ? 'R / G' : 'Shift A'}</kbd>{poseMode ? t('回す・動かす') : t('追加')}</span>
      <span className="hint"><kbd>{sel?.kind === 'model' || poseMode ? 'Tab' : 'N'}</kbd>{sel?.kind === 'model' || poseMode ? (poseMode ? t('オブジェクトモードへ') : t('ポーズモードへ')) : t('サイドバー')}</span>
      {maximized && <span className="hint"><kbd>Ctrl Space</kbd>{t('エリアを元に戻す')}</span>}
      <span className="spacer" />
      <span className="stats">
        {sel ? `${t(sel.name)} | ` : ''}{t('オブジェクト {sel}/{n}', { sel: sel ? 1 : 0, n: count })} | {t('フレーム {f}', { f: frame })}
      </span>
    </footer>
  );
}
