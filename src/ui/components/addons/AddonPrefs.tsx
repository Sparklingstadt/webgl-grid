import { useRef, useState } from 'react';
import { errorText } from '../../../core/errors';
import { useEngine, useUi } from '../../EngineContext';
import { BCheck } from '../controls/BCheck';
import { Modal } from '../Dialogs';

// --- プリファレンス > アドオン (Blender と同じ): 一覧・有効にする・ファイルからインストール・消す ---
export function AddonPrefs({ onClose }: { onClose: () => void }) {
  const engine = useEngine();
  const addons = useUi(s => s.addons);
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const install = async (f: File) => {
    setBusy(true);
    try {
      const id = await engine.addons.install(await f.text());
      engine.ui.toast(`アドオン ${id} をインストールしました`);
    } catch (err) {
      console.error(err);
      engine.ui.toast(`${f.name} をインストールできませんでした: ${errorText(err)}`, 8000);
    } finally { setBusy(false); }
  };
  return (
    <Modal label="プリファレンス" title="プリファレンス — アドオン" className="addon-prefs" onBackdrop={onClose}>
      <div className="note">アドオンは、アプリに機能 (メニュー・サイドバーのパネル・MCP の命令など) を足す JavaScript です。アプリのすべてを操作できるので、信頼できるものだけをインストールしてください。</div>
      <ul className="addon-list" aria-label="アドオンの一覧">
        {addons.map(a => (
          <li key={a.id}>
            <div className="addon-head">
              <BCheck checked={a.enabled} label={`${a.name} を有効にする`}
                      onChange={on => { if (on) void engine.addons.enable(a.id); else engine.addons.disable(a.id); }}>
                <b>{a.category ? `${a.category}: ` : ''}{a.name}</b>
              </BCheck>
              <span className="note">{a.version && `v${a.version}`}{a.source === 'installed' ? ' (インストール)' : ''}</span>
            </div>
            {a.description && <div className="note">{a.description}</div>}
            <div className="note">id: {a.id}{a.author && ` ・ 作者: ${a.author}`}</div>
            {a.error && <div className="note addon-error">有効にできませんでした: {a.error}</div>}
            {a.source === 'installed' && (
              <button type="button" className="bbtn" onClick={() => { engine.addons.uninstall(a.id); engine.ui.toast(`アドオン ${a.name} を消しました`); }}>消す</button>
            )}
          </li>
        ))}
      </ul>
      <div className="row">
        <button type="button" className="bbtn" disabled={busy} onClick={() => file.current?.click()}>ファイルからインストール… (.js)</button>
        <button type="button" className="bbtn" onClick={onClose}>閉じる (Esc)</button>
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
