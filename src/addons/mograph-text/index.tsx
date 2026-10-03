import { msg } from '../../core/i18n';
import type { SelInfo } from '../../engine';
import type { AddonModule } from '../../engine/addons/Addons';
import { isShape, type Obj } from '../../engine/types';
import type { Cinema4d } from '../cinema4d/Cinema4d';
import { MoText, TEXT_DEFAULT, type TextSettings } from './MoText';
import { TextPanel } from './TextPanel';

// --- MoGraph テキスト: Cinema 4D の MoText (厚みのある文字を、文字・単語・行ごとにエフェクタで動かす) ---
const mographText: AddonModule = {
  id: 'mograph-text',
  name: msg('MoGraph テキスト (MoText)'),
  version: '1.0.0',
  author: 'webgl-grid',
  category: 'MoGraph',
  description: msg('厚みのある文字を立てて置き、文字・単語・行ごとにエフェクタ (とフィールド) で動かす。日本語も、このパソコンのフォントで作ります。「追加 > テキスト (MoText)」か、形のパネルの「テキスト」で使います。'),
  enabledByDefault: true,
  requires: ['cinema4d'],
  register(api) {
    const c4d = api.require<Cinema4d>('cinema4d');
    const { engine } = api;
    const motext = new MoText(api, c4d);
    api.expose(motext);
    api.addPanel({
      title: msg('テキスト (MoText)'), tab: 'object', poll: (sel: SelInfo | null) => sel?.kind === 'shape',
      component: ({ sel }: { sel: SelInfo }) => <TextPanel sel={sel} c4d={c4d} motext={motext} />,
    });
    // 追加 > テキスト: 立方体を置いて、テキストにする
    api.addMenuItem({
      menu: 'add', label: msg('テキスト (MoText)'), enabled: () => !engine.world.full,
      run: () => { engine.addShape(0); const o = engine.selection.current; if (o) motext.set(o, { ...TEXT_DEFAULT }); },
    });
    api.addCommand('set', {
      description: '形を MoText (厚みのある文字) にする・設定を変える。id を省くと、新しく置く。off: true でやめる',
      params: {
        id: '物の id (省くと新しく置く)', off: 'やめる', text: '文字 (\\n で改行)', font: 'sans-serif・serif・monospace・cursive かフォントの名前', weight: 'normal / bold',
        size: '大きさ', depth: '厚み', bevel: '面取り 0〜0.5', spacing: '字間', lineSpacing: '行間', align: 'left / center / right',
        unit: 'エフェクタをかける単位: letters / words / lines / all', effectors: 'エフェクタの並び (set_cloner と同じ形)',
      },
      run: p => {
        const { id, off, ...patch } = p;
        let o: Obj | null = id === undefined || id === null ? null : engine.world.find(Number(id));
        if (id !== undefined && id !== null && !o) throw new Error(`id ${id} の物はありません`);
        if (!o) { if (engine.world.full) throw new Error('これ以上置けません'); engine.addShape(0); o = engine.selection.current; }
        if (!isShape(o)) throw new Error('形の物だけテキストにできます');
        motext.set(o, off ? null : { ...(motext.get(o) ? {} : TEXT_DEFAULT), ...patch } as Partial<TextSettings>);
        const problem = motext.problems.get(o);
        if (problem) throw new Error(problem);
        return { id: o.id, text: motext.get(o), units: motext.count(o), letters: motext.letters(o) };
      },
    });
    return () => motext.off();
  },
};
export default mographText;
