import { msg } from '../../core/i18n';
import type { SelInfo } from '../../engine';
import type { AddonModule } from '../../engine/addons/Addons';
import type { Obj } from '../../engine/types';
import type { Cinema4d } from '../cinema4d/Cinema4d';
import { Cache } from './Cache';
import { CachePanel } from './CachePanel';

// --- MoGraph キャッシュ: クローナーの置き場所をフレームごとに焼き付ける (Cinema 4D の MoGraph キャッシュタグ) ---
const mographCache: AddonModule = {
  id: 'mograph-cache',
  name: msg('MoGraph キャッシュ'),
  version: '1.0.0',
  author: 'webgl-grid',
  category: 'MoGraph',
  description: msg('クローナーの置き場所を、開始〜終了の各フレームで焼き付けます。再生・レンダリングでは計算せずに使うので、重いエフェクタでも軽く、いつも同じ結果になります。プロパティの「モディファイアー」の「MoGraph キャッシュ」で使います。'),
  enabledByDefault: true,
  requires: ['cinema4d'],
  register(api) {
    const c4d = api.require<Cinema4d>('cinema4d');
    const cache = new Cache(api, c4d);
    api.expose(cache);
    api.addPanel({
      title: msg('MoGraph キャッシュ'), tab: 'modifier', poll: (sel: SelInfo | null) => !!sel && !!c4d.cloner(api.engine.selection.current),
      component: ({ sel }: { sel: SelInfo }) => <CachePanel sel={sel} c4d={c4d} cache={cache} />,
    });
    const objOf = (id: unknown): Obj => {
      const o = id === undefined || id === null ? api.engine.selection.current : api.engine.world.find(Number(id));
      if (!o) throw new Error('物がありません (id を指定してください)');
      return o;
    };
    api.addCommand('bake', {
      description: 'クローナーの置き場所を、開始〜終了の各フレームで焼き付ける',
      params: { id: 'クローナーにしている物の id' },
      run: p => { const o = objOf(p.id); return { id: o.id, frames: cache.bake(o) }; },
    });
    api.addCommand('clear', { description: '焼き付けたキャッシュを消す', params: { id: '物の id' }, run: p => { const o = objOf(p.id); cache.clear(o); return { id: o.id }; } });
    return () => cache.off();
  },
};
export default mographCache;
