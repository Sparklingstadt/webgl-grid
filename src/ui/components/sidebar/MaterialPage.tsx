import { t } from '../../../core/i18n';
import { NODE_TYPES } from '../../../core/materials/nodes';
import { findNode, inputLink } from '../../../core/materials/tree';
import { useEngine, useUi } from '../../EngineContext';
import { BSlider } from '../BSlider';
import { BCheck } from '../controls/BCheck';
import { BSelect } from '../controls/BSelect';
import { ColorField, SelectField, SocketField, TextField } from '../fields';
import { Empty, Panel } from './Panel';

// --- マテリアル (Blender の「マテリアル」プロパティ) ---
// 選んでいる物のマテリアルスロットの一覧、スロットに入れるマテリアル (新規・複製・名前・共有)、
// サーフェス (プリンシプル BSDF の入力)、設定 (ブレンドモード・裏面)、MMD の輪郭線
export function MaterialPage({ onOpenShaderEditor }: { onOpenShaderEditor: () => void }) {
  const engine = useEngine();
  useUi(s => s.materialsVersion);
  const sel = useUi(s => s.sel);
  if (!sel) return <Panel title={t('マテリアル')}><Empty>{t('物をクリックして選ぶと、そのマテリアルを編集できます。')}</Empty></Panel>;
  const slots = engine.materials.slots();
  const active = engine.materials.activeSlot();
  const mat = engine.materials.active();
  const list = engine.materials.list();
  return (
    <>
      <Panel title={t('マテリアルスロット')}>
        <ul className="mat-list" role="listbox" aria-label={t('マテリアルスロット')}>
          {slots.map(s => (
            <li key={s.index} role="option" aria-selected={s.index === active}>
              <button type="button" className="mat-name" onClick={() => engine.materials.setActiveSlot(s.index)}>
                <span className="mat-ball" aria-hidden="true" />{s.name || t('(なし)')}
              </button>
            </li>
          ))}
        </ul>
        <div className="mat-block">
          <BSelect label={t('スロットのマテリアル')} value={mat?.id ?? ''} onChange={v => engine.materials.assign(v || null)}
                   options={[{ value: '', label: t('(なし)') }, ...list.map(m => ({ value: m.id, label: m.users > 1 ? `${m.name} (${m.users})` : m.users === 0 ? `0 ${m.name}` : m.name }))]} />
          {mat && <TextField label={t('マテリアルの名前')} value={mat.name} onCommit={name => engine.materials.rename(name)} />}
        </div>
        <div className="row">
          <button type="button" className="bbtn" onClick={() => engine.materials.create()}>{t('新規')}</button>
          <button type="button" className="bbtn" disabled={!mat} onClick={() => engine.materials.duplicate()}>{t('複製')}</button>
          <button type="button" className="bbtn" disabled={!mat} onClick={() => engine.materials.assign(null)}>{t('外す')}</button>
        </div>
        {mat && (engine.materials.list().find(m => m.id === mat.id)?.users ?? 0) > 1 && (
          <div className="note">{t('このマテリアルはほかの物とも共有しています。変えると、共有しているすべての物が変わります (「複製」で別にできます)')}</div>
        )}
      </Panel>
      {mat && <Surface onOpenShaderEditor={onOpenShaderEditor} />}
      {mat && (
        <Panel title={t('設定')}>
          <SelectField label={t('ブレンド')} ariaLabel={t('ブレンドモード')} value={mat.settings.blend} onChange={blend => engine.materials.setSettings({ blend })}
                       options={[{ value: 'opaque', label: t('不透明') }, { value: 'blend', label: t('アルファブレンド') }, { value: 'clip', label: t('アルファクリップ') }] as const} />
          <BCheck checked={mat.settings.backfaceCulling} onChange={backfaceCulling => engine.materials.setSettings({ backfaceCulling })}>{t('裏面を表示しない')}</BCheck>
        </Panel>
      )}
      {mat && (
        <Panel title={t('輪郭線 (MMD)')}>
          <BCheck checked={mat.outline.enabled} onChange={enabled => engine.materials.setOutline({ enabled })}>{t('輪郭線を付ける')}</BCheck>
          <ColorField label={t('色')} value={mat.outline.color} onChange={color => engine.materials.setOutline({ color })} />
          <BSlider label={t('太さ')} value={mat.outline.size} min={0} max={3} step={0.05} onChange={size => engine.materials.setOutline({ size })} />
          <div className="note">{t('選んでいるあいだは、選択を示すオレンジの輪郭線で表示されます')}</div>
        </Panel>
      )}
      {sel.kind === 'model' && (
        <Panel title={t('書き出し')}>
          <button type="button" className="bbtn" onClick={() => engine.exportPmx()}>{t('マテリアルを反映した .pmx を書き出す')}</button>
          <div className="note">{t('色・アルファ・粗さ (反射の強さ)・輪郭線を .pmx の材質に書き戻します。MMD で表せないつなぎ方は、元の値のままです。書き出したファイルの扱いは、モデルの利用規約に従ってください')}</div>
        </Panel>
      )}
    </>
  );
}

// サーフェス: マテリアル出力につながっているプリンシプル BSDF の入力 (つながっている入力は、相手のノードの名前)
function Surface({ onOpenShaderEditor }: { onOpenShaderEditor: () => void }) {
  const engine = useEngine();
  const mat = engine.materials.active()!;
  const bsdf = engine.materials.surfaceShader();
  return (
    <Panel title={t('サーフェス')}>
      {!bsdf ? (
        <Empty>{t('マテリアル出力にプリンシプル BSDF がつながっていません。シェーダーエディターでつないでください。')}</Empty>
      ) : (
        <>
          <div className="note">{t('サーフェス: プリンシプル BSDF')}</div>
          {NODE_TYPES.principled.inputs.map(def => {
            const link = inputLink(mat.tree, bsdf.id, def.id);
            const from = link && findNode(mat.tree, link.from.node);
            if (from) {
              return (
                <div key={def.id} className="linked-input">
                  <span>{t(def.label)}</span>
                  <button type="button" className="bbtn" onClick={onOpenShaderEditor} title={t('シェーダーエディターで開く')}>← {t(NODE_TYPES[from.type].label)}</button>
                </div>
              );
            }
            if (def.noValue) return null;
            return <SocketField key={def.id} def={def} value={bsdf.values[def.id]} onChange={v => engine.materials.setNodeValue(bsdf.id, def.id, v)} />;
          })}
        </>
      )}
      <button type="button" className="bbtn" onClick={onOpenShaderEditor}>{t('シェーダーエディターで開く')}</button>
    </Panel>
  );
}
