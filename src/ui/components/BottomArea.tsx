import { ShaderEditor } from './ShaderEditor';
import { Timeline } from './Timeline';

export type BottomEditor = 'timeline' | 'shader';

// 下の領域。Blender と同じく、見出しの左端で中身のエディター (タイムライン / シェーダーエディター) を切り替える
export function BottomArea({ editor, setEditor, open, onHover }: {
  editor: BottomEditor; setEditor: (e: BottomEditor) => void; open: boolean; onHover: (area: 'timeline' | 'shader') => void;
}) {
  const typeSelect = (
    <select className="editor-select" aria-label="エディターの種類" value={editor} onChange={e => setEditor(e.currentTarget.value as BottomEditor)}>
      <option value="timeline">タイムライン</option>
      <option value="shader">シェーダーエディター</option>
    </select>
  );
  return (
    <section className="area" aria-label={editor === 'timeline' ? 'タイムライン' : 'シェーダーエディター'}
             onPointerEnter={() => onHover(editor)}>
      {editor === 'timeline'
        ? <Timeline open={open} typeSelect={typeSelect} />
        : <ShaderEditor typeSelect={typeSelect} onHover={() => onHover('shader')} />}
    </section>
  );
}
