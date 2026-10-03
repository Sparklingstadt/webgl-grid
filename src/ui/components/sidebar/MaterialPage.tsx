import { useState } from 'react';
import { useEngine, useUi } from '../../EngineContext';
import { BSlider } from '../BSlider';
import { Empty, NeedModel, Panel } from './Panel';

// --- マテリアル: 選んでいるモデルの材質の一覧と、その色・不透明度・反射・輪郭線 ---
export function MaterialPage() {
  return <NeedModel>{id => <MaterialEditor key={id} />}</NeedModel>;
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (hex: string) => void }) {
  return (
    <label className="color-field">
      <span>{label}</span>
      <input type="color" value={value} aria-label={label} onChange={e => onChange(e.currentTarget.value)} />
    </label>
  );
}

function MaterialEditor() {
  const engine = useEngine();
  useUi(s => s.values); // 値が変わったら描き直す
  const list = engine.materialList();
  const [index, setIndex] = useState(0);
  const m = engine.material(index);
  if (!list.length || !m) return <Panel title="マテリアル"><Empty>このモデルには材質がありません</Empty></Panel>;
  const set = (patch: Parameters<typeof engine.setMaterial>[1]) => engine.setMaterial(index, patch);
  const edited = list[index]?.edited;
  return (
    <>
      <Panel title="マテリアル">
        <ul className="mat-list" role="listbox" aria-label="材質">
          {list.map(item => (
            <li key={item.index} role="option" aria-selected={item.index === index}>
              <button type="button" className="mat-eye" aria-pressed={item.visible} title={item.visible ? '隠す' : '表示する'}
                      aria-label={`${item.name}を${item.visible ? '隠す' : '表示する'}`}
                      onClick={() => engine.setMaterial(item.index, { visible: !item.visible })}>
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                  <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" fill="none" stroke="currentColor" strokeWidth="1.3" />
                  <circle cx="8" cy="8" r="2" fill="currentColor" />
                </svg>
              </button>
              <button type="button" className="mat-name" onClick={() => setIndex(item.index)}>{item.name}</button>
              {item.edited && <span className="mat-edited" title="変えてある">●</span>}
            </li>
          ))}
        </ul>
        <div className="row">
          <button type="button" className="bbtn" disabled={!edited} onClick={() => engine.resetMaterial(index)}>この材質を元に戻す</button>
          <button type="button" className="bbtn" disabled={!list.some(i => i.edited)} onClick={() => engine.resetAllMaterials()}>すべて元に戻す</button>
        </div>
      </Panel>
      <Panel title={`サーフェス: ${m.name}`}>
        <label className="check">
          <input type="checkbox" checked={m.visible} aria-label="表示する" onChange={e => set({ visible: e.currentTarget.checked })} />
          表示する
        </label>
        <ColorField label="色" value={m.diffuse} onChange={diffuse => set({ diffuse })} />
        <BSlider label="不透明度" value={m.opacity} min={0} max={1} step={0.01} onChange={opacity => set({ opacity })} />
        <ColorField label="環境色" value={m.ambient} onChange={ambient => set({ ambient })} />
        <ColorField label="反射色" value={m.specular} onChange={specular => set({ specular })} />
        <BSlider label="反射の強さ" value={m.shininess} min={0} max={100} step={0.5} digits={1} onChange={shininess => set({ shininess })} />
        <div className="note">テクスチャのある材質では、色はテクスチャに掛け合わされます (白でテクスチャのまま)</div>
      </Panel>
      <Panel title="輪郭線">
        <label className="check">
          <input type="checkbox" checked={m.edgeVisible} aria-label="輪郭線を付ける" onChange={e => set({ edgeVisible: e.currentTarget.checked })} />
          輪郭線を付ける
        </label>
        <ColorField label="色" value={m.edgeColor} onChange={edgeColor => set({ edgeColor })} />
        <BSlider label="太さ" value={m.edgeSize} min={0} max={3} step={0.05} onChange={edgeSize => set({ edgeSize })} />
        <div className="note">選んでいるあいだは、選択を示すオレンジの輪郭線で表示されます。選択を解除すると、ここで決めた輪郭線になります</div>
      </Panel>
    </>
  );
}
