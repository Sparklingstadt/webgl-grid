import { t } from '../../core/i18n';
import type { SelInfo } from '../../engine';
import { Panel } from '../../ui/components/sidebar/Panel';
import { useEngine } from '../../ui/EngineContext';
import type { Cinema4d } from '../cinema4d/Cinema4d';
import type { Cache } from './Cache';

// --- MoGraph キャッシュのパネル: 焼き付ける・消す ---
export function CachePanel({ c4d, cache }: { sel: SelInfo; c4d: Cinema4d; cache: Cache }) {
  const engine = useEngine();
  const o = engine.selection.current;
  if (!o || !c4d.cloner(o)) return null;
  const c = cache.get(o);
  const stale = c && c.count !== c4d.count(o);
  return (
    <Panel title={t('MoGraph キャッシュ')}>
      <div className="note">
        {!c ? t('焼き付けると、開始〜終了の各フレームのクローンの置き場所を覚え、再生・レンダリングで計算せずに使います (重いエフェクタでも軽く、いつも同じ結果)。')
          : stale ? t('クローンの数が変わったので、キャッシュは使っていません。焼き付け直してください。')
          : t('フレーム {start}〜{end} ({n} フレーム) を焼き付けてあります。設定を変えても、消すまではキャッシュを使います。', { start: c.start, end: c.start + c.frames.length - 1, n: c.frames.length })}
      </div>
      <div className="row">
        <button type="button" className="bbtn" onClick={() => cache.bake(o)}>{c ? t('焼き付け直す') : t('焼き付ける')}</button>
        <button type="button" className="bbtn" disabled={!c} onClick={() => cache.clear(o)}>{t('キャッシュを消す')}</button>
      </div>
    </Panel>
  );
}
