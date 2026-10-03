import { useRef, useState } from 'react';
import { errorText } from '../../../core/errors';
import type { AddonInfo } from '../../../engine/addons/Addons';
import type { MenuId } from '../../../engine/addons/registry';
import { useEngine, useUi } from '../../EngineContext';
import { BCheck } from '../controls/BCheck';
import { BSelect } from '../controls/BSelect';
import { Modal } from '../Dialogs';

type Show = 'all' | 'enabled' | 'disabled' | 'builtin' | 'installed' | 'error';
const SHOWS: { value: Show; label: string }[] = [
  { value: 'all', label: 'すべて' }, { value: 'enabled', label: '有効' }, { value: 'disabled', label: '切ってある' },
  { value: 'builtin', label: '組み込み' }, { value: 'installed', label: 'インストールしたもの' }, { value: 'error', label: 'エラーのあるもの' },
];
const MENU_NAMES: Record<MenuId, string> = { file: 'ファイル', edit: '編集', render: 'レンダー', view: 'ビュー', add: '追加', object: 'オブジェクト' };
const TAB_NAMES: Record<string, string> = { object: 'オブジェクト', material: 'マテリアル', morph: '表情', bone: 'ボーン', scene: 'シーン', fx: '効果', output: '出力' };

const matches = (a: AddonInfo, show: Show, category: string, q: string) =>
  (show === 'all' || (show === 'enabled' && a.enabled) || (show === 'disabled' && !a.enabled) || (show === 'builtin' && a.source === 'builtin')
    || (show === 'installed' && a.source === 'installed') || (show === 'error' && !!a.error))
  && (!category || a.category === category)
  && (!q || [a.name, a.id, a.description, a.category, a.author].some(t => t.toLowerCase().includes(q.toLowerCase())));

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
      engine.ui.toast(`アドオン ${id} をインストールしました`);
      setOpen(id);
    } catch (err) {
      console.error(err);
      engine.ui.toast(`${f.name} をインストールできませんでした: ${errorText(err)}`, 8000);
    } finally { setBusy(false); }
  };
  const toggle = (a: AddonInfo, on: boolean) => { if (on) void engine.addons.enable(a.id); else engine.addons.disable(a.id); };
  return (
    <Modal label="アドオンマネージャー" title={<>アドオンマネージャー <span className="note">{addons.length} 個のうち {addons.filter(a => a.enabled).length} 個が有効</span></>}
           className={`addon-manager${dropping ? ' dropping' : ''}`} onBackdrop={onClose}>
      <div className="addon-body"
           onDragOver={e => { e.preventDefault(); setDropping(true); }} onDragLeave={e => { if (e.currentTarget === e.target) setDropping(false); }}
           onDrop={e => { e.preventDefault(); setDropping(false); const f = e.dataTransfer.files[0]; if (f) void install(f); }}>
        <div className="addon-filter">
          <input className="text-field" type="search" placeholder="名前・説明で探す" aria-label="アドオンを探す" value={q} onChange={e => setQ(e.currentTarget.value)} />
          <BSelect<Show> label="表示するアドオン" value={show} onChange={setShow} options={SHOWS} />
          <BSelect<string> label="カテゴリ" value={category} onChange={setCategory}
                           options={[{ value: '', label: 'すべてのカテゴリ' }, ...categories.map(c => ({ value: c, label: c }))]} />
        </div>
        <ul className="addon-list" aria-label="アドオンの一覧">
          {shown.map(a => {
            const expanded = open === a.id;
            const c = a.contributes;
            const parts = [
              ...c.menus.map(m => `メニュー: ${MENU_NAMES[m.menu]} > ${m.label}`),
              ...c.panels.map(p => `パネル: ${TAB_NAMES[p.tab] ?? p.tab} > ${p.title}`),
              ...c.commands.map(n => `MCP の命令: ${n}`),
              ...c.objectData.map(n => `物ごとの値: ${n}`),
              ...c.sceneData.map(n => `場面の値: ${n}`),
            ];
            return (
              <li key={a.id} className={a.enabled ? 'on' : ''}>
                <div className="addon-head">
                  <button type="button" className="hbtn addon-expand" aria-expanded={expanded} aria-label={`${a.name} の詳しいこと`}
                          onClick={() => setOpen(expanded ? null : a.id)}>{expanded ? '▾' : '▸'}</button>
                  <BCheck checked={a.enabled} label={`${a.name} を有効にする`} onChange={on => toggle(a, on)}>
                    <b>{a.category ? `${a.category}: ` : ''}{a.name}</b>
                  </BCheck>
                  <span className="note">{a.version && `v${a.version}`} {a.source === 'installed' ? 'インストール' : '組み込み'}</span>
                </div>
                {a.error && <div className="note addon-error">有効にできませんでした: {a.error}</div>}
                {expanded && (
                  <div className="addon-detail">
                    {a.description && <div>{a.description}</div>}
                    <div className="note">id: {a.id}{a.author && ` ・ 作者: ${a.author}`}{a.enabledByDefault && ' ・ 最初から有効'}</div>
                  {a.requires.length > 0 && <div className="note">必要なアドオン: {a.requires.map(r => addons.find(x => x.id === r)?.name ?? r).join('・')} (一緒に有効にし、切ると一緒に切れます)</div>}
                    {a.enabled
                      ? (parts.length ? <ul className="addon-parts" aria-label={`${a.name} が足しているもの`}>{parts.map(p => <li key={p}>{p}</li>)}</ul>
                        : <div className="note">足しているものはありません</div>)
                      : <div className="note">有効にすると、メニュー・パネルなどを足します</div>}
                    {a.source === 'installed' && (
                      <div className="row">
                        <button type="button" className="bbtn" onClick={() => engine.addons.exportCode(a.id)}>コードを保存 ({a.id}.js)</button>
                        <button type="button" className="bbtn" onClick={() => { engine.addons.uninstall(a.id); engine.ui.toast(`アドオン ${a.name} を消しました`); }}>消す</button>
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
          {!shown.length && <li className="note">当てはまるアドオンはありません</li>}
        </ul>
        <div className="note">アドオンは、アプリに機能を足す JavaScript です。アプリのすべてを操作できるので、信頼できるものだけをインストールしてください。.js をこの窓に落としてもインストールできます (同じ id のものは入れ替えます)。</div>
        <div className="row">
          <button type="button" className="bbtn" disabled={busy} onClick={() => file.current?.click()}>ファイルからインストール… (.js)</button>
          <button type="button" className="bbtn" onClick={onClose}>閉じる (Esc)</button>
        </div>
      </div>
      <input type="file" ref={file} hidden accept=".js,.mjs,text/javascript" aria-label="アドオンのファイル"
             onChange={e => {
               const f = e.currentTarget.files?.[0];
               e.currentTarget.value = '';
               if (f) void install(f);
             }} />
    </Modal>
  );
}
