import { t } from '../../core/i18n';
import { BSelect } from './controls/BSelect';
import { ShaderEditor } from './ShaderEditor';
import { Timeline } from './Timeline';

export type BottomEditor = 'timeline' | 'shader';

// 下の領域。Blender と同じく、見出しの左端で中身のエディター (タイムライン / シェーダーエディター) を切り替える
export function BottomArea({ editor, setEditor, open, onHover }: {
  editor: BottomEditor; setEditor: (e: BottomEditor) => void; open: boolean; onHover: (area: 'timeline' | 'shader') => void;
}) {
  const typeSelect = (
    <BSelect className="editor-select" label={t('エディターの種類')} value={editor} onChange={setEditor}
             options={[{ value: 'timeline', label: t('タイムライン') }, { value: 'shader', label: t('シェーダーエディター') }]} />
  );
  return (
    <section className="area" aria-label={editor === 'timeline' ? t('タイムライン') : t('シェーダーエディター')}
             onPointerEnter={() => onHover(editor)}>
      {editor === 'timeline'
        ? <Timeline open={open} typeSelect={typeSelect} />
        : <ShaderEditor typeSelect={typeSelect} onHover={() => onHover('shader')} />}
    </section>
  );
}
