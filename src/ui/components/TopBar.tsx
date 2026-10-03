import { REMOTE_DEFAULT_PORT } from '../../core/remote';
import { useEngine, useUi } from '../EngineContext';
import { AddonMenuItems } from './addons/AddonMenuItems';
import { Menu, MenuItem, MenuLabel, MenuSep } from './Menu';

// 上のバー: ファイル・レンダー・ヘルプのメニュー
export function TopBar({ onOpenFiles, onLoadPose, onOpenProject, onOpenOutput, onOpenPrefs }: {
  onOpenFiles: () => void; onLoadPose: () => void; onOpenProject: () => void; onOpenOutput: () => void; onOpenPrefs: () => void;
}) {
  const engine = useEngine();
  const projectName = useUi(s => s.projectName);
  const remote = useUi(s => s.remote);
  const history = useUi(s => s.history);
  const recovery = useUi(s => s.recovery);
  return (
    <header className="topbar">
      <svg className="brand" viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="11" cy="11" r="6" fill="none" stroke="#e87d0d" strokeWidth="2.4" />
        <circle cx="11" cy="11" r="2.2" fill="#2a5fa8" />
        <path d="M2 7 9 7" stroke="#e87d0d" strokeWidth="2.4" strokeLinecap="round" />
      </svg>
      <Menu id="file" label="ファイル">
        <MenuItem label="プロジェクトを開く… (.wgp / .wgpj)" kbd="Ctrl Shift O" onSelect={onOpenProject} />
        <MenuItem label="プロジェクトを保存 (.wgp)" kbd="Ctrl S" onSelect={() => engine.project.saveFile()} />
        <MenuItem label="ファイルは参照だけで保存 (.wgpj)" kbd="Ctrl Alt S" onSelect={() => engine.project.saveFile('reference')} />
        <MenuItem label="前回の続きを開く (自動保存)" disabled={!recovery} onSelect={() => void engine.autosave.recover()} />
        <div className="note" style={{ padding: '0 8px 4px' }}>.wgpj はモデル・モーション・曲を入れない小さなファイル。開くときに元のファイルを選びます</div>
        <MenuSep />
        <MenuItem label="MMD を読み込む…" kbd="Ctrl O" onSelect={onOpenFiles} />
        <div className="note" style={{ padding: '0 8px 4px' }}>.pmx とテクスチャ・.vmd・.vpd・曲</div>
        <MenuSep />
        <MenuItem label="ポーズを保存 (.vpd)" onSelect={() => engine.savePose()} />
        <MenuItem label="ポーズを読み込む (.vpd)…" onSelect={onLoadPose} />
        <MenuSep />
        <MenuItem label={remote === 'off' ? '外部から操作 (MCP) を受け付ける' : '外部から操作 (MCP) をやめる'}
                  onSelect={() => (remote === 'off' ? engine.remote.connect(REMOTE_DEFAULT_PORT) : engine.remote.disconnect())} />
        <MenuSep />
        <MenuItem label="最初の状態に戻す" onSelect={() => engine.resetAll()} />
        <AddonMenuItems menu="file" />
      </Menu>
      <Menu id="edit" label="編集">
        <MenuItem label={history.index > 0 ? `元に戻す: ${history.labels[history.index]}` : '元に戻す'} kbd="Ctrl Z"
                  disabled={history.index <= 0} onSelect={() => void engine.history.undo()} />
        <MenuItem label={history.index < history.labels.length - 1 ? `やり直す: ${history.labels[history.index + 1]}` : 'やり直す'} kbd="Ctrl Shift Z"
                  disabled={history.index >= history.labels.length - 1} onSelect={() => void engine.history.redo()} />
        <MenuSep />
        <MenuItem label="プリファレンス… (アドオン)" onSelect={onOpenPrefs} />
        <AddonMenuItems menu="edit" />
        <MenuSep />
        <MenuLabel>履歴</MenuLabel>
        {history.labels.map((label, i) => ({ label, i })).slice(-12).reverse().map(({ label, i }) => (
          <MenuItem key={i} label={`${i === history.index ? '● ' : '　'}${label}`} onSelect={() => void engine.history.jump(i)} />
        ))}
      </Menu>
      <Menu id="render" label="レンダー">
        <MenuItem label="画像をレンダリング" kbd="F12" onSelect={() => engine.output.renderImage()} />
        <MenuItem label="アニメーションをレンダリング" kbd="Ctrl F12" onSelect={() => engine.output.renderAnimation()} />
        <MenuSep />
        <MenuItem label="出力の設定…" onSelect={onOpenOutput} />
        <AddonMenuItems menu="render" />
      </Menu>
      <Menu id="help" label="ヘルプ">
        <MenuLabel>ショートカット</MenuLabel>
        {[
          ['再生 / 停止', 'Space'], ['キーフレームを挿入', 'I'], ['いまのキーフレームを削除', 'Alt I'],
          ['前 / 次のキーフレーム', '↓ ↑'], ['前 / 次のフレーム', '← →'], ['最初 / 最後のフレーム', 'Shift ← →'],
          ['選んだ物 (タイムライン上ではキー) を削除', 'X'], ['選択を解除', 'Alt A'], ['追加メニュー', 'Shift A'], ['元に戻す / やり直す', 'Ctrl Z / Ctrl Shift Z'], ['画像 / アニメーションをレンダリング', 'F12 / Ctrl F12'],
          ['前・右・上から見る', 'テンキー 1 3 7'], ['視点を戻す (タイムライン上では全体を表示)', 'Home'], ['サイドバー', 'N'],
          ['シェーダーエディター: ノードを追加 / 消す / 全体を表示', 'Shift A / X / Home'],
        ].map(([label, kbd]) => <MenuItem key={label} label={label} kbd={kbd} disabled />)}
      </Menu>
      {remote !== 'off' && (
        <span className={`remote-chip ${remote}`} aria-label="MCP の接続"
              title={remote === 'connected' ? 'MCP サーバーにつながっています。外から操作できます' : 'MCP サーバーを待っています (npm run mcp)'}>
          MCP {remote === 'connected' ? '接続中' : '待機中'}
        </span>
      )}
      <span className="title">{projectName ? `${projectName} — webgl-grid` : 'webgl-grid'}</span>
    </header>
  );
}
