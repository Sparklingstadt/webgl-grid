import { LANGS, msg, setLang, t, type Lang } from '../../core/i18n';
import { REMOTE_DEFAULT_PORT } from '../../core/remote';
import { BSelect } from './controls/BSelect';
import { useEngine, useUi } from '../EngineContext';
import { AddonMenuItems } from './addons/AddonMenuItems';
import { Menu, MenuItem, MenuLabel, MenuSep } from './Menu';

// ワークスペース (Blender の上のバーのタブ): 下の領域とプロパティのタブを、作業に合わせてまとめて切り替える
export type Workspace = 'layout' | 'shading' | 'animation';
const WORKSPACES: [Workspace, string][] = [['layout', msg('レイアウト')], ['shading', msg('シェーディング')], ['animation', msg('アニメーション')]];

// 上のバー: ファイル・編集・レンダー・ヘルプのメニューと、ワークスペースのタブ
export function TopBar({ onOpenFiles, onOpenFolder, onLoadPose, onOpenProject, onOpenOutput, onOpenAddons, workspace, setWorkspace }: {
  onOpenFiles: () => void; onOpenFolder: () => void; onLoadPose: () => void; onOpenProject: () => void; onOpenOutput: () => void; onOpenAddons: () => void;
  workspace: Workspace; setWorkspace: (w: Workspace) => void;
}) {
  const engine = useEngine();
  const projectName = useUi(s => s.projectName);
  const remote = useUi(s => s.remote);
  const history = useUi(s => s.history);
  const recovery = useUi(s => s.recovery);
  const lang = useUi(s => s.lang);
  return (
    <header className="topbar">
      <svg className="brand" viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="11" cy="11" r="6" fill="none" stroke="#e87d0d" strokeWidth="2.4" />
        <circle cx="11" cy="11" r="2.2" fill="#2a5fa8" />
        <path d="M2 7 9 7" stroke="#e87d0d" strokeWidth="2.4" strokeLinecap="round" />
      </svg>
      <Menu id="file" label={t('ファイル')}>
        <MenuItem label={t('プロジェクトを開く… (.wgp / .wgpj)')} kbd="Ctrl Shift O" onSelect={onOpenProject} />
        <MenuItem label={t('プロジェクトを保存 (.wgp)')} kbd="Ctrl S" onSelect={() => engine.project.saveFile()} />
        <MenuItem label={t('ファイルは参照だけで保存 (.wgpj)')} kbd="Ctrl Alt S" onSelect={() => engine.project.saveFile('reference')} />
        <MenuItem label={t('前回の続きを開く (自動保存)')} disabled={!recovery} onSelect={() => void engine.autosave.recover()} />
        <div className="note" style={{ padding: '0 8px 4px' }}>{t('.wgpj はモデル・モーション・曲を入れない小さなファイル。開くときに元のファイルを選びます')}</div>
        <MenuSep />
        <MenuItem label={t('MMD を読み込む…')} kbd="Ctrl O" onSelect={onOpenFiles} />
        <MenuItem label={t('MMD をフォルダごと読み込む…')} onSelect={onOpenFolder} />
        <MenuItem label={t('models フォルダから読み込む…')} onSelect={() => engine.ui.set({ modelPicker: true })} />
        <div className="note" style={{ padding: '0 8px 4px' }}>{t('.pmx とテクスチャ・.vmd・.vpd・曲')}</div>
        <MenuSep />
        <MenuItem label={t('ポーズを保存 (.vpd)')} onSelect={() => engine.savePose()} />
        <MenuItem label={t('ポーズを読み込む (.vpd)…')} onSelect={onLoadPose} />
        <MenuSep />
        <MenuItem label={remote === 'off' ? t('外部から操作 (MCP) を受け付ける') : t('外部から操作 (MCP) をやめる')}
                  onSelect={() => (remote === 'off' ? engine.remote.connect(REMOTE_DEFAULT_PORT) : engine.remote.disconnect())} />
        <MenuSep />
        <MenuItem label={t('最初の状態に戻す')} onSelect={() => engine.resetAll()} />
        <AddonMenuItems menu="file" />
      </Menu>
      <Menu id="edit" label={t('編集')}>
        <MenuItem label={history.index > 0 ? t('元に戻す: {label}', { label: t(history.labels[history.index]) }) : t('元に戻す')} kbd="Ctrl Z"
                  disabled={history.index <= 0} onSelect={() => void engine.history.undo()} />
        <MenuItem label={history.index < history.labels.length - 1 ? t('やり直す: {label}', { label: t(history.labels[history.index + 1]) }) : t('やり直す')} kbd="Ctrl Shift Z"
                  disabled={history.index >= history.labels.length - 1} onSelect={() => void engine.history.redo()} />
        <MenuSep />
        <MenuItem label={t('アドオンマネージャー…')} kbd="Ctrl ," onSelect={onOpenAddons} />
        <AddonMenuItems menu="edit" />
        <MenuSep />
        <MenuLabel>{t('履歴')}</MenuLabel>
        {history.labels.map((label, i) => ({ label, i })).slice(-12).reverse().map(({ label, i }) => (
          <MenuItem key={i} label={`${i === history.index ? '● ' : '　'}${t(label)}`} onSelect={() => void engine.history.jump(i)} />
        ))}
      </Menu>
      <Menu id="render" label={t('レンダー')}>
        <MenuItem label={t('画像をレンダリング')} kbd="F12" onSelect={() => engine.output.renderImage()} />
        <MenuItem label={t('アニメーションをレンダリング')} kbd="Ctrl F12" onSelect={() => engine.output.renderAnimation()} />
        <MenuSep />
        <MenuItem label={t('出力の設定…')} onSelect={onOpenOutput} />
        <AddonMenuItems menu="render" />
      </Menu>
      <Menu id="help" label={t('ヘルプ')}>
        <MenuLabel>{t('ショートカット')}</MenuLabel>
        {[
          [msg('再生 / 停止'), 'Space'], [msg('キーフレームを挿入'), 'I'], [msg('いまのキーフレームを削除'), 'Alt I'],
          [msg('前 / 次のキーフレーム'), '↓ ↑'], [msg('前 / 次のフレーム'), '← →'], [msg('最初 / 最後のフレーム'), 'Shift ← →'],
          [msg('選んだ物 (タイムライン上ではキー) を削除'), 'X'], [msg('選択を解除'), 'Alt A'], [msg('複製'), 'Shift D'], [msg('移動 / 回転 / 拡大縮小 (Alt で元に戻す)'), 'G / R / S'], [msg('名前を変更'), 'F2'], [msg('隠す / ほかを隠す / すべて表示'), 'H / Shift H / Alt H'], [msg('追加メニュー'), 'Shift A'], [msg('元に戻す / やり直す'), 'Ctrl Z / Ctrl Shift Z'], [msg('画像 / アニメーションをレンダリング'), 'F12 / Ctrl F12'], [msg('アドオンマネージャー'), 'Ctrl ,'],
          [msg('前・右・上から見る'), msg('テンキー 1 3 7')], [msg('場面のカメラから見る'), msg('テンキー 0')], [msg('視点を戻す (タイムライン上では全体を表示)'), 'Home'], [msg('ツールバー'), 'T'], [msg('エリアを最大化 / 元に戻す'), 'Ctrl Space'], [msg('サイドバー'), 'N'],
          [msg('シェーダーエディター: ノードを追加 / 消す / 全体を表示'), 'Shift A / X / Home'],
        ].map(([label, kbd]) => <MenuItem key={label} label={t(label)} kbd={t(kbd)} disabled />)}
      </Menu>
      <nav className="workspaces" role="tablist" aria-label={t('ワークスペース')}>
        {WORKSPACES.map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={workspace === key} onClick={() => setWorkspace(key)}>{t(label)}</button>
        ))}
      </nav>
      {remote !== 'off' && (
        <span className={`remote-chip ${remote}`} aria-label={t('MCP の接続')}
              title={remote === 'connected' ? t('MCP サーバーにつながっています。外から操作できます') : t('MCP サーバーを待っています (npm run mcp)')}>
          {remote === 'connected' ? t('MCP 接続中') : t('MCP 待機中')}
        </span>
      )}
      <BSelect<Lang> label="言語 (Language)" className="lang-select" value={lang} onChange={setLang}
                     options={LANGS.map(l => ({ value: l.key, label: l.name }))} />
      <span className="title">{projectName ? `${projectName} — webgl-grid` : 'webgl-grid'}</span>
    </header>
  );
}
