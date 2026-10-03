import { msg } from '../../core/i18n';
import type { SelInfo } from '../../engine';
import type { AddonModule } from '../../engine/addons/Addons';
import type { Obj } from '../../engine/types';
import type { Cinema4d } from '../cinema4d/Cinema4d';
import { Extrude, type ExtrudeSettings } from './Extrude';
import { ExtrudePanel } from './ExtrudePanel';

// --- MoGraph MoExtrude: 形の面を、エフェクタに合わせて押し出す (Cinema 4D の MoExtrude) ---
const mographExtrude: AddonModule = {
  id: 'mograph-extrude',
  name: msg('MoGraph MoExtrude'),
  version: '1.0.0',
  author: 'webgl-grid',
  category: 'MoGraph',
  description: msg('形の面を、法線の向きへ押し出す。エフェクタ (とフィールド) で面ごとの長さとずれを変え、段の数とふたの大きさも決められます。プロパティの「モディファイアー」の「MoExtrude」で使います。'),
  enabledByDefault: true,
  requires: ['cinema4d'],
  register(api) {
    const c4d = api.require<Cinema4d>('cinema4d');
    const extrude = new Extrude(api, c4d);
    api.expose(extrude);
    api.addPanel({
      title: 'MoExtrude', tab: 'modifier', poll: (sel: SelInfo | null) => sel?.kind === 'shape',
      component: ({ sel }: { sel: SelInfo }) => <ExtrudePanel sel={sel} c4d={c4d} extrude={extrude} />,
    });
    api.addCommand('set', {
      description: '形の面を押し出す・設定を変える (省いた設定は今のまま。off: true でやめる)',
      params: { id: '物の id', off: 'やめる', offset: '押し出す長さ', steps: '段の数', capScale: 'ふたの大きさ', effectors: 'エフェクタの並び (set_cloner と同じ形)' },
      run: p => {
        const { id, off, ...patch } = p;
        const o: Obj | null = id === undefined || id === null ? api.engine.selection.current : api.engine.world.find(Number(id));
        if (!o) throw new Error('物がありません (id を指定してください)');
        extrude.set(o, off ? null : patch as Partial<ExtrudeSettings>);
        const problem = extrude.problems.get(o);
        if (problem) throw new Error(problem);
        return { id: o.id, extrude: extrude.get(o), faces: extrude.faceCount(o) };
      },
    });
    return () => extrude.off();
  },
};
export default mographExtrude;
