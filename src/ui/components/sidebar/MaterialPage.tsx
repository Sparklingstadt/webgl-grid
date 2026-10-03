import { NODE_TYPES } from '../../../core/materials/nodes';
import { findNode, inputLink } from '../../../core/materials/tree';
import { useEngine, useUi } from '../../EngineContext';
import { BSlider } from '../BSlider';
import { ColorField, SocketField, TextField } from '../fields';
import { Empty, Panel } from './Panel';

// --- マテリアル (Blender の「マテリアル」プロパティ) ---
// 選んでいる物のマテリアルスロットの一覧、スロットに入れるマテリアル (新規・複製・名前・共有)、
// サーフェス (プリンシプル BSDF の入力)、設定 (ブレンドモード・裏面)、MMD の輪郭線
export function MaterialPage({ onOpenShaderEditor }: { onOpenShaderEditor: () => void }) {
  const engine = useEngine();
  useUi(s => s.materialsVersion);
  const sel = useUi(s => s.sel);
  if (!sel) return <Panel title="マテリアル"><Empty>物をクリックして選ぶと、そのマテリアルを編集できます。</Empty></Panel>;
  const slots = engine.slots();
  const active = engine.activeSlot();
  const mat = engine.activeMaterial();
  const list = engine.materialList();
  return (
    <>
      <Panel title="マテリアルスロット">
        <ul className="mat-list" role="listbox" aria-label="マテリアルスロット">
          {slots.map(s => (
            <li key={s.index} role="option" aria-selected={s.index === active}>
              <button type="button" className="mat-name" onClick={() => engine.setActiveSlot(s.index)}>
                <span className="mat-ball" aria-hidden="true" />{s.name || '(なし)'}
              </button>
            </li>
          ))}
        </ul>
        <div className="mat-block">
          <select className="bselect" aria-label="スロットのマテリアル" value={mat?.id ?? ''} onChange={e => engine.assignMaterial(e.currentTarget.value || null)}>
            <option value="">(なし)</option>
            {list.map(m => <option key={m.id} value={m.id}>{m.users > 1 ? `${m.name} (${m.users})` : m.users === 0 ? `0 ${m.name}` : m.name}</option>)}
          </select>
          {mat && <TextField label="マテリアルの名前" value={mat.name} onCommit={name => engine.renameMaterial(name)} />}
        </div>
        <div className="row">
          <button type="button" className="bbtn" onClick={() => engine.newMaterial()}>新規</button>
          <button type="button" className="bbtn" disabled={!mat} onClick={() => engine.duplicateMaterial()}>複製</button>
          <button type="button" className="bbtn" disabled={!mat} onClick={() => engine.assignMaterial(null)}>外す</button>
        </div>
        {mat && (engine.materialList().find(m => m.id === mat.id)?.users ?? 0) > 1 && (
          <div className="note">このマテリアルはほかの物とも共有しています。変えると、共有しているすべての物が変わります (「複製」で別にできます)</div>
        )}
      </Panel>
      {mat && <Surface onOpenShaderEditor={onOpenShaderEditor} />}
      {mat && (
        <Panel title="設定">
          <label className="color-field">
            <span>ブレンド</span>
            <select className="bselect" aria-label="ブレンドモード" value={mat.settings.blend}
                    onChange={e => engine.setMaterialSettings({ blend: e.currentTarget.value as typeof mat.settings.blend })}>
              <option value="opaque">不透明</option>
              <option value="blend">アルファブレンド</option>
              <option value="clip">アルファクリップ</option>
            </select>
          </label>
          <label className="check">
            <input type="checkbox" aria-label="裏面を表示しない" checked={mat.settings.backfaceCulling}
                   onChange={e => engine.setMaterialSettings({ backfaceCulling: e.currentTarget.checked })} />
            裏面を表示しない
          </label>
        </Panel>
      )}
      {mat && (
        <Panel title="輪郭線 (MMD)">
          <label className="check">
            <input type="checkbox" aria-label="輪郭線を付ける" checked={mat.outline.enabled}
                   onChange={e => engine.setMaterialOutline({ enabled: e.currentTarget.checked })} />
            輪郭線を付ける
          </label>
          <ColorField label="色" value={mat.outline.color} onChange={color => engine.setMaterialOutline({ color })} />
          <BSlider label="太さ" value={mat.outline.size} min={0} max={3} step={0.05} onChange={size => engine.setMaterialOutline({ size })} />
          <div className="note">選んでいるあいだは、選択を示すオレンジの輪郭線で表示されます</div>
        </Panel>
      )}
      {sel.kind === 'model' && (
        <Panel title="書き出し">
          <button type="button" className="bbtn" onClick={() => engine.exportPmx()}>マテリアルを反映した .pmx を書き出す</button>
          <div className="note">色・アルファ・粗さ (反射の強さ)・輪郭線を .pmx の材質に書き戻します。MMD で表せないつなぎ方は、元の値のままです。書き出したファイルの扱いは、モデルの利用規約に従ってください</div>
        </Panel>
      )}
    </>
  );
}

// サーフェス: マテリアル出力につながっているプリンシプル BSDF の入力 (つながっている入力は、相手のノードの名前)
function Surface({ onOpenShaderEditor }: { onOpenShaderEditor: () => void }) {
  const engine = useEngine();
  const mat = engine.activeMaterial()!;
  const bsdf = engine.surfaceShader();
  return (
    <Panel title="サーフェス">
      {!bsdf ? (
        <Empty>マテリアル出力にプリンシプル BSDF がつながっていません。シェーダーエディターでつないでください。</Empty>
      ) : (
        <>
          <div className="note">サーフェス: プリンシプル BSDF</div>
          {NODE_TYPES.principled.inputs.map(def => {
            const link = inputLink(mat.tree, bsdf.id, def.id);
            const from = link && findNode(mat.tree, link.from.node);
            if (from) {
              return (
                <div key={def.id} className="linked-input">
                  <span>{def.label}</span>
                  <button type="button" className="bbtn" onClick={onOpenShaderEditor} title="シェーダーエディターで開く">← {NODE_TYPES[from.type].label}</button>
                </div>
              );
            }
            if (def.noValue) return null;
            return <SocketField key={def.id} def={def} value={bsdf.values[def.id]} onChange={v => engine.setNodeValue(bsdf.id, def.id, v)} />;
          })}
        </>
      )}
      <button type="button" className="bbtn" onClick={onOpenShaderEditor}>シェーダーエディターで開く</button>
    </Panel>
  );
}
