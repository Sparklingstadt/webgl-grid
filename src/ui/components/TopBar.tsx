import { useEngine } from '../EngineContext';
import { Menu, MenuItem, MenuLabel, MenuSep } from './Menu';

// 上のバー: ファイルとヘルプのメニュー
export function TopBar({ onOpenFiles, onLoadPose }: { onOpenFiles: () => void; onLoadPose: () => void }) {
  const engine = useEngine();
  return (
    <header className="topbar">
      <svg className="brand" viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="11" cy="11" r="6" fill="none" stroke="#e87d0d" strokeWidth="2.4" />
        <circle cx="11" cy="11" r="2.2" fill="#2a5fa8" />
        <path d="M2 7 9 7" stroke="#e87d0d" strokeWidth="2.4" strokeLinecap="round" />
      </svg>
      <Menu id="file" label="ファイル">
        <MenuItem label="MMD を読み込む…" kbd="Ctrl O" onSelect={onOpenFiles} />
        <div className="note" style={{ padding: '0 8px 4px' }}>.pmx とテクスチャ・.vmd・.vpd・曲</div>
        <MenuSep />
        <MenuItem label="ポーズを保存 (.vpd)" onSelect={() => engine.savePose()} />
        <MenuItem label="ポーズを読み込む (.vpd)…" onSelect={onLoadPose} />
        <MenuSep />
        <MenuItem label="最初の状態に戻す" onSelect={() => engine.resetAll()} />
      </Menu>
      <Menu id="help" label="ヘルプ">
        <MenuLabel>ショートカット</MenuLabel>
        {[
          ['再生 / 停止', 'Space'], ['キーフレームを挿入', 'I'], ['いまのキーフレームを削除', 'Alt I'],
          ['前 / 次のキーフレーム', '↓ ↑'], ['前 / 次のフレーム', '← →'], ['最初 / 最後のフレーム', 'Shift ← →'],
          ['選んだ物 (タイムライン上ではキー) を削除', 'X'], ['選択を解除', 'Alt A'], ['追加メニュー', 'Shift A'],
          ['前・右・上から見る', 'テンキー 1 3 7'], ['視点を戻す (タイムライン上では全体を表示)', 'Home'], ['サイドバー', 'N'],
          ['シェーダーエディター: ノードを追加 / 消す / 全体を表示', 'Shift A / X / Home'],
        ].map(([label, kbd]) => <MenuItem key={label} label={label} kbd={kbd} disabled />)}
      </Menu>
      <span className="title">webgl-grid</span>
    </header>
  );
}
