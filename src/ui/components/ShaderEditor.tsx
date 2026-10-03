import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import { ADDABLE, NODE_TYPES, type NodeCategory, type PropDef, type SocketDef, type SocketKind } from '../../core/materials/nodes';
import { inputLink, type ShaderNode, type SocketRef } from '../../core/materials/tree';
import { useEngine, useUi } from '../EngineContext';
import { SocketField } from './fields';
import { Menu, MenuContext, MenuItem, MenuLabel } from './Menu';

// Blender のシェーダーエディター: 選んでいる物のマテリアルのノードを並べ、線でつないで編集する。
//   ノードの見出しをドラッグで移動、出力のソケットから入力のソケットへドラッグでつなぐ
//   (つながっている入力のソケットをドラッグすると、外して付け替えられる)。
//   何もない所のドラッグで画面を動かし、ホイールで拡大縮小。Shift+A で追加、X で選んだノードを消す、Home で全体を表示
const HEADER = 24, ROW = 24, PAD = 4;
export const CATEGORY_COLOR: Record<NodeCategory, string> = {
  output: '#6b1d22', shader: '#2b652b', texture: '#79461d', input: '#83314a', color: '#6c6c2c', converter: '#246283', vector: '#3c3c83',
};
export const SOCKET_COLOR: Record<SocketKind, string> = { color: '#c7c729', float: '#a1a1a1', vector: '#6363c7', shader: '#63c763' };

type Row = { kind: 'out' | 'in' | 'own'; def: SocketDef } | { kind: 'prop'; def: PropDef };
const rowsOf = (node: ShaderNode): Row[] => {
  const def = NODE_TYPES[node.type];
  return [
    ...def.outputs.map(d => ({ kind: 'out' as const, def: d })),
    ...def.props.map(d => ({ kind: 'prop' as const, def: d })),
    ...(def.ownValue ? [{ kind: 'own' as const, def: def.ownValue }] : []),
    ...def.inputs.map(d => ({ kind: 'in' as const, def: d })),
  ];
};
// ソケットの位置 (エディターの座標)
const socketPos = (node: ShaderNode, side: 'in' | 'out', socket: string, at?: { x: number; y: number }) => {
  const rows = rowsOf(node);
  const i = rows.findIndex(r => r.kind === side && r.def.id === socket);
  const x = (at?.x ?? node.x) + (side === 'out' ? NODE_TYPES[node.type].width : 0);
  return { x, y: (at?.y ?? node.y) + HEADER + PAD + i * ROW + ROW / 2 };
};
const curve = (a: { x: number; y: number }, b: { x: number; y: number }) => {
  const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
  return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
};

type Drag =
  | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number }
  | { kind: 'move'; id: string; sx: number; sy: number; nx: number; ny: number }
  | { kind: 'link'; from: SocketRef };

export function ShaderEditor({ typeSelect, onHover }: { typeSelect: ReactNode; onHover: (on: boolean) => void }) {
  const engine = useEngine();
  useUi(s => s.materialsVersion);
  const sel = useUi(s => s.sel);
  const mat = engine.activeMaterial();
  const menu = useContext(MenuContext);
  const [view, setView] = useState({ x: 0, y: 0, zoom: 1 });
  const [selected, setSelected] = useState<string | null>(null);
  const [live, setLive] = useState<{ node?: { id: string; x: number; y: number }; link?: { from: SocketRef; x: number; y: number } }>({});
  const canvasRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const hovered = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const imageFor = useRef<string | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  // ノードがちょうど入るように表示する
  const fit = useCallback(() => {
    const el = canvasRef.current, m = engine.activeMaterial();
    if (!el || !m?.tree.nodes.length) return;
    const xs = m.tree.nodes.flatMap(n => [n.x, n.x + NODE_TYPES[n.type].width]);
    const ys = m.tree.nodes.flatMap(n => [n.y, n.y + HEADER + PAD * 2 + rowsOf(n).length * ROW]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const zoom = Math.min(1, (el.clientWidth - 40) / (x1 - x0), (el.clientHeight - 40) / (y1 - y0));
    setView({ zoom, x: el.clientWidth / 2 - (x0 + x1) / 2 * zoom, y: el.clientHeight / 2 - (y0 + y1) / 2 * zoom });
  }, [engine]);
  useLayoutEffect(() => { setSelected(null); fit(); }, [mat?.id, fit]);

  // エディターの座標 (ノードの置き場所) に直す
  const toLocal = (clientX: number, clientY: number) => {
    const r = canvasRef.current!.getBoundingClientRect(), v = viewRef.current;
    return { x: (clientX - r.left - v.x) / v.zoom, y: (clientY - r.top - v.y) / v.zoom };
  };

  // ホイールで拡大縮小 (カーソルの位置を中心に)
  useEffect(() => {
    const el = canvasRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect(), v = viewRef.current;
      const zoom = Math.min(Math.max(v.zoom * Math.exp(-e.deltaY * 0.0015), 0.25), 2.5);
      const px = e.clientX - r.left, py = e.clientY - r.top;
      setView({ zoom, x: px - (px - v.x) * zoom / v.zoom, y: py - (py - v.y) * zoom / v.zoom });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // キー: X / Delete で選んだノードを消す、Shift+A で追加、Home で全体 (マウスがエディターの上にあるとき)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!hovered.current || (e.target as HTMLElement).closest('input, select, textarea, .bslider')) return;
      if ((e.code === 'KeyX' || e.code === 'Delete') && selected) {
        engine.removeShaderNode(selected);
        setSelected(null);
      } else if (e.code === 'KeyA' && e.shiftKey) {
        e.preventDefault();
        menu.setOpen('shader-add');
      } else if (e.code === 'Home') {
        e.preventDefault();
        fit();
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [engine, selected, menu, fit]);

  const onPointerDown = (e: RPointerEvent) => {
    if (!mat) return;
    const t = e.target as HTMLElement;
    const out = t.closest<HTMLElement>('[data-out]'), inp = t.closest<HTMLElement>('[data-in]');
    if (out) {
      drag.current = { kind: 'link', from: { node: out.dataset.node!, socket: out.dataset.socket! } };
    } else if (inp) {
      // つながっている入力から引き抜く: 外して、つながっていた出力からの線をドラッグする
      const link = inputLink(mat.tree, inp.dataset.node!, inp.dataset.socket!);
      if (!link) return;
      engine.disconnectNode(link.to);
      drag.current = { kind: 'link', from: link.from };
    } else if (t.closest('.node-header')) {
      const id = t.closest<HTMLElement>('[data-node-id]')!.dataset.nodeId!;
      const n = mat.tree.nodes.find(n => n.id === id)!;
      setSelected(id);
      drag.current = { kind: 'move', id, sx: e.clientX, sy: e.clientY, nx: n.x, ny: n.y };
    } else if (t.closest('[data-node-id]')) {
      setSelected(t.closest<HTMLElement>('[data-node-id]')!.dataset.nodeId!);
      return; // ノードの中の欄の操作はそのまま
    } else {
      setSelected(null);
      drag.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
    }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    onPointerMove(e);
  };
  const onPointerMove = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (d.kind === 'pan') setView(v => ({ ...v, x: d.vx + e.clientX - d.sx, y: d.vy + e.clientY - d.sy }));
    else if (d.kind === 'move') {
      const z = viewRef.current.zoom;
      setLive({ node: { id: d.id, x: Math.round(d.nx + (e.clientX - d.sx) / z), y: Math.round(d.ny + (e.clientY - d.sy) / z) } });
    } else setLive({ link: { from: d.from, ...toLocal(e.clientX, e.clientY) } });
  };
  const onPointerUp = (e: RPointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (d?.kind === 'move' && live.node) engine.moveShaderNode(live.node.id, live.node.x, live.node.y);
    if (d?.kind === 'link') {
      const inp = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-in]');
      if (inp) {
        const why = engine.connectNodes(d.from, { node: inp.dataset.node!, socket: inp.dataset.socket! });
        if (why) engine.ui.toast(why, 2500);
      }
    }
    setLive({});
  };

  const addAtCenter = (type: Parameters<typeof engine.addShaderNode>[0]) => {
    const el = canvasRef.current!;
    const p = toLocal(el.getBoundingClientRect().left + el.clientWidth / 2, el.getBoundingClientRect().top + el.clientHeight / 2);
    const id = engine.addShaderNode(type, Math.round(p.x - NODE_TYPES[type].width / 2), Math.round(p.y - 40));
    if (id) setSelected(id);
  };

  const nodes = mat?.tree.nodes ?? [];
  const posOf = (n: ShaderNode) => (live.node?.id === n.id ? live.node : n);
  const byId = new Map(nodes.map(n => [n.id, n]));
  const images = engine.images();

  return (
    <>
      <div className="area-header">
        {typeSelect}
        <Menu id="shader-add" label="追加">
          {ADDABLE.map(g => [
            <MenuLabel key={g.category}>{g.category}</MenuLabel>,
            ...g.types.map(t => <MenuItem key={t} label={NODE_TYPES[t].label} disabled={!mat} onSelect={() => addAtCenter(t)} />),
          ])}
        </Menu>
        <button type="button" className="hbtn" disabled={!mat} onClick={fit} title="ノード全体を表示 (Home)">全体を表示</button>
        <span className="spacer" />
        {sel && (
          <span className="shader-mat">
            {mat ? <>マテリアル: <b>{mat.name}</b></> : 'マテリアルがありません'}
            {!mat && <button type="button" className="hbtn" onClick={() => engine.newMaterial()}>新規</button>}
          </span>
        )}
      </div>
      <div className={`node-editor${drag.current?.kind === 'pan' ? ' panning' : ''}`} ref={canvasRef}
           style={{ backgroundPosition: `${view.x}px ${view.y}px`, backgroundSize: `${24 * view.zoom}px ${24 * view.zoom}px` }}
           onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
           onPointerEnter={() => { hovered.current = true; onHover(true); }} onPointerLeave={() => { hovered.current = false; }}>
        {!sel && <div className="node-empty">物をクリックして選ぶと、そのマテリアルのノードを編集できます</div>}
        {sel && !mat && <div className="node-empty">このスロットにはマテリアルがありません。「新規」で作れます</div>}
        <div className="node-layer" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
          <svg className="node-links" width="1" height="1" aria-hidden="true">
            {mat?.tree.links.map(l => {
              const a = byId.get(l.from.node), b = byId.get(l.to.node);
              if (!a || !b) return null;
              const kind = NODE_TYPES[a.type].outputs.find(o => o.id === l.from.socket)?.kind ?? 'float';
              return <path key={`${l.to.node}:${l.to.socket}`} d={curve(socketPos(a, 'out', l.from.socket, posOf(a)), socketPos(b, 'in', l.to.socket, posOf(b)))}
                           stroke={SOCKET_COLOR[kind]} />;
            })}
            {live.link && byId.get(live.link.from.node) && (
              <path className="dragging" d={curve(socketPos(byId.get(live.link.from.node)!, 'out', live.link.from.socket), live.link)} stroke="#ddd" />
            )}
          </svg>
          {nodes.map(n => {
            const def = NODE_TYPES[n.type], p = posOf(n);
            return (
              <div key={n.id} className={`node${selected === n.id ? ' selected' : ''}`} data-node-id={n.id}
                   style={{ left: p.x, top: p.y, width: def.width }} role="group" aria-label={`ノード ${def.label}`}>
                <div className="node-header" style={{ background: CATEGORY_COLOR[def.category] }}>{def.label}</div>
                <div className="node-body">
                  {rowsOf(n).map(row => (
                    <div key={`${row.kind}:${row.def.id}`} className={`node-row ${row.kind}`}>
                      {row.kind === 'out' && (
                        <>
                          <span className="node-out-label">{row.def.label}</span>
                          <span className="socket out" data-out="" data-node={n.id} data-socket={row.def.id} style={{ background: SOCKET_COLOR[row.def.kind] }}
                                aria-label={`${def.label} の出力 ${row.def.label}`} />
                        </>
                      )}
                      {row.kind === 'in' && (
                        <>
                          {row.def.linkable !== false && (
                            <span className="socket in" data-in="" data-node={n.id} data-socket={row.def.id} style={{ background: SOCKET_COLOR[row.def.kind] }}
                                  aria-label={`${def.label} の入力 ${row.def.label}`} />
                          )}
                          {inputLink(mat!.tree, n.id, row.def.id)
                            ? <span className="socket-label">{row.def.label}</span>
                            : <SocketField def={row.def} value={n.values[row.def.id]} compact onChange={v => engine.setNodeValue(n.id, row.def.id, v)} />}
                        </>
                      )}
                      {row.kind === 'own' && <SocketField def={row.def} value={n.values[row.def.id]} compact onChange={v => engine.setNodeValue(n.id, row.def.id, v)} />}
                      {row.kind === 'prop' && row.def.kind === 'enum' && (
                        <select className="bselect" aria-label={row.def.label} value={n.props[row.def.id]} onChange={e => engine.setNodeProp(n.id, row.def.id, e.currentTarget.value)}>
                          {row.def.options!.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                        </select>
                      )}
                      {row.kind === 'prop' && row.def.kind === 'image' && (
                        <div className="image-pick">
                          <select className="bselect" aria-label="画像" value={n.props.image ?? ''} onChange={e => engine.setNodeProp(n.id, 'image', e.currentTarget.value)}>
                            <option value="">(なし)</option>
                            {images.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
                          </select>
                          <button type="button" className="bbtn" title="画像ファイルを開く" onClick={() => { imageFor.current = n.id; fileRef.current?.click(); }}>開く…</button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <input type="file" ref={fileRef} accept="image/*,.png,.jpg,.jpeg,.bmp,.tga,.gif" hidden
             onChange={async e => {
               const f = e.currentTarget.files?.[0], node = imageFor.current;
               e.currentTarget.value = '';
               if (f && node) engine.setNodeProp(node, 'image', await engine.openImage(f));
             }} />
    </>
  );
}
