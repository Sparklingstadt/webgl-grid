import { msg, t } from '../../core/i18n';
import { BSelect } from './controls/BSelect';
import { GraphEditor } from './GraphEditor';
import { ShaderEditor } from './ShaderEditor';
import { Timeline } from './Timeline';

export type BottomEditor = 'timeline' | 'dopesheet' | 'graph' | 'shader';
const EDITORS: [BottomEditor, string][] = [['timeline', msg('タイムライン')], ['dopesheet', msg('ドープシート')], ['graph', msg('グラフエディター')], ['shader', msg('シェーダーエディター')]];

// 下の領域。Blender と同じく、見出しの左端で中身のエディター (タイムライン・ドープシート・グラフエディター・シェーダーエディター) を切り替える
export function BottomArea({ editor, setEditor, open, onHover }: {
  editor: BottomEditor; setEditor: (e: BottomEditor) => void; open: boolean; onHover: (area: 'timeline' | 'shader') => void;
}) {
  const typeSelect = (
    <BSelect className="editor-select" label={t('エディターの種類')} value={editor} onChange={setEditor}
             options={EDITORS.map(([value, label]) => ({ value, label: t(label) }))} />
  );
  return (
    <section className="area bottom" aria-label={t(EDITORS.find(([k]) => k === editor)![1])}
             onPointerEnter={() => onHover(editor === 'shader' ? 'shader' : 'timeline')}>
      {editor === 'timeline' && <Timeline open={open} typeSelect={typeSelect} />}
      {editor === 'dopesheet' && <Timeline open={open} typeSelect={typeSelect} mode="dopesheet" />}
      {editor === 'graph' && <GraphEditor open={open} typeSelect={typeSelect} />}
      {editor === 'shader' && <ShaderEditor typeSelect={typeSelect} onHover={() => onHover('shader')} />}
    </section>
  );
}
