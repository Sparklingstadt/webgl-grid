import type { SelInfo } from '../../engine';
import type { AddonModule } from '../../engine/addons/Addons';
import { isShape, type Obj } from '../../engine/types';
import type { Cinema4d } from '../cinema4d/Cinema4d';
import { MoSpline, SPLINE_DEFAULT, type SplineSettings } from './MoSpline';
import { SplinePanel } from './SplinePanel';
import { splineEffector, splineMode } from './useSpline';

// --- MoGraph スプライン: Cinema 4D の MoSpline (とスイープ) と、スプラインに並べるクローナー・スプライン・エフェクタ ---
const mographSpline: AddonModule = {
  id: 'mograph-spline',
  name: 'MoGraph スプライン (MoSpline)',
  version: '1.0.0',
  author: 'webgl-grid',
  category: 'MoGraph',
  description: '伸びる曲線 (シンプル・タートル (L-システム)) を管にして置く。成長で時刻に合わせて伸びる。スプライン (MoSpline・トレーサー) にそって並べるクローナーと、スプライン・エフェクタも足します。',
  enabledByDefault: true,
  requires: ['cinema4d'],
  register(api) {
    const c4d = api.require<Cinema4d>('cinema4d');
    const { engine } = api;
    const mospline = new MoSpline(api, c4d);
    api.expose(mospline);
    const splines = (id: number) => (id ? c4d.splinesOf(engine.world.find(id)) : []);
    const offs = [c4d.addClonerMode(splineMode(splines)), c4d.addEffector(splineEffector(splines))];
    api.addPanel({
      title: 'MoSpline', tab: 'object', poll: (sel: SelInfo | null) => sel?.kind === 'shape',
      component: ({ sel }: { sel: SelInfo }) => <SplinePanel sel={sel} mospline={mospline} />,
    });
    api.addMenuItem({
      menu: 'add', label: 'MoSpline', enabled: () => !engine.world.full,
      run: () => { engine.addShape(0); const o = engine.selection.current; if (o) mospline.set(o, { ...SPLINE_DEFAULT }); },
    });
    api.addCommand('set', {
      description: '形を MoSpline (伸びる曲線の管) にする・設定を変える。id を省くと新しく置く。off: true でやめる',
      params: {
        id: '物の id (省くと新しく置く)', off: 'やめる', mode: 'simple / turtle', length: '長さ', segments: '分割数', bend: '曲がり (度)', twist: 'ねじれ (度)',
        premise: '前提', rules: '規則 (F=…; X=…)', iterations: 'くり返し', angle: '角度', step: '歩幅', shrink: '枝の縮み',
        start: '始め 0〜1', end: '終わり 0〜1', grow: '成長の秒数 (0 で伸びない)', growStart: '成長の始め (秒)', radius: '太さ', radiusEnd: '先の太さ',
      },
      run: p => {
        const { id, off, ...patch } = p;
        let o: Obj | null = id === undefined || id === null ? null : engine.world.find(Number(id));
        if (id !== undefined && id !== null && !o) throw new Error(`id ${id} の物はありません`);
        if (!o) { if (engine.world.full) throw new Error('これ以上置けません'); engine.addShape(0); o = engine.selection.current; }
        if (!isShape(o)) throw new Error('形の物だけ MoSpline にできます');
        mospline.set(o, off ? null : { ...(mospline.get(o) ? {} : SPLINE_DEFAULT), ...patch } as Partial<SplineSettings>);
        const problem = mospline.problems.get(o);
        if (problem) throw new Error(problem);
        return { id: o.id, spline: mospline.get(o), segments: mospline.segments(o) };
      },
    });
    return () => { for (const f of offs) f(); mospline.off(); };
  },
};
export default mographSpline;
