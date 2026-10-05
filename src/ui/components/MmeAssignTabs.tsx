import { useState } from 'react';
import { t } from '../../core/i18n';
import type { SavedSlot } from '../../core/mme/settings.ts';
import type { MmeRowUi, MmeUiState } from '../../engine/UiChannel';
import { useEngine, useUi } from '../EngineContext';
import { BSelect, type SelectGroup, type SelectOption } from './controls/BSelect';

// --- MME 互換の「エフェクト割当」(MME のエフェクト割当の窓): Main とオフスクリーンのタブ。タブごとに場面の物が並び、
// MMD モデルは開くと材質が並ぶ。行ごとに、読み込んだフォルダの .fx・非表示・既定に戻すを選ぶ。選んでいない行は、既定で描くものを薄い字で出す。
// 行で描くはずの .fx を GPU で止めていれば、そのことも書く ---

// 選択の値: '' は既定 (割り当てなし)、'hide' は非表示、フォルダの .fx は 'フォルダの id\nパス'
const DEFAULT = '';
const HIDE = 'hide';
const fxValue = (folder: string, path: string) => `${folder}\n${path}`;
const fxName = (folder: { name: string }, path: string) => (folder.name ? `${folder.name}/${path}` : path);
const shown = (name: string) => (name === 'hide' ? t('非表示') : name); // (行の割り当て・既定の名前を画面に出す)

function slotOf(value: string): SavedSlot | null {
  if (value === DEFAULT) return null;
  if (value === HIDE) return 'hide';
  const i = value.indexOf('\n');
  return { folder: value.slice(0, i), path: value.slice(i + 1) };
}

// 行の選択の値と選択肢 (割り当てた .fx がフォルダにないときは、その名前を選べない選択肢にして出す)
function choices(row: MmeRowUi, folders: MmeUiState['folders']) {
  const groups: SelectGroup<string>[] = folders.filter(f => f.fx.length > 0).map(f => ({
    group: f.name || t('名前のないフォルダ'), options: f.fx.map(path => ({ value: fxValue(f.id, path), label: path })),
  }));
  const head: SelectOption<string>[] = [{ value: DEFAULT, label: row.assigned === null ? t('既定') : t('既定に戻す') }, { value: HIDE, label: t('非表示') }];
  const assigned = row.assigned;
  if (assigned === null) return { value: DEFAULT, options: [...head, ...groups] };
  if (assigned === 'hide') return { value: HIDE, options: [...head, ...groups] };
  for (const f of folders) {
    const path = f.fx.find(p => fxName(f, p) === assigned);
    if (path !== undefined) return { value: fxValue(f.id, path), options: [...head, ...groups] };
  }
  const missing = { value: 'missing', label: t('{fx} (見つかりません)', { fx: assigned }), disabled: true };
  return { value: missing.value, options: [...head, missing, ...groups] };
}

export function MmeAssignTabs() {
  const engine = useEngine();
  const mme = useUi(s => s.mme);
  const [tabName, setTab] = useState('Main');
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set()); // 材質を開いている物 (タブをまたいで同じ)
  const tab = mme.tabs.find(x => x.name === tabName) ?? mme.tabs[0];
  const rows = mme.rows[tab.name];
  const toggle = (id: number) => setOpen(s => {
    const next = new Set(s);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  const assign = (row: MmeRowUi, value: string) => {
    const obj = engine.world.find(row.objId);
    if (obj) engine.mme.assign(obj, tab.name, row.material, slotOf(value));
  };
  // (物の行の名前。材質の行の選択の名前にも使う)
  const owner = new Map<number, string>();
  for (const r of rows ?? []) if (r.material === null) owner.set(r.objId, r.label);
  return (
    <>
      <div className="mme-head">{t('エフェクト割当')}</div>
      <div className="mme-tabs" role="tablist" aria-label={t('エフェクト割当')}>
        {mme.tabs.map(x => (
          <button key={x.name} type="button" className="bbtn" role="tab" aria-selected={x.name === tab.name} title={x.description || x.name}
                  onClick={() => setTab(x.name)}>{x.name}</button>
        ))}
      </div>
      {tab.description && <div className="note mme-desc">{tab.description}</div>}
      {!rows ? <div className="note">{t('このオフスクリーンを描くエフェクトがないので、ここでの割り当ては効きません')}</div>
        : rows.length === 0 ? <div className="note">{t('場面に物がありません')}</div>
        : (
          <ul className="mme-rows" aria-label={t('{tab} の割り当て', { tab: tab.name })}>
            {rows.map((row, i) => {
              if (row.material !== null && !open.has(row.objId)) return null;
              const objName = owner.get(row.objId) ?? '';
              const isMaterial = row.material !== null;
              const hasMaterials = !isMaterial && rows[i + 1]?.objId === row.objId && rows[i + 1].material !== null;
              const label = row.material !== null ? t('{name} の材質 {n} の .fx', { name: objName, n: row.material }) : t('{name} の .fx', { name: row.label });
              const { value, options } = choices(row, mme.folders);
              const name = isMaterial ? `${row.material}. ${row.label}` : row.label;
              return (
                <li key={`${row.objId}:${row.material ?? ''}`} className={`mme-row${isMaterial ? ' mme-mat' : ''}`}>
                  {hasMaterials ? (
                    <button type="button" className="mme-toggle" aria-expanded={open.has(row.objId)} aria-label={t('{name} の材質を開く', { name: row.label })}
                            title={t('{name} の材質を開く', { name: row.label })} onClick={() => toggle(row.objId)}>{open.has(row.objId) ? '▾' : '▸'}</button>
                  ) : <span />}
                  <span className="mme-name" title={name}>{name}</span>
                  <BSelect value={value} options={options} label={label} onChange={v => assign(row, v)} />
                  {row.assigned === null && <span className="note mme-fallback" title={shown(row.fallback)}>{shown(row.fallback)}</span>}
                  {row.stopped && <span className="note mme-error mme-stopped">{t('{name} は GPU で使えないので止めました', { name: row.stopped })}</span>}
                </li>
              );
            })}
          </ul>
        )}
    </>
  );
}
