import { useMemo, useState, type ReactNode } from 'react';
import { filterFxPaths, fxTree, initiallyOpen, type FxTreeNode } from '../../core/fxTree';
import { t } from '../../core/i18n';

// --- .fx を選ぶ窓の中身: 見つかった .fx (フォルダからの相対パス) をフォルダの木にして選ばせる。フォルダの行で開け閉めする
// (はじめは一番上の階層だけ見せる)。絞り込むと、合うものだけをフォルダを開いて出し、1 つに絞れたら Enter で選べる ---
export function MmeFxChooser({ entries, onPick }: { entries: string[]; onPick: (entry: string) => void }) {
  const tree = useMemo(() => fxTree(entries), [entries]);
  const [open, setOpen] = useState(() => new Set(initiallyOpen(tree)));
  const [query, setQuery] = useState('');
  const matches = useMemo(() => (query.trim() ? filterFxPaths(entries, query) : null), [entries, query]);
  const shown = useMemo(() => (matches ? fxTree(matches) : tree), [matches, tree]);
  const toggle = (path: string) => setOpen(s => { const n = new Set(s); if (!n.delete(path)) n.add(path); return n; });
  const rows = (nodes: FxTreeNode[], depth: number): ReactNode[] => nodes.flatMap(node => {
    const indent = { paddingLeft: 8 + depth * 14 };
    if (node.kind === 'file') {
      return [<button key={node.path} type="button" className="bbtn" style={indent} title={node.path} onClick={() => onPick(node.path)}>{node.name}</button>];
    }
    const expanded = !!matches || open.has(node.path);
    return [
      <button key={node.path} type="button" className="bbtn mme-fx-dir" style={indent} title={node.path} aria-expanded={expanded}
              disabled={!!matches} onClick={() => toggle(node.path)}>
        {node.name}<span className="note"> {t('.fx {n} 個', { n: node.count })}</span>
      </button>,
      ...(expanded ? rows(node.children, depth + 1) : []),
    ];
  });
  return (
    <>
      {/* (Enter: 1 つに絞れていれば選ぶ。場面のショートカットを止めているので、キーではなくフォームの送信で受ける) */}
      <form onSubmit={e => { e.preventDefault(); if (matches?.length === 1) onPick(matches[0]); }}>
        <input className="text-field" type="search" autoFocus placeholder={t('絞り込み')} aria-label={t('.fx を絞り込む')}
               value={query} onChange={e => setQuery(e.currentTarget.value)} />
      </form>
      <div className="mme-fx-list" role="group" aria-label={t('見つかった .fx')}>
        {rows(shown, 0)}
      </div>
      {matches?.length === 0 && <div className="note">{t('合う .fx がありません')}</div>}
    </>
  );
}
