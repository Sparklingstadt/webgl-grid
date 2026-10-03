import { useRef, useState } from 'react';
import { errorText } from '../../../core/errors';
import { msg, t } from '../../../core/i18n';
import type { AddonInfo } from '../../../engine/addons/Addons';
import type { MenuId } from '../../../engine/addons/registry';
import { useEngine, useUi } from '../../EngineContext';
import { BCheck } from '../controls/BCheck';
import { BSelect } from '../controls/BSelect';
import { Modal } from '../Dialogs';

type Show = 'all' | 'enabled' | 'disabled' | 'builtin' | 'installed' | 'error';
const SHOWS: { value: Show; label: string }[] = [
  { value: 'all', label: msg('すべて') }, { value: 'enabled', label: msg('有効') }, { value: 'disabled', label: msg('切ってある') },
  { value: 'builtin', label: msg('組み込み') }, { value: 'installed', label: msg('インストールしたもの') }, { value: 'error', label: msg('エラーのあるもの') },
];
const MENU_NAMES: Record<MenuId, string> = { file: msg('ファイル'), edit: msg('編集'), render: msg('レンダー'), view: msg('ビュー'), select: msg('選択'), add: msg('追加'), object: msg('オブジェクト') };
const TAB_NAMES: Record<string, string> = { object: msg('オブジェクト'), modifier: msg('モディファイアー'), physics: msg('物理演算'), light: msg('ライト'), material: msg('マテリアル'), morph: msg('表情'), bone: msg('ボーン'), scene: msg('シーン'), fx: msg('効果'), output: msg('出力') };

// (訳した名前・説明でも探せる)
const matches = (a: AddonInfo, show: Show, category: string, q: string) =>
  (show === 'all' || (show === 'enabled' && a.enabled) || (show === 'disabled' && !a.enabled) || (show === 'builtin' && a.source === 'builtin')
    || (show === 'installed' && a.source === 'installed') || (show === 'error' && !!a.error))
  && (!category || a.category === category)
  && (!q || [a.name, a.id, a.description, a.category, a.author, t(a.name), t(a.description), t(a.category)].some(s => s.toLowerCase().includes(q.toLowerCase())));

// --- アドオンマネージャー (Blender のプリファレンス > アドオン): 探す・絞り込む・有効にする・足しているものを見る・インストール・消す ---
export function AddonManager({ onClose }: { onClose: () => void }) {
  const engine = useEngine();
  const addons = useUi(s => s.addons);
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [show, setShow] = useState<Show>('all');
  const [category, setCategory] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const categories = [...new Set(addons.map(a => a.category).filter(Boolean))].sort();
  const shown = addons.filter(a => matches(a, show, category, q));
  const install = async (f: File) => {
    setBusy(true);
    try {
      const id = await engine.addons.install(await f.text());
      engine.ui.toast(t('アドオン {id} をインストールしました', { id }));
      setOpen(id);
    } catch (err) {
      console.error(err);
      engine.ui.toast(t('{file} をインストールできませんでした: {error}', { file: f.name, error: errorText(err) }), 8000);
    } finally { setBusy(false); }
  };
  const toggle = (a: AddonInfo, on: boolean) => { if (on) void engine.addons.enable(a.id); else engine.addons.disable(a.id); };
  return (
    <Modal label={t('アドオンマネージャー')} title={<>{t('アドオンマネージャー')} <span className="note">{t('{total} 個のうち {on} 個が有効', { total: addons.length, on: addons.filter(a => a.enabled).length })}</span></>}
           className={`addon-manager${dropping ? ' dropping' : ''}`} onBackdrop={onClose}>
      <div className="addon-body"
           onDragOver={e => { e.preventDefault(); setDropping(true); }} onDragLeave={e => { if (e.currentTarget === e.target) setDropping(false); }}
           onDrop={e => { e.preventDefault(); setDropping(false); const f = e.dataTransfer.files[0]; if (f) void install(f); }}>
        <div className="addon-filter">
          <input className="text-field" type="search" placeholder={t('名前・説明で探す')} aria-label={t('アドオンを探す')} value={q} onChange={e => setQ(e.currentTarget.value)} />
          <BSelect<Show> label={t('表示するアドオン')} value={show} onChange={setShow} options={SHOWS.map(s => ({ ...s, label: t(s.label) }))} />
          <BSelect<string> label={t('カテゴリ')} value={category} onChange={setCategory}
                           options={[{ value: '', label: t('すべてのカテゴリ') }, ...categories.map(c => ({ value: c, label: t(c) }))]} />
        </div>
        <ul className="addon-list" aria-label={t('アドオンの一覧')}>
          {shown.map(a => {
            const expanded = open === a.id;
            const c = a.contributes;
            const name = t(a.name);
            const parts = [
              ...c.menus.map(m => t('メニュー: {menu} > {label}', { menu: t(MENU_NAMES[m.menu]), label: t(m.label) })),
              ...c.panels.map(p => t('パネル: {tab} > {title}', { tab: t(TAB_NAMES[p.tab] ?? p.tab), title: t(p.title) })),
              ...c.commands.map(n => t('MCP の命令: {name}', { name: n })),
              ...c.objectData.map(n => t('物ごとの値: {name}', { name: t(n) })),
              ...c.sceneData.map(n => t('場面の値: {name}', { name: t(n) })),
            ];
            const info = [`id: ${a.id}`, a.author && t('作者: {author}', { author: a.author }), a.enabledByDefault && t('最初から有効')].filter(Boolean).join(' ・ ');
            return (
              <li key={a.id} className={a.enabled ? 'on' : ''}>
                <div className="addon-head">
                  <button type="button" className="hbtn addon-expand" aria-expanded={expanded} aria-label={t('{name} の詳しいこと', { name })}
                          onClick={() => setOpen(expanded ? null : a.id)}>{expanded ? '▾' : '▸'}</button>
                  <BCheck checked={a.enabled} label={t('{name} を有効にする', { name })} onChange={on => toggle(a, on)}>
                    <b>{a.category ? t('{category}: {name}', { category: t(a.category), name }) : name}</b>
                  </BCheck>
                  <span className="note">{a.version && `v${a.version}`} {a.source === 'installed' ? t('インストール') : t('組み込み')}</span>
                </div>
                {a.error && <div className="note addon-error">{t('有効にできませんでした: {error}', { error: a.error })}</div>}
                {expanded && (
                  <div className="addon-detail">
                    {a.description && <div>{t(a.description)}</div>}
                    <div className="note">{info}</div>
                  {a.requires.length > 0 && <div className="note">{t('必要なアドオン: {names} (一緒に有効にし、切ると一緒に切れます)', { names: a.requires.map(r => { const d = addons.find(x => x.id === r); return d ? t(d.name) : r; }).join('・') })}</div>}
                    {a.enabled
                      ? (parts.length ? <ul className="addon-parts" aria-label={t('{name} が足しているもの', { name })}>{parts.map(p => <li key={p}>{p}</li>)}</ul>
                        : <div className="note">{t('足しているものはありません')}</div>)
                      : <div className="note">{t('有効にすると、メニュー・パネルなどを足します')}</div>}
                    {a.source === 'installed' && (
                      <div className="row">
                        <button type="button" className="bbtn" onClick={() => engine.addons.exportCode(a.id)}>{t('コードを保存 ({file})', { file: `${a.id}.js` })}</button>
                        <button type="button" className="bbtn" onClick={() => { engine.addons.uninstall(a.id); engine.ui.toast(t('アドオン {name} を消しました', { name })); }}>{t('消す')}</button>
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
          {!shown.length && <li className="note">{t('当てはまるアドオンはありません')}</li>}
        </ul>
        <div className="note">{t('アドオンは、アプリに機能を足す JavaScript です。アプリのすべてを操作できるので、信頼できるものだけをインストールしてください。.js をこの窓に落としてもインストールできます (同じ id のものは入れ替えます)。')}</div>
        <div className="row">
          <button type="button" className="bbtn" disabled={busy} onClick={() => file.current?.click()}>{t('ファイルからインストール… (.js)')}</button>
          <button type="button" className="bbtn" onClick={onClose}>{t('閉じる (Esc)')}</button>
        </div>
      </div>
      <input type="file" ref={file} hidden accept=".js,.mjs,text/javascript" aria-label={t('アドオンのファイル')}
             onChange={e => {
               const f = e.currentTarget.files?.[0];
               e.currentTarget.value = '';
               if (f) void install(f);
             }} />
    </Modal>
  );
}
