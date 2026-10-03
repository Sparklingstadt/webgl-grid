import type { ReactNode } from 'react';
import { useUi } from '../../EngineContext';

// Blender のパネル: 見出しを押すと開け閉めできる
export function Panel({ title, children, head }: { title: ReactNode; children: ReactNode; head?: ReactNode }) {
  return (
    <details className="panel" open>
      <summary>{head}{title}</summary>
      <div className="panel-body">{children}</div>
    </details>
  );
}
export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;

// MMD モデルを選んでいるときだけ中身を出す (中身はモデルが変わるたびに作り直す)
export function NeedModel({ children }: { children: (id: number) => ReactNode }) {
  const sel = useUi(s => s.sel);
  if (sel?.kind !== 'model') return <Panel title="モデル"><Empty>MMD モデルをクリックして選ぶと、表情とボーンを動かせます。</Empty></Panel>;
  return <>{children(sel.id)}</>;
}
