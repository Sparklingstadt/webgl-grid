import { PALETTE, PALETTE_NAMES, paletteCss } from '../../../core/constants';
import { t } from '../../../core/i18n';
import { kindName, nameOf } from '../../../engine/world/Selection';
import { BSelect } from '../controls/BSelect';
import { useEngine, useUi } from '../../EngineContext';
import { NumField } from '../NumField';
import { AddonPanels } from '../addons/AddonPanels';
import { Empty, Panel } from './Panel';

// --- オブジェクト (Blender のオブジェクトのプロパティ): 選んでいる物の名前・位置・向き・色・モーション ---
// (ライトの設定はライトのタブ、物理演算は物理演算のタブ)
export function ObjectPage() {
  const engine = useEngine();
  const sel = useUi(s => s.sel);
  useUi(s => s.sceneVersion); // (親・コレクション)
  if (!sel) return <><Panel title={t('オブジェクト')}><Empty>{t('何も選んでいません。ビューポートで物をクリックすると選べます。')}</Empty></Panel><AddonPanels tab="object" /></>;
  const deg = ((sel.r * 180 / Math.PI) % 360 + 540) % 360 - 180;
  const obj = engine.world.find(sel.id);
  return (
    <>
      <Panel title={t('オブジェクト')}>
        <div className="prop">
          <label htmlFor="obj-name">{t('名前')}</label>
          <input id="obj-name" className="text-field" key={`${sel.id}:${sel.name}`} defaultValue={sel.name} maxLength={64}
                 onBlur={e => { const o = engine.selection.current; if (o) engine.renameObj(o, e.currentTarget.value.trim() === kindName(o) ? null : e.currentTarget.value); }}
                 onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); else if (e.key === 'Escape') { e.currentTarget.value = sel.name; e.currentTarget.blur(); } }} />
          <label htmlFor="obj-x">{t('位置 X')}</label><NumField id="obj-x" label={t('位置 X')} value={+sel.x.toFixed(2)} digits={2} step={0.1} onCommit={v => engine.setObjProp('x', v)} />
          <label>{t('位置 Y')}</label><span className="note">{t('{y} (積み重ねで決まる)', { y: sel.y.toFixed(2) })}</span>
          <label htmlFor="obj-z">{t('位置 Z')}</label><NumField id="obj-z" label={t('位置 Z')} value={+sel.z.toFixed(2)} digits={2} step={0.1} onCommit={v => engine.setObjProp('z', v)} />
          <label htmlFor="obj-r">{t('回転')}</label><NumField id="obj-r" label={t('縦軸まわりの回転 (度)')} value={Math.round(deg)} onCommit={v => engine.setObjProp('r', v)} />
          {(sel.kind === 'shape' || sel.kind === 'model') && <><label htmlFor="obj-s">{t('大きさ')}</label><NumField id="obj-s" label={t('大きさ (倍)')} value={+sel.scale.toFixed(3)} digits={3} step={0.1} min={0.05} max={20} onCommit={v => { const o = engine.selection.current; if (o) engine.setScale(o, v); }} /></>}
        </div>
      </Panel>
      {obj && (
        <Panel title={t('関係')}>
          <div className="prop">
            <label>{t('親')}</label>
            <BSelect<number> label={t('親')} value={obj.parent ?? -1} onChange={v => engine.setParent(obj, v < 0 ? null : engine.world.find(v) ?? null)}
                             options={[{ value: -1, label: t('なし') }, ...engine.world.objects.filter(o => o !== obj).map(o => ({ value: o.id, label: nameOf(o), disabled: !engine.hierarchy.canParent(obj, o) }))]} />
            <label>{t('コレクション')}</label>
            <BSelect<string> label={t('コレクション')} value={obj.collection ?? ''} onChange={v => engine.moveToCollection(v || null, [obj])}
                             options={[{ value: '', label: t('シーン コレクション') }, ...engine.collections.map(c => ({ value: c.name, label: c.name }))]} />
          </div>
        </Panel>
      )}
      {sel.kind === 'shape' && (
        <Panel title={t('色')}>
          <div className="swatches" role="group" aria-label={t('色')}>
            {PALETTE.map((_, i) => (
              <button key={i} type="button" aria-label={t(PALETTE_NAMES[i])} title={t(PALETTE_NAMES[i])} aria-pressed={sel.c === i}
                      style={{ background: paletteCss(i) }} onClick={() => engine.setObjColor(i)} />
            ))}
          </div>
        </Panel>
      )}
      {sel.kind === 'model' && (
        <Panel title={t('モーション')}>
          <div className="note">{sel.animated ? t('VMD モーションを再生中です。タイムラインで動かせます。') : t('モーションはありません。ファイル > MMD を読み込む… で .vmd を選ぶと付きます。')}</div>
        </Panel>
      )}
      <AddonPanels tab="object" />
      <button type="button" className="bbtn" onClick={() => engine.deleteSelected()}>{t('削除 (X)')}</button>
    </>
  );
}
