import { useState } from 'react';
import { t } from '../../core/i18n';
import { nameOf } from '../../engine/world/Selection';
import { BCheck } from '../../ui/components/controls/BCheck';
import { BSelect } from '../../ui/components/controls/BSelect';
import { NumField } from '../../ui/components/NumField';
import { useEngine, useUi } from '../../ui/EngineContext';
import type { Cinema4d } from './Cinema4d';
import type { Effector, FieldLayer, Vec3 } from './cloner';
import { FIELD_BLENDS, newEffector, newFieldLayer, paramsOf, type EffectorParam, type EffectorValue } from './effectors';

// --- MoGraph の設定の欄: 種類ごとの設定・エフェクタの並び (MoGraph 選択・フィールド付き) ---
// クローナーのパネルと、ほかの MoGraph の物 (分割など) のパネルで使う

// 種類ごとの設定 1 つ (prefix は欄の名前の頭)
export function ParamField({ prefix, param: p, value, onChange }: { prefix: string; param: EffectorParam; value: EffectorValue; onChange: (v: EffectorValue) => void }) {
  const label = `${t('{prefix}の{label}', { prefix, label: t(p.label) })}${p.unit ? ` (${t(p.unit)})` : ''}`;
  const hint = p.hint === undefined ? undefined : t(p.hint);
  return (
    <>
      <label title={hint}>{t(p.label)}</label>
      {p.type === 'boolean' ? <BCheck checked={!!value} label={label} onChange={onChange} />
        : p.type === 'select' ? <BSelect<string> label={label} value={String(value)} onChange={onChange} options={(p.options ?? []).map(o => ({ value: o.value, label: t(o.label) }))} />
          : p.type === 'text' ? <TextInput label={label} value={String(value)} hint={hint} onCommit={onChange} />
            : p.type === 'object' ? <ObjectPick label={label} value={Number(value)} onChange={onChange} />
              : <NumField label={label} value={Number(value)} min={p.min} max={p.max} step={p.step ?? 1} digits={p.digits ?? 0} onCommit={onChange} />}
    </>
  );
}
export function Params({ prefix, defs, values, onChange }: { prefix: string; defs: EffectorParam[] | undefined; values: Record<string, EffectorValue>; onChange: (v: Record<string, EffectorValue>) => void }) {
  const all = paramsOf(defs, values);
  return <>{(defs ?? []).map(p => <ParamField key={p.key} prefix={prefix} param={p} value={all[p.key]} onChange={v => onChange({ ...values, [p.key]: v })} />)}</>;
}

// 文字の欄 (Enter か離れたときに決める。空にもできる)
function TextInput({ label, value, hint, onCommit }: { label: string; value: string; hint?: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input className="text-field" type="text" aria-label={label} title={hint ?? label} placeholder={hint} value={draft ?? value} spellCheck={false}
           onChange={e => setDraft(e.currentTarget.value)}
           onBlur={() => { if (draft !== null && draft !== value) onCommit(draft); setDraft(null); }}
           onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setDraft(null); e.currentTarget.blur(); } e.stopPropagation(); }} />
  );
}
// 場面の物を選ぶ欄 (id。0 はなし)
function ObjectPick({ label, value, onChange }: { label: string; value: number; onChange: (id: number) => void }) {
  const engine = useEngine();
  useUi(s => s.history.index); // (物が増えたり減ったりしたら、選べる物を描き直す)
  const options = [{ value: 0, label: t('(なし)') }, ...engine.world.objects.map(o => ({ value: o.id, label: `${nameOf(o)} (id ${o.id})` }))];
  return <BSelect<number> label={label} value={value} onChange={onChange} options={options} />;
}

// エフェクタ (Cinema 4D の MoGraph エフェクタ) の並び。上から順にかける。
// 足せる種類と、種類ごとの設定の欄は、登録されたエフェクタ (MoGraph エフェクタのアドオン) から作る
export function EffectorList({ list, c4d, isModel, onChange }: { list: Effector[]; c4d: Cinema4d; isModel: boolean; onChange: (l: Effector[]) => void }) {
  const defs = c4d.effectors.list();
  const update = (i: number, patch: Partial<Effector>) => onChange(list.map((e, k) => (k === i ? { ...e, ...patch } : e)));
  const notes = new Set(list.filter(e => e.enabled).map(e => defs.find(d => d.key === e.kind)?.note?.(isModel)).filter(Boolean).map(n => t(n!)));
  return (
    <div className="effectors">
      <div className="effectors-head">{t('エフェクタ')}</div>
      {list.map((e, i) => {
        const def = defs.find(d => d.key === e.kind);
        const name = def ? t(def.name) : e.kind;
        const problem = def?.check?.(e);
        return (
          <div key={i} className="effector" role="group" aria-label={t('エフェクタ {n} {name}', { n: i + 1, name })}>
            <div className="effector-title">
              <BCheck checked={e.enabled} onChange={enabled => update(i, { enabled })}>{name}</BCheck>
              <button type="button" className="hbtn" aria-label={t('{name}を外す', { name })} title={t('外す')} onClick={() => onChange(list.filter((_, k) => k !== i))}>×</button>
            </div>
            {!def ? <div className="note">{t('この種類のエフェクタは登録されていないので、働きません (MoGraph エフェクタのアドオンを有効にしてください)')}</div> : (
              <div className="prop cloner">
                <Params prefix={name} defs={def.params} values={e.params} onChange={params => update(i, { params })} />
                {def.transform !== false && <>
                  <label>{t('位置')}</label>
                  <div className="row">
                    {(['X', 'Y', 'Z'] as const).map((axis, k) => (
                      <NumField key={axis} label={t('{name}の位置 {axis}', { name, axis })} value={e.position[k]} step={0.1} digits={1}
                                onCommit={v => { const p = [...e.position] as Vec3; p[k] = v; update(i, { position: p }); }} />
                    ))}
                  </div>
                  <label>{t('回転')}</label>
                  <NumField label={t('{name}の回転 (度)', { name })} value={e.rotationDeg} step={5} onCommit={rotationDeg => update(i, { rotationDeg })} />
                  <label>{t('大きさ')}</label>
                  <NumField label={t('{name}の大きさ', { name })} value={e.scale} min={0.01} step={0.1} digits={2} onCommit={scale => update(i, { scale })} />
                </>}
                {problem && <div className="note addon-error" style={{ gridColumn: '1 / -1' }}>{t(problem)}</div>}
                <label title={t('効くクローンの番号。空なら全部')}>{t('MoGraph 選択')}</label>
                <TextInput label={t('{name}の MoGraph 選択', { name })} value={e.select} hint={t('全部 (例: 0-4, 7・偶数・奇数)')} onCommit={select => update(i, { select })} />
              </div>
            )}
            {def && <FieldList c4d={c4d} prefix={name} list={e.fields} onChange={fields => update(i, { fields })} />}
          </div>
        );
      })}
      {defs.length ? (
        <div className="row effector-add">
          {defs.map(d => <button key={d.key} type="button" className="bbtn" title={d.description && t(d.description)} onClick={() => onChange([...list, newEffector(d)])}>+ {t(d.name)}</button>)}
        </div>
      ) : <div className="note">{t('エフェクタの種類がありません。アドオンマネージャーで「MoGraph エフェクタ」を有効にすると足せます')}</div>}
      {[...notes].map(n => <div key={n} className="note">{n}</div>)}
    </div>
  );
}

// エフェクタのフィールド (Cinema 4D のフィールド): 効く範囲を、層を重ねて決める
function FieldList({ c4d, prefix, list, onChange }: { c4d: Cinema4d; prefix: string; list: FieldLayer[]; onChange: (l: FieldLayer[]) => void }) {
  const defs = c4d.fields.list();
  if (!defs.length && !list.length) return null;
  const update = (i: number, patch: Partial<FieldLayer>) => onChange(list.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  return (
    <details className="sub fields" open={list.length > 0}>
      <summary>{list.length ? t('フィールド ({n})', { n: list.length }) : t('フィールド (全体に効く)')}</summary>
      {list.map((l, i) => {
        const def = defs.find(d => d.key === l.kind);
        const name = def ? t(def.name) : l.kind;
        const label = t('{prefix}のフィールド {n} {name}', { prefix, n: i + 1, name });
        return (
          <div key={i} className="field-layer" role="group" aria-label={label}>
            <div className="effector-title">
              <BCheck checked={l.enabled} onChange={enabled => update(i, { enabled })}>{name}</BCheck>
              <button type="button" className="hbtn" aria-label={t('{name}を外す', { name: label })} title={t('外す')} onClick={() => onChange(list.filter((_, k) => k !== i))}>×</button>
            </div>
            {!def ? <div className="note">{t('この種類のフィールドは登録されていないので、働きません (MoGraph フィールドのアドオンを有効にしてください)')}</div> : (
              <div className="prop cloner">
                <label>{t('重ね方')}</label>
                <BSelect<FieldLayer['blend']> label={t('{name}の重ね方', { name: label })} value={l.blend} onChange={blend => update(i, { blend })} options={FIELD_BLENDS.map(b => ({ value: b.value, label: t(b.label) }))} />
                <label>{t('不透明度')}</label>
                <NumField label={t('{name}の不透明度', { name: label })} value={l.opacity} min={0} max={1} step={0.05} digits={2} onCommit={opacity => update(i, { opacity })} />
                <label>{t('反転')}</label>
                <BCheck checked={l.invert} label={t('{name}を反転', { name: label })} onChange={invert => update(i, { invert })} />
                <Params prefix={label} defs={def.params} values={l.params} onChange={params => update(i, { params })} />
              </div>
            )}
          </div>
        );
      })}
      {defs.length > 0 && (
        <div className="row effector-add">
          {defs.map(d => <button key={d.key} type="button" className="bbtn" title={d.description && t(d.description)} aria-label={t('{prefix}に{name}のフィールドを足す', { prefix, name: t(d.name) })}
                                 onClick={() => onChange([...list, newFieldLayer(d)])}>+ {t(d.name)}</button>)}
        </div>
      )}
    </details>
  );
}
