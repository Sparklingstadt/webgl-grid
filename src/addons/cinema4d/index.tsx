import { msg } from '../../core/i18n';
import type { AddonModule } from '../../engine/addons/Addons';
import type { SelInfo } from '../../engine';
import type { Obj } from '../../engine/types';
import { Cinema4d } from './Cinema4d';
import type { ClonerSettings } from './cloner';
import { ClonerPanel } from './ClonerPanel';
import type { Deformer } from './deform';
import { DeformerPanel } from './DeformerPanel';

// --- Cinema 4D: クローナー (MoGraph のエフェクタ付き)・デフォーマ ---
// 本体から切り出した組み込みのアドオン (最初から有効)。サイドバーの「オブジェクト」にパネルを足し、
// 「オブジェクト」のメニュー・MCP の命令 (cinema4d.set_cloner・set_deformers・bake_cloner) も足す
const cinema4d: AddonModule = {
  id: 'cinema4d',
  name: 'Cinema 4D',
  version: '1.0.0',
  author: 'webgl-grid',
  category: msg('モデリング'),
  description: msg('Cinema 4D のクローナー (直線・放射・グリッドに並べる。エフェクタ: プレーン・ステップ・ディレイ) と、デフォーマ (ベンド・ツイスト・テーパー・バルジ)。サイドバーの「オブジェクト」で使います。'),
  enabledByDefault: true,
  register(api) {
    const c4d = new Cinema4d(api);
    const { engine } = api;
    api.expose(c4d);
    const notLight = (sel: SelInfo | null) => !!sel && sel.kind !== 'light';
    api.addPanel({ title: msg('デフォーマ'), tab: 'modifier', poll: notLight, component: ({ sel }: { sel: SelInfo }) => <DeformerPanel sel={sel} c4d={c4d} /> });
    api.addPanel({ title: msg('クローナー'), tab: 'modifier', poll: notLight, component: ({ sel }: { sel: SelInfo }) => <ClonerPanel sel={sel} c4d={c4d} /> });
    api.addMenuItem({
      menu: 'object', label: msg('クローナーにする / やめる'),
      enabled: () => { const o = engine.selection.current; return !!o && !o.light; },
      run: () => { const o = engine.selection.current; c4d.setCloner(c4d.cloner(o) ? null : {}, o); },
    });

    // MCP の命令 (id を省くと選んでいる物)
    const objOf = (id: unknown): Obj => {
      const obj = id === undefined || id === null ? engine.selection.current : engine.world.find(Number(id));
      if (!obj) throw new Error(id === undefined || id === null ? '物を選んでいません。id を指定してください' : `id ${id} の物はありません`);
      if (obj.light) throw new Error('ライトには使えません');
      return obj;
    };
    api.addCommand('set_cloner', {
      description: 'クローナー: 物を直線・放射・グリッドに並べる。省いた設定は今のまま。off: true でやめる',
      params: { id: '物の id', off: 'やめる', mode: 'linear / radial / grid', count: '数', step: '[x,y,z]', grid: '[x,y,z]', spacing: '[x,y,z]', effectors: 'エフェクタの並び' },
      run: p => {
        const { id, off, ...patch } = p;
        const obj = objOf(id);
        c4d.setCloner(off ? null : patch as Partial<ClonerSettings>, obj);
        return { id: obj.id, cloner: c4d.cloner(obj), clones: c4d.count(obj) };
      },
    });
    api.addCommand('set_deformers', {
      description: 'デフォーマ: 並びごと入れ替える (空でやめる)',
      params: { id: '物の id', deformers: '[{ kind, axis, amount, directionDeg, enabled }]' },
      run: p => {
        const obj = objOf(p.id);
        c4d.setDeformers((p.deformers ?? []) as Deformer[], obj);
        return { id: obj.id, deformers: c4d.deformerList(obj) };
      },
    });
    api.addCommand('bake_cloner', {
      description: '形のクローンを、1 つずつの物にする (Cinema 4D の「現在の状態をオブジェクト化」)',
      params: { id: '物の id' },
      run: p => {
        const obj = objOf(p.id);
        if (!c4d.bake(obj)) throw new Error(c4d.cloner(obj) ? engine.ui.state.toast?.text ?? '1 つずつの物にできませんでした' : 'クローナーではありません');
        return { objects: engine.world.objects.length };
      },
    });
    // 切るときは、まず「なし」にしてから、クローンと変形を外す (足したものを外すのはそのあと)
    return () => c4d.off();
  },
};
export default cinema4d;
