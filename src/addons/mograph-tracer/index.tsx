import { msg } from '../../core/i18n';
import type { SelInfo } from '../../engine';
import type { AddonModule } from '../../engine/addons/Addons';
import type { Obj } from '../../engine/types';
import type { Cinema4d } from '../cinema4d/Cinema4d';
import { Tracer, TRACER_DEFAULT, type TracerSettings } from './Tracer';
import { TracerPanel } from './TracerPanel';

// --- MoGraph トレーサー: 動く物・クローン・ボーンの通った跡を、線か管にする (Cinema 4D のトレーサー) ---
const mographTracer: AddonModule = {
  id: 'mograph-tracer',
  name: msg('MoGraph トレーサー'),
  version: '1.0.0',
  author: 'webgl-grid',
  category: 'MoGraph',
  description: msg('動く物 (クローン・MoText の文字) や MMD モデルのボーンの通った跡を、線か管にして残す (経路)。いまの位置どうしをつなぐこともできる (連結)。跡はスプラインとしても使えます。'),
  enabledByDefault: true,
  requires: ['cinema4d'],
  register(api) {
    const c4d = api.require<Cinema4d>('cinema4d');
    const tracer = new Tracer(api, c4d);
    api.expose(tracer);
    api.addPanel({
      title: msg('トレーサー'), tab: 'object', poll: (sel: SelInfo | null) => !!sel,
      component: ({ sel }: { sel: SelInfo }) => <TracerPanel sel={sel} tracer={tracer} />,
    });
    api.addCommand('set', {
      description: '物の通った跡を残す (トレーサー)・設定を変える。off: true でやめる',
      params: { id: '物の id (省くと選んでいる物)', off: 'やめる', mode: 'paths / connect', source: 'auto / bones', bones: 'ボーンの名前 (、で区切る)', length: '跡のフレーム数', radius: '太さ (0 で線)', color: '"#rrggbb"', closed: '連結: 閉じる' },
      run: p => {
        const { id, off, ...patch } = p;
        const o: Obj | null = id === undefined || id === null ? api.engine.selection.current : api.engine.world.find(Number(id));
        if (!o) throw new Error('物がありません (id を指定してください)');
        tracer.set(o, off ? null : { ...(tracer.get(o) ? {} : TRACER_DEFAULT), ...patch } as Partial<TracerSettings>);
        return { id: o.id, tracer: tracer.get(o), points: tracer.points(o) };
      },
    });
    return () => tracer.off();
  },
};
export default mographTracer;
