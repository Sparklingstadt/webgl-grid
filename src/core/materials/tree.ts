import { NODE_TYPES, compatible, type NodeType, type SocketDef, type SocketValue } from './nodes';

// シェーダーのノードツリー (Blender のマテリアルのノード)。ノードと、ノードどうしをつなぐリンクでできている
export interface ShaderNode {
  id: string;
  type: NodeType;
  x: number;
  y: number;
  values: Record<string, SocketValue>; // つながっていない入力の値 (と RGB・値ノードの値)
  props: Record<string, string>;       // 合成の種類・演算・画像など
}
export interface SocketRef { node: string; socket: string }
export interface Link { from: SocketRef; to: SocketRef }
export interface NodeTree { nodes: ShaderNode[]; links: Link[]; nextId: number }

const copy = <T>(v: T): T => (Array.isArray(v) ? [...v] as T : v);

export function makeNode(tree: NodeTree, type: NodeType, x = 0, y = 0): ShaderNode {
  const def = NODE_TYPES[type];
  const values: Record<string, SocketValue> = {};
  for (const s of def.inputs) if (s.default !== undefined) values[s.id] = copy(s.default);
  if (def.ownValue) values[def.ownValue.id] = copy(def.ownValue.default!);
  const props: Record<string, string> = {};
  for (const p of def.props) if (p.default !== undefined) props[p.id] = p.default;
  return { id: `n${tree.nextId++}`, type, x, y, values, props };
}

// 新しいマテリアルのノード: プリンシプル BSDF → マテリアル出力 (Blender の「新規」と同じ)
export function createTree(): NodeTree {
  const tree: NodeTree = { nodes: [], links: [], nextId: 1 };
  const bsdf = addNode(tree, 'principled', -260, 0);
  const out = addNode(tree, 'output', 60, 0);
  connect(tree, { node: bsdf.id, socket: 'bsdf' }, { node: out.id, socket: 'surface' });
  return tree;
}

export const cloneTree = (tree: NodeTree): NodeTree => JSON.parse(JSON.stringify(tree));
export const findNode = (tree: NodeTree, id: string) => tree.nodes.find(n => n.id === id) ?? null;

export function addNode(tree: NodeTree, type: NodeType, x = 0, y = 0): ShaderNode {
  const node = makeNode(tree, type, x, y);
  tree.nodes.push(node);
  return node;
}
// マテリアル出力は消せない
export function removeNode(tree: NodeTree, id: string) {
  const node = findNode(tree, id);
  if (!node || node.type === 'output') return false;
  tree.nodes = tree.nodes.filter(n => n !== node);
  tree.links = tree.links.filter(l => l.from.node !== id && l.to.node !== id);
  return true;
}

export function socketDef(tree: NodeTree, ref: SocketRef, side: 'in' | 'out'): SocketDef | null {
  const node = findNode(tree, ref.node);
  if (!node) return null;
  const def = NODE_TYPES[node.type];
  return (side === 'in' ? def.inputs : def.outputs).find(s => s.id === ref.socket) ?? null;
}
export const inputLink = (tree: NodeTree, node: string, socket: string) =>
  tree.links.find(l => l.to.node === node && l.to.socket === socket) ?? null;

// from のノードが、to のノードから (出力の向きに) たどれるか。つなぐと輪になるかを見る
function reaches(tree: NodeTree, start: string, target: string): boolean {
  const seen = new Set<string>(), stack = [start];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === target) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const l of tree.links) if (l.from.node === cur) stack.push(l.to.node);
  }
  return false;
}

// 出力 from を入力 to につなげるか (なぜだめかを返す。つなげるなら null)
export function whyNotConnect(tree: NodeTree, from: SocketRef, to: SocketRef): string | null {
  const out = socketDef(tree, from, 'out'), inp = socketDef(tree, to, 'in');
  if (!out || !inp) return 'ソケットがありません';
  if (from.node === to.node) return '同じノードどうしはつなげません';
  if (inp.linkable === false) return 'この入力にはつなげません';
  if (!compatible(out.kind, inp.kind)) return 'シェーダーはシェーダーの入力にだけつなげます';
  if (reaches(tree, to.node, from.node)) return 'つなぐと輪になります';
  return null;
}
// つなぐ (その入力に前からつながっていたリンクは外す)。つなげなければ false
export function connect(tree: NodeTree, from: SocketRef, to: SocketRef) {
  if (whyNotConnect(tree, from, to)) return false;
  tree.links = tree.links.filter(l => !(l.to.node === to.node && l.to.socket === to.socket));
  tree.links.push({ from: { ...from }, to: { ...to } });
  return true;
}
export function disconnect(tree: NodeTree, to: SocketRef) {
  const before = tree.links.length;
  tree.links = tree.links.filter(l => !(l.to.node === to.node && l.to.socket === to.socket));
  return tree.links.length !== before;
}

// マテリアル出力の「サーフェス」につながっているプリンシプル BSDF (なければ null)
export function surfaceShader(tree: NodeTree): ShaderNode | null {
  const out = tree.nodes.find(n => n.type === 'output');
  const link = out && inputLink(tree, out.id, 'surface');
  const node = link && findNode(tree, link.from.node);
  return node?.type === 'principled' ? node : null;
}

// root (とその入力の先) のノードを、入力側から順に並べる (シェーダーの式を組み立てる順)
export function upstreamOrder(tree: NodeTree, root: string): ShaderNode[] {
  const order: ShaderNode[] = [], seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const l of tree.links) if (l.to.node === id) visit(l.from.node);
    const n = findNode(tree, id);
    if (n) order.push(n);
  };
  visit(root);
  return order;
}
