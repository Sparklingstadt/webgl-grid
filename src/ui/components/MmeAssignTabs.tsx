import { useId, useMemo, useRef, useState } from 'react';
import { getLang, t } from '../../core/i18n';
import type { EffectRef, SavedSlot } from '../../core/mme/settings.ts';
import { STAGE_ROW_ID, type MmeRowUi, type MmeUiState } from '../../engine/UiChannel';
import { useEngine, useUi } from '../EngineContext';
import { BSelect, type SelectGroup, type SelectOption } from './controls/BSelect';

// --- MME 互換の「エフェクト割当」(MME のエフェクト割当の窓): Main とオフスクリーンのタブ。タブごとにステージ (あれば先頭) と場面の物が並び、
// MMD モデルは開くと材質が並ぶ。行ごとに、読み込んだフォルダの .fx・非表示・既定に戻すを選ぶ。選んでいない行は、既定で描くものを薄い字で出す。
// 行で描くはずの .fx を GPU で止めていれば、そのことも書く。
// タブは WAI-ARIA のタブ (←→・Home・End で移り、選んだタブだけ Tab で止まる)。同じ名前の物は、行の名前に番号を付けて分ける ---

// 選択の値: '' は既定 (割り当てなし)、'hide' は非表示、フォルダの .fx は 'フォルダの id\nパス'。行の選択は表示の文ではなく、行の assignedRef (id) で照らす
const DEFAULT = '';
const HIDE = 'hide';
const MISSING = 'missing'; // 割り当てた .fx がフォルダにない
const fxValue = (folder: string, path: string) => `${folder}\n${path}`;
const shown = (name: string) => (name === 'hide' ? t('非表示') : name); // (行の割り当て・既定の名前を画面に出す)

function slotOf(value: string): SavedSlot | null {
  if (value === DEFAULT) return null;
  if (value === HIDE) return 'hide';
  const i = value.indexOf('\n');
  return { folder: value.slice(0, i), path: value.slice(i + 1) };
}

// 選択肢。フォルダの一覧が変わったときだけ作る (行ごとには作らない): 割り当てがない行 (fresh) と、ある行 (reset。「既定に戻す」) の 2 通りと、フォルダの .fx の値
function useChoices(folders: MmeUiState['folders']) {
  const lang = getLang(); // (言語を替えたら訳し直す。フォルダの一覧は言語では変わらない)
  return useMemo(() => {
    const groups: SelectGroup<string>[] = folders.filter(f => f.fx.length > 0).map(f => ({
      group: f.name || t('名前のないフォルダ'), options: f.fx.map(path => ({ value: fxValue(f.id, path), label: path })),
    }));
    const head = (reset: boolean): SelectOption<string>[] => [{ value: DEFAULT, label: reset ? t('既定に戻す') : t('既定') }, { value: HIDE, label: t('非表示') }];
    const known = new Set(groups.flatMap(g => g.options.map(o => o.value)));
    return { lang, fresh: [...head(false), ...groups], reset: [...head(true), ...groups], head: head(true), groups, known };
  }, [folders, lang]);
}

// 行の選択の値と選択肢 (割り当てた .fx がフォルダにないときは、その名前を選べない選択肢にして出す)
function choices(row: MmeRowUi, c: ReturnType<typeof useChoices>): { value: string; options: (SelectOption<string> | SelectGroup<string>)[] } {
  const ref: EffectRef | 'hide' | null = row.assignedRef;
  if (ref === null) return { value: DEFAULT, options: c.fresh };
  if (ref === 'hide') return { value: HIDE, options: c.reset };
  const value = fxValue(ref.folder, ref.path);
  if (c.known.has(value)) return { value, options: c.reset };
  const missing = { value: MISSING, label: t('{fx} (見つかりません)', { fx: row.assigned ?? ref.path }), disabled: true };
  return { value: MISSING, options: [...c.head, missing, ...c.groups] };
}

// 物の行の名前: 同じ名前の物が 2 つ以上あれば、場面の並びの順に番号を付ける (「立方体 (1)」「立方体 (2)」)。物の番号 → 名前
function uniqueLabels(rows: readonly MmeRowUi[]): Map<number, string> {
  const objects = rows.filter(r => r.material === null);
  const total = new Map<string, number>();
  for (const r of objects) total.set(r.label, (total.get(r.label) ?? 0) + 1);
  const seen = new Map<string, number>();
  return new Map(objects.map(r => {
    if (total.get(r.label) === 1) return [r.objId, r.label];
    const n = (seen.get(r.label) ?? 0) + 1;
    seen.set(r.label, n);
    return [r.objId, t('{name} ({n})', { name: r.label, n })];
  }));
}

export function MmeAssignTabs() {
  const engine = useEngine();
  const mme = useUi(s => s.mme);
  const [tabName, setTab] = useState('Main');
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set()); // 材質を開いている物 (タブをまたいで同じ)
  const base = useId();
  const tabButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const c = useChoices(mme.folders);
  const current = Math.max(0, mme.tabs.findIndex(x => x.name === tabName));
  const tab = mme.tabs[current];
  const rows = mme.rows[tab.name];
  const labels = useMemo(() => uniqueLabels(rows ?? []), [rows]);
  const toggle = (id: number) => setOpen(s => {
    const next = new Set(s);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  const assign = (row: MmeRowUi, value: string) => {
    if (row.objId === STAGE_ROW_ID) { engine.mme.assignStage(tab.name, row.material, slotOf(value)); return; }
    const obj = engine.world.find(row.objId);
    if (obj) engine.mme.assign(obj, tab.name, row.material, slotOf(value));
  };
  // タブの矢印キー (←→ で前後 (端は反対側へ)・Home・End)。移ったタブを選んで、キーの操作もそのタブに移す。
  // Alt・Ctrl・Meta といっしょのものはブラウザに任せる (Alt+← の「戻る」など)
  const onTabKey = (e: React.KeyboardEvent, i: number) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const n = mme.tabs.length;
    const to = e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i + n - 1) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    e.stopPropagation();
    setTab(mme.tabs[to].name);
    tabButtons.current[to]?.focus();
  };
  return (
    <>
      <div className="mme-head">{t('エフェクト割当')}</div>
      <div className="mme-tabs" role="tablist" aria-label={t('エフェクト割当')}>
        {mme.tabs.map((x, i) => (
          <button key={x.name} ref={el => { tabButtons.current[i] = el; }} type="button" className="bbtn" role="tab" id={`${base}-tab-${i}`}
                  aria-selected={i === current} aria-controls={`${base}-panel-${i}`} tabIndex={i === current ? 0 : -1} title={x.description || x.name}
                  onClick={() => setTab(x.name)} onKeyDown={e => onTabKey(e, i)}>{x.name}</button>
        ))}
      </div>
      {mme.tabs.map((x, i) => (
        <div key={x.name} role="tabpanel" id={`${base}-panel-${i}`} aria-labelledby={`${base}-tab-${i}`} hidden={i !== current}>
          {i === current && (
            <>
              {tab.description && <div className="note mme-desc">{tab.description}</div>}
              {!rows ? <div className="note">{t('このオフスクリーンを描くエフェクトがないので、ここでの割り当ては効きません')}</div>
                : rows.length === 0 ? <div className="note">{t('場面に物がありません')}</div>
                : (
                  <ul className="mme-rows" aria-label={t('{tab} の割り当て', { tab: tab.name })}>
                    {rows.map((row, k) => {
                      if (row.material !== null && !open.has(row.objId)) return null;
                      const objName = labels.get(row.objId) ?? '';
                      const isMaterial = row.material !== null;
                      const hasMaterials = !isMaterial && rows[k + 1]?.objId === row.objId && rows[k + 1].material !== null;
                      const label = row.material !== null ? t('{name} の材質 {n} の .fx', { name: objName, n: row.material }) : t('{name} の .fx', { name: objName });
                      const { value, options } = choices(row, c);
                      const name = isMaterial ? `${row.material}. ${row.label}` : objName;
                      // 既定の欄・止めた知らせは、選択に結ぶ (読み上げで選択のあとに続く)
                      const rowId = `${base}-${i}-${row.objId}-${row.material ?? 'o'}`;
                      const describedBy = [row.assignedRef === null && `${rowId}-fb`, row.stopped && `${rowId}-stopped`].filter(Boolean).join(' ') || undefined;
                      return (
                        <li key={`${row.objId}:${row.material ?? ''}`} className={`mme-row${isMaterial ? ' mme-mat' : ''}`}>
                          {hasMaterials ? (
                            <button type="button" className="mme-toggle" aria-expanded={open.has(row.objId)} aria-label={t('{name} の材質を開く', { name: objName })}
                                    title={t('{name} の材質を開く', { name: objName })} onClick={() => toggle(row.objId)}>{open.has(row.objId) ? '▾' : '▸'}</button>
                          ) : <span />}
                          <span className="mme-name" title={name}>{name}</span>
                          <BSelect value={value} options={options} label={label} describedBy={describedBy} onChange={v => assign(row, v)} />
                          {row.assignedRef === null && <span id={`${rowId}-fb`} className="note mme-fallback" title={shown(row.fallback)}>{shown(row.fallback)}</span>}
                          {row.stopped && <span id={`${rowId}-stopped`} className="note mme-error mme-stopped">{t('{name} は GPU で使えないので止めました', { name: row.stopped })}</span>}
                        </li>
                      );
                    })}
                  </ul>
                )}
            </>
          )}
        </div>
      ))}
    </>
  );
}
