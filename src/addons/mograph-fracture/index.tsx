import { msg } from '../../core/i18n';
import type { SelInfo } from '../../engine';
import type { AddonModule } from '../../engine/addons/Addons';
import type { Obj } from '../../engine/types';
import type { Cinema4d } from '../cinema4d/Cinema4d';
import { Fracture, type FractureSettings } from './Fracture';
import { FracturePanel } from './FracturePanel';

// --- MoGraph 分割: 形を破片に分けて、エフェクタで動かす (Cinema 4D のボロノイ分割・PolyFX) ---
const mographFracture: AddonModule = {
  id: 'mograph-fracture',
  name: msg('MoGraph 分割'),
  version: '1.0.0',
  author: 'webgl-grid',
  category: 'MoGraph',
  description: msg('形を破片に分け、エフェクタ (とフィールド) で動かす: ボロノイ分割 (凸な形) と PolyFX (面ごと)。サイドバーの「オブジェクト」の「分割」で使います。'),
  enabledByDefault: true,
  requires: ['cinema4d'],
  register(api) {
    const c4d = api.require<Cinema4d>('cinema4d');
    const fracture = new Fracture(api, c4d);
    api.expose(fracture);
    api.addPanel({
      title: msg('分割'), tab: 'object', poll: (sel: SelInfo | null) => sel?.kind === 'shape',
      component: ({ sel }: { sel: SelInfo }) => <FracturePanel sel={sel} c4d={c4d} fracture={fracture} />,
    });
    const objOf = (id: unknown): Obj => {
      const o = id === undefined || id === null ? api.engine.selection.current : api.engine.world.find(Number(id));
      if (!o) throw new Error('物がありません (id を指定してください)');
      return o;
    };
    api.addCommand('set', {
      description: '形を破片に分ける・設定を変える (省いた設定は今のまま。off: true でやめる)',
      params: { id: '物の id', off: 'やめる', mode: 'voronoi / polyfx', count: '破片の数', seed: 'シード', spread: 'uniform / center / edge', gap: 'すき間 0〜0.9', effectors: 'エフェクタの並び (set_cloner と同じ形)' },
      run: p => {
        const { id, off, ...patch } = p;
        const o = objOf(id);
        fracture.set(o, off ? null : patch as Partial<FractureSettings>);
        const problem = fracture.problems.get(o);
        if (problem) throw new Error(problem);
        return { id: o.id, fracture: fracture.get(o), pieces: fracture.count(o) };
      },
    });
    return () => fracture.off();
  },
};
export default mographFracture;
