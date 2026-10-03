import type { AddonModule } from '../engine/addons/Addons';

interface Bob { height: number; period: number }
const DEFAULT: Bob = { height: 0.3, period: 2 };

// --- ふわふわ: 選んだ物を、タイムラインの時刻に合わせて上下に揺らす ---
// (物ごとの値・オブジェクトのタブのパネル・メニュー・描く前の処理を使う例)
const float: AddonModule = {
  id: 'float',
  name: 'ふわふわ',
  version: '1.0.0',
  author: 'webgl-grid',
  category: 'アニメーション',
  description: '物をタイムラインの時刻に合わせて、ふわふわ上下に揺らします。「オブジェクト > ふわふわさせる」か、サイドバーの「オブジェクト」で設定します。',
  register(api) {
    const { engine } = api;
    const bob = api.addObjectData<Bob>({
      key: 'bob', label: 'ふわふわ',
      normalize: raw => {
        if (!raw || typeof raw !== 'object') return null;
        const r = raw as Partial<Bob>;
        return { height: Number.isFinite(r.height) ? Number(r.height) : DEFAULT.height, period: Math.max(Number(r.period) || DEFAULT.period, 0.1) };
      },
    });
    // 物の位置を決めたあとに、揺れのぶんだけ持ち上げる (積み重ねの高さは変えない)
    api.onBeforeRender(() => {
      const t = engine.clock.t;
      for (const o of engine.world.objects) {
        const b = bob.get(o);
        if (b) o.node.position.y += b.height * (0.5 - 0.5 * Math.cos(2 * Math.PI * t / b.period));
      }
    });
    const current = () => engine.selection.current;
    api.addMenuItem({
      menu: 'object', label: 'ふわふわさせる / やめる', enabled: () => !!current(),
      run: () => { const o = current(); if (o) bob.set(o, bob.get(o) ? null : { ...DEFAULT }); },
    });
    api.addPanel({
      title: 'ふわふわ', tab: 'object', poll: sel => !!sel,
      props: () => {
        const o = current(), b = o ? bob.get(o) : null;
        const set = (p: Partial<Bob>) => { if (o) bob.set(o, { ...DEFAULT, ...b, ...p }); };
        return [
          { type: 'boolean', label: 'ふわふわさせる', get: () => !!b, set: on => { if (o) bob.set(o, on ? { ...DEFAULT } : null); } },
          ...(b ? [
            { type: 'number', label: '高さ', unit: ' m', min: 0, max: 3, step: 0.05, digits: 2, get: () => b.height, set: (height: number) => set({ height }) },
            { type: 'number', label: '周期', unit: ' 秒', min: 0.1, max: 10, step: 0.1, digits: 1, get: () => b.period, set: (period: number) => set({ period }) },
          ] as const : []),
        ];
      },
    });
    api.addCommand('set', {
      description: '物をふわふわさせる (off: true でやめる)',
      params: { id: '物の id (省くと選んでいる物)', height: '揺れる高さ', period: '1 往復の秒数', off: 'やめる' },
      run: p => {
        const o = p.id === undefined ? current() : engine.world.find(Number(p.id));
        if (!o) throw new Error('物がありません');
        bob.set(o, p.off ? null : { ...DEFAULT, ...bob.get(o), ...(p.height !== undefined ? { height: Number(p.height) } : {}), ...(p.period !== undefined ? { period: Number(p.period) } : {}) });
        return { id: o.id, bob: bob.get(o) };
      },
    });
  },
};
export default float;
