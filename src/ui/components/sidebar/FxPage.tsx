import { useRef } from 'react';
import { msg, t } from '../../../core/i18n';
import type { FxKey, FxLevel } from '../../../engine';
import type { MmeEffectUi } from '../../../engine/UiChannel';
import { useEngine, useUi } from '../../EngineContext';
import { BSlider } from '../BSlider';
import { BCheck } from '../controls/BCheck';
import { MmeAssignTabs } from '../MmeAssignTabs';
import { MmeControllers } from '../MmeControllers';
import { MmeEffectPicker } from '../MmeEffectPicker';
import { Panel } from './Panel';

// --- 効果 (MME 風) ---
const FX_ROWS: { key: FxKey; title: string; sliders: { k: keyof FxLevel; label: string; min: number; max: number; step: number }[] }[] = [
  { key: 'bloom', title: msg('光る'), sliders: [{ k: 'bloom', label: msg('強さ'), min: 0, max: 2, step: 0.05 }] },
  { key: 'diffusion', title: msg('ふんわり'), sliders: [{ k: 'diffusion', label: msg('強さ'), min: 0, max: 1, step: 0.02 }] },
  { key: 'dof', title: msg('被写界深度'), sliders: [{ k: 'dof', label: msg('ぼけの大きさ'), min: 0, max: 3, step: 0.05 }] },
  { key: 'ao', title: msg('影の濃さ'), sliders: [{ k: 'ao', label: msg('濃さ'), min: 0, max: 2, step: 0.05 }] },
  { key: 'color', title: msg('色調'), sliders: [
    { k: 'temp', label: msg('色温度'), min: -1, max: 1, step: 0.02 },
    { k: 'sat', label: msg('彩度'), min: 0, max: 2, step: 0.02 },
    { k: 'bright', label: msg('明度'), min: 0, max: 2, step: 0.02 },
  ] },
];
// コンパイルの結果。エラーや警告があれば、開くと全部の一覧
function FxResult({ fx }: { fx: MmeEffectUi }) {
  const status = fx.ok ? t('コンパイルできました') : t('コンパイルできませんでした');
  if (!fx.errors.length && !fx.warnings.length) return <div className="note">{status}</div>;
  const counts = fx.errorCount ? t('エラー {errors}・警告 {warnings}', { errors: fx.errorCount, warnings: fx.warnings.length }) : t('警告 {warnings}', { warnings: fx.warnings.length });
  return (
    <details className="mme-diag">
      <summary className={fx.ok ? 'note' : 'note mme-error'}>{status} ({counts})</summary>
      <ul aria-label={t('{name} のエラーと警告', { name: fx.name })}>
        {fx.errors.map((e, i) => <li key={`e${i}`} className="mme-error">{e.code} {e.where} {e.message}</li>)}
        {fx.warnings.map((w, i) => <li key={`w${i}`}>{w}</li>)}
      </ul>
    </details>
  );
}

// MMD (MME) のエフェクト割当ファイル (.emm) を読む・書き出す
function EmmButtons() {
  const engine = useEngine();
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="row">
      <button type="button" className="bbtn" title={t('MMD のエフェクト割当ファイルを読んで、名前の合う物に割り当てを戻します')} onClick={() => input.current?.click()}>{t('.emm を読む…')}</button>
      <button type="button" className="bbtn" title={t('いまの割り当てを MMD のエフェクト割当ファイルにします')} onClick={() => engine.mme.downloadEmm()}>{t('.emm を書き出す')}</button>
      <input type="file" ref={input} accept=".emm" hidden aria-label={t('.emm を選ぶ')}
             onChange={e => {
               const f = e.currentTarget.files?.[0];
               e.currentTarget.value = '';
               if (f) void engine.mme.openEmm(f);
             }} />
    </div>
  );
}

// MME 互換 (レンダーエンジンが MME 互換のときだけ): 選んでいる物の .fx・ポストエフェクトの一覧・エフェクト割当・仮のコントローラー。
// ポストエフェクトはアクセサリの物に当てた .fx: 上下はアクセサリの並び (アウトライナーと同じ)、オン・オフはアクセサリを隠す
// (ビューポートでも書き出しでも。オンは両方見せる)、外すはアクセサリを消す
function MmePanel({ onShowValues }: { onShowValues?: () => void }) {
  const engine = useEngine();
  const selected = useUi(s => s.sel !== null); // (動かしているあいだの位置の変化では描き直さない)
  const mme = useUi(s => s.mme);
  const posts = mme.posts;
  const objOf = (i: number) => engine.world.find(posts[i]?.objId ?? null);
  // i 番目のポストエフェクトのアクセサリを、隣 (d = -1 は上、1 は下) のポストエフェクトのアクセサリの前 (後) へ
  const move = (i: number, d: -1 | 1) => {
    const obj = objOf(i), next = objOf(i + d);
    if (obj && next) engine.moveObject(obj, next, d < 0 ? 'before' : 'after');
  };
  const setEnabled = (i: number, on: boolean) => {
    const obj = objOf(i);
    if (obj) engine.setVisibility(obj, { hidden: !on, hideRender: !on });
  };
  const remove = (i: number) => {
    const obj = objOf(i);
    if (obj) engine.world.remove(obj);
  };
  return (
    <Panel title={t('MME 互換')}>
      <div className="mme-head">{t('選んでいる物の .fx')}</div>
      {selected ? (
        <MmeEffectPicker label={t('読み込む…')} inputLabel={t('物の .fx のフォルダを選ぶ')} onPick={(files, entry) => void engine.mme.loadObjectEffect(files, entry)}
                         buttons={<button type="button" className="bbtn" disabled={!mme.object} onClick={() => engine.mme.removeObjectEffect()}>{t('外す')}</button>}>
          <div className="mme-name" title={mme.object?.name}>{mme.object ? mme.object.name : t('なし (default.fx で描きます)')}</div>
          {mme.object && <FxResult fx={mme.object} />}
        </MmeEffectPicker>
      ) : <div className="note">{t('物を選ぶと、その物に .fx を読み込めます')}</div>}
      <div className="mme-head">{t('ポストエフェクト')}</div>
      <MmeEffectPicker label={t('足す…')} inputLabel={t('ポストエフェクトのフォルダを選ぶ')} onPick={(files, entry) => void engine.mme.addPostEffect(files, entry)}>
        {posts.length ? (
          <ul className="mme-posts" aria-label={t('ポストエフェクトの一覧')}>
            {posts.map((p, i) => (
              <li key={p.objId}>
                <div className="mme-post-row">
                  <BCheck checked={p.enabled} label={t('{name} を使う', { name: p.name })} onChange={on => setEnabled(i, on)} />
                  <span className="mme-name" title={t('{accessory} に当てた {name}', { accessory: p.accessory, name: p.name })}>{p.name}</span>
                  <button type="button" className="bbtn" aria-label={t('{name} を上へ', { name: p.name })} title={t('上へ')} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                  <button type="button" className="bbtn" aria-label={t('{name} を下へ', { name: p.name })} title={t('下へ')} disabled={i === posts.length - 1} onClick={() => move(i, 1)}>↓</button>
                  <button type="button" className="bbtn" aria-label={t('{name} を外す', { name: p.name })} title={t('外す (アクセサリ {accessory} を消す)', { accessory: p.accessory })} onClick={() => remove(i)}>✕</button>
                </div>
                <FxResult fx={p} />
              </li>
            ))}
          </ul>
        ) : <div className="note">{t('ポストエフェクトはありません')}</div>}
        {posts.length > 1 && <div className="note">{t('上のものほど先に (場面の近くで) かかります')}</div>}
      </MmeEffectPicker>
      <MmeAssignTabs />
      <EmmButtons />
      <MmeControllers onShowValues={onShowValues} />
      {mme.warnings.length > 0 && (
        <details className="mme-diag">
          <summary className="note">{t('描くときの警告 {n}', { n: mme.warnings.length })}</summary>
          <ul aria-label={t('描くときの警告')}>{mme.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </details>
      )}
      <div className="note">{t('.fx が入っているフォルダを選ぶか、ここに落とします。割り当てはプロジェクトに保存されます')}</div>
    </Panel>
  );
}

// onShowValues: 仮のコントローラーの物を選んだら、その値 (サイドバーの「MME」のページ) を見せる
export function FxPage({ onShowValues }: { onShowValues?: () => void }) {
  const engine = useEngine();
  const state = useUi(s => s.fxState);
  const level = useUi(s => s.fxLevel);
  const mme = useUi(s => s.mme.settings.engine === 'mme');
  return (
    <>
      {mme && <MmePanel onShowValues={onShowValues} />}
      {mme && <div className="note" style={{ padding: '2px 2px 0' }}>{t('MME 互換で描いているあいだは、下の効果はかかりません')}</div>}
      <div className="note" style={{ padding: '2px 2px 6px' }}>{t('MME 風の効果。オフの効果のスライダーを動かすとオンになります。設定はブラウザに保存されます')}</div>
      {FX_ROWS.map(row => (
        <Panel key={row.key} title={t(row.title)}
               head={<BCheck checked={state[row.key]} label={t('{name}を使う', { name: t(row.title) })} onChange={on => engine.effects.set(row.key, on)} />}>
          {row.sliders.map(s => (
            <BSlider key={s.k} label={t(s.label)} value={level[s.k]} min={s.min} max={s.max} step={s.step} off={!state[row.key]}
                     onChange={v => engine.effects.setLevel(s.k, v)} />
          ))}
        </Panel>
      ))}
    </>
  );
}
