import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { channelKeys, evaluate, PROPS, type BoneKey, type Channel, type Curve, type MorphKey } from '../../core/animation';
import { DEG } from '../../core/constants';
import { t } from '../../core/i18n';
import { fitView, frameAt as frameAtView, rulerStep, zoomView } from '../../core/timelineMath';
import type { BoneValue } from '../../core/types';
import type { Engine } from '../../engine';
import { isModel, type Obj } from '../../engine/types';
import { useEngine, useUi } from '../EngineContext';

// --- グラフエディター (Blender のグラフエディター): アクティブな物のチャンネルの値を、時間を横軸にした曲線で描く ---
// 位置 X は赤・Z は青・回転は緑 (度)・大きさは黄、ボーンは回転 X/Y/Z (度) と位置 X/Y/Z、表情は 0〜1、MME の値はその値。
// キーの点をドラッグして、上下で値を、左右でフレームを変える (左右は 6px 動かしてから)。何もない所のドラッグで再生位置を動かす。
// 押したキーには、前のキーからの補間曲線のハンドル (2 つ) が出て、ドラッグで曲線の形を変える (MMD の補間曲線と同じく、前後のキーのあいだに収まる)。
// ホイールで拡大縮小、Home で全体を表示。
// 左上の一覧で、曲線を出す・隠す。「正規化」で、曲線ごとに -1〜1 にそろえて描く (値の大きさの違う曲線を一緒に見る)
interface CurveDef { id: string; label: string; color: string; ch: Channel; comp: keyof BoneValue | null; k: number } // k: 表示の倍率 (ラジアン → 度)
const RULER = 22, PAD = 14, HIT = 7;
const BONE_COMPS: [keyof BoneValue, string, string, number][] = [
  ['rx', '回転 X', '#ff5a5a', 1], ['ry', '回転 Y', '#7ed957', 1], ['rz', '回転 Z', '#5aa0ff', 1],
  ['px', '位置 X', '#ff9a9a', 1], ['py', '位置 Y', '#b5e89c', 1], ['pz', '位置 Z', '#9cc4ff', 1],
];
const PROP_STYLE: Record<string, [string, number]> = {
  x: ['#ff5a5a', 1], z: ['#5aa0ff', 1], r: ['#7ed957', 1 / DEG], scale: ['#f2c94c', 1],
  power: ['#ffd25e', 1], colorR: ['#ff7070', 1], colorG: ['#70e070', 1], colorB: ['#70a0ff', 1], fov: ['#8cc4ff', 1], height: ['#c8a2ff', 1],
};
const MORPH_COLORS = ['#d38cff', '#ff8cc6', '#8cf2ff', '#ffd08c'];
const MME_COLORS = ['#ffb35a', '#5ae0c0', '#e0e05a', '#b0a0ff'];

// 物のチャンネルの曲線の一覧 (ボーンは、どこかのキーで 0 でない成分だけ)
function curvesOf(engine: Engine, obj: Obj | null): CurveDef[] {
  const anim = obj?.anim;
  if (!obj || !anim) return [];
  const out: CurveDef[] = [];
  for (const p of [...anim.props.keys()].sort((a, b) => a - b)) {
    const def = PROPS[p];
    if (!def) continue;
    const [color, k] = PROP_STYLE[def.key];
    out.push({ id: `p${p}`, label: t(def.name), color, ch: { kind: 'prop', index: p }, comp: null, k });
  }
  if (isModel(obj)) {
    for (const b of [...anim.bones.keys()].sort((a, b) => a - b)) {
      const keys = [...anim.bones.get(b)!.values()];
      const bone = obj.model.skeleton.bones[b]?.name ?? String(b);
      for (const [comp, name, color, k] of BONE_COMPS) {
        if (keys.some(key => key.v[comp] !== 0)) out.push({ id: `b${b}${comp}`, label: `${bone} ${t(name)}`, color, ch: { kind: 'bone', index: b }, comp, k });
      }
    }
    const names = new Map(engine.posing.morphs(obj).map(m => [m.index, m.name]));
    [...anim.morphs.keys()].sort((a, b) => a - b).forEach((m, i) => {
      out.push({ id: `m${m}`, label: t('表情: {name}', { name: names.get(m) ?? m }), color: MORPH_COLORS[i % MORPH_COLORS.length], ch: { kind: 'morph', index: m }, comp: null, k: 1 });
    });
  }
  // MME の値 (名前は物の MME のチャンネルの一覧)
  [...anim.mme.keys()].sort((a, b) => a - b).forEach((c, i) => {
    out.push({ id: `e${c}`, label: t('MME: {name}', { name: obj.mmeChannels?.[c] ?? c }), color: MME_COLORS[i % MME_COLORS.length], ch: { kind: 'mme', index: c }, comp: null, k: 1 });
  });
  return out;
}
// 押したキーのハンドルの位置 (フレーム・表示の単位の値)。前のキーがなければ (最初のキー) null
function handleGeom(c: CurveDef, keys: Map<number, BoneKey | MorphKey>, frame: number) {
  const key = keys.get(frame);
  const prevF = Math.max(...[...keys.keys()].filter(f => f < frame));
  if (!key || !Number.isFinite(prevF)) return null;
  const prev: [number, number] = [prevF, keyValue(c, keys.get(prevF)!)], cur: [number, number] = [frame, keyValue(c, key)];
  const at = (u: number, w: number): [number, number] => [prev[0] + u * (cur[0] - prev[0]), prev[1] + w * (cur[1] - prev[1])];
  const [x1, y1, x2, y2] = key.curve;
  return { prev, key: cur, curve: key.curve, handles: [at(x1, y1), at(x2, y2)] };
}
// 曲線の、キーの値と、フレーム f の値
const keyValue = (c: CurveDef, key: BoneKey | MorphKey) => (c.comp ? (key as BoneKey).v[c.comp] : (key as MorphKey).v) * c.k;
function valueAt(c: CurveDef, ev: ReturnType<typeof evaluate>) {
  if (c.ch.kind === 'prop') return ev.props.get(c.ch.index);
  if (c.ch.kind === 'morph') return ev.morphs.get(c.ch.index);
  if (c.ch.kind === 'mme') return ev.mme.get(c.ch.index);
  const v = ev.pose.get(c.ch.index);
  return v && c.comp ? v[c.comp] : undefined;
}

export function GraphEditor({ open, typeSelect }: { open: boolean; typeSelect: React.ReactNode }) {
  const engine = useEngine();
  const { clock } = engine;
  const frame = useUi(s => s.frame);
  const start = useUi(s => s.start);
  const end = useUi(s => s.end);
  const keysVersion = useUi(s => s.keysVersion);
  const values = useUi(s => s.values);
  const sel = useUi(s => s.sel);
  const lang = useUi(s => s.lang);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [normalize, setNormalize] = useState(false);
  const norm = useRef(new Map<string, { mid: number; half: number }>()); // 正規化: 曲線ごとの真ん中と半分の幅
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const view = useRef({ f0: -10, f1: 260, user: false });
  const yRange = useRef({ v0: -1, v1: 1 });
  type KeyDrag = { curve: CurveDef; frame: number; from: number; base: Map<number, BoneKey | MorphKey>; x0: number; moved: boolean };
  type HandleDrag = { handle: 0 | 1; curve: CurveDef; frame: number };
  const drag = useRef<KeyDrag | HandleDrag | { scrub: number } | null>(null);
  const picked = useRef<{ id: string; frame: number } | null>(null); // 押したキー (ハンドルを出す)
  const handles = useRef<{ which: 0 | 1; x: number; y: number }[]>([]); // (描いたハンドルの位置。押したかを調べる)
  const state = useRef({ frame, start, end, hidden, normalize });
  useLayoutEffect(() => { state.current = { frame, start, end, hidden, normalize }; }, [frame, start, end, hidden, normalize]);
  const obj = engine.selection.current;
  void keysVersion; void values; void sel; // (選び直し・キーの変化で、一覧を作り直す)
  const curves = curvesOf(engine, obj);

  const fit = useCallback(() => { view.current = { ...fitView(state.current.start, state.current.end), user: false }; }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    if (!W || !H) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const { frame, start, end, hidden, normalize } = state.current;
    const v = view.current, ppf = W / (v.f1 - v.f0);
    const x = (f: number) => (f - v.f0) * ppf;
    const target = engine.selection.current, anim = target?.anim;
    const list = curvesOf(engine, target).filter(c => !hidden.has(c.id));
    // 縦の範囲: 見えている曲線の値がちょうど入るように
    let lo = Infinity, hi = -Infinity;
    const samples = new Map<string, [number, number][]>();
    if (anim) {
      for (let px = 0; px <= W; px += 2) {
        const f = v.f0 + px / ppf, ev = evaluate(anim, f);
        for (const c of list) {
          const val = valueAt(c, ev);
          if (val === undefined) continue;
          let s = samples.get(c.id);
          if (!s) samples.set(c.id, s = []);
          s.push([px, val * c.k]);
        }
      }
    }
    // 正規化: 曲線ごとの範囲 (キーの値も入れて) を -1〜1 に
    norm.current.clear();
    for (const c of list) {
      const s = samples.get(c.id) ?? [];
      const vals = [...s.map(p => p[1]), ...[...(anim && channelKeys(anim, c.ch))?.values() ?? []].map(key => keyValue(c, key))];
      if (!vals.length) continue;
      const mn = Math.min(...vals), mx = Math.max(...vals);
      const n = normalize ? { mid: (mn + mx) / 2, half: Math.max((mx - mn) / 2, 1e-6) } : { mid: 0, half: 1 };
      norm.current.set(c.id, n);
      for (const p of s) p[1] = (p[1] - n.mid) / n.half;
      lo = Math.min(lo, (mn - n.mid) / n.half); hi = Math.max(hi, (mx - n.mid) / n.half);
    }
    if (!(hi > lo)) { lo = (Number.isFinite(lo) ? lo : 0) - 1; hi = lo + 2; }
    const m = (hi - lo) * 0.12;
    yRange.current = { v0: lo - m, v1: hi + m };
    const { v0, v1 } = yRange.current, top = RULER + PAD, bottom = H - PAD;
    const y = (val: number) => bottom - (val - v0) / (v1 - v0) * (bottom - top);
    ctx.fillStyle = '#282828';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
    ctx.fillRect(0, RULER, Math.max(x(start), 0), H);
    ctx.fillRect(x(end), RULER, W, H);
    // 目盛り: 横 (フレーム) と縦 (値)
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#2e2e2e';
    ctx.fillRect(0, 0, W, RULER);
    const step = rulerStep(ppf);
    ctx.textAlign = 'center';
    for (let f = Math.ceil(v.f0 / step) * step; f <= v.f1; f += step) {
      const px = Math.round(x(f)) + 0.5;
      ctx.fillStyle = '#353535';
      ctx.fillRect(px - 0.5, RULER, 1, H - RULER);
      ctx.fillStyle = '#a8a8a8';
      ctx.fillText(String(f), px, RULER / 2);
    }
    const vstep = rulerStep((bottom - top) / (v1 - v0)) ;
    ctx.textAlign = 'right';
    for (let val = Math.ceil(v0 / vstep) * vstep; val <= v1; val += vstep) {
      const py = Math.round(y(val)) + 0.5;
      ctx.fillStyle = Math.abs(val) < vstep / 2 ? '#4a4a4a' : '#333';
      ctx.fillRect(0, py - 0.5, W, 1);
      ctx.fillStyle = '#8a8a8a';
      ctx.fillText(String(+val.toFixed(3)), W - 4, py - 7);
    }
    // 曲線と、キーの点
    handles.current = [];
    for (const c of list) {
      const s = samples.get(c.id);
      if (!s?.length) continue;
      ctx.strokeStyle = c.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      s.forEach(([px, val], i) => (i ? ctx.lineTo(px, y(val)) : ctx.moveTo(px, y(val))));
      ctx.stroke();
      const keys = anim && channelKeys(anim, c.ch);
      const n = norm.current.get(c.id) ?? { mid: 0, half: 1 };
      // 押したキーのハンドル: 前のキーから、このキーまでの補間曲線の 2 つの点
      const pk = picked.current;
      if (pk?.id === c.id && keys?.has(pk.frame)) {
        const hs = handleGeom(c, keys, pk.frame);
        if (hs) {
          const pt = (f: number, val: number) => [x(f), y((val - n.mid) / n.half)] as const;
          const [ax, ay] = pt(hs.prev[0], hs.prev[1]), [bx, by] = pt(hs.key[0], hs.key[1]);
          handles.current = hs.handles.map(([f, val], i) => { const [hx, hy] = pt(f, val); return { which: i as 0 | 1, x: hx, y: hy }; });
          ctx.strokeStyle = 'rgba(255, 190, 51, 0.8)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(ax, ay); ctx.lineTo(handles.current[0].x, handles.current[0].y);
          ctx.moveTo(bx, by); ctx.lineTo(handles.current[1].x, handles.current[1].y);
          ctx.stroke();
          for (const h of handles.current) {
            ctx.fillStyle = '#282828';
            ctx.beginPath();
            ctx.arc(h.x, h.y, 3.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = '#ffbe33';
            ctx.lineWidth = 1.5;
            ctx.stroke();
          }
        }
      }
      for (const [f, key] of keys ?? []) {
        const px = x(f), py = y((keyValue(c, key) - n.mid) / n.half);
        if (px < -HIT || px > W + HIT) continue;
        const active = pk?.id === c.id && pk.frame === f;
        ctx.fillStyle = active ? '#ffbe33' : '#eee';
        ctx.beginPath();
        ctx.arc(px, py, active ? 4.5 : 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#111';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    if (!list.length) {
      ctx.fillStyle = 'rgba(230, 230, 230, 0.4)';
      ctx.textAlign = 'left';
      ctx.fillText(t('キーのある物を選ぶと、チャンネルの値がここに曲線で並びます'), 8, RULER + 20);
    }
    // 再生ヘッド
    const px = Math.round(x(frame));
    ctx.fillStyle = '#4772b3';
    ctx.fillRect(px - 1, RULER - 2, 2, H);
    const label = String(frame), tw = Math.max(ctx.measureText(label).width + 12, 24);
    ctx.beginPath();
    ctx.roundRect(px - tw / 2, 3, tw, RULER - 6, 4);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText(label, px, RULER / 2);
  }, [engine]);

  useEffect(() => { if (!view.current.user) fit(); draw(); }, [start, end, fit, draw]);
  useEffect(() => { draw(); }, [frame, keysVersion, values, sel, hidden, normalize, open, lang, draw]);
  useEffect(() => {
    const canvas = canvasRef.current!;
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = view.current, W = canvas.clientWidth, span = v.f1 - v.f0;
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) { const d = (e.shiftKey ? e.deltaY : e.deltaX) / W * span; v.f0 += d; v.f1 += d; }
      else {
        const at = v.f0 + (e.clientX - canvas.getBoundingClientRect().left) / W * span;
        Object.assign(v, zoomView(v, at, Math.min(Math.max(Math.exp(e.deltaY * 0.002), 0.2), 5)));
      }
      v.user = true;
      draw();
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    const onFit = () => { fit(); draw(); };
    addEventListener('timeline-fit', onFit);
    return () => { ro.disconnect(); canvas.removeEventListener('wheel', onWheel); removeEventListener('timeline-fit', onFit); };
  }, [draw, fit]);

  const local = (e: React.PointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, W: r.width, H: r.height };
  };
  const toValue = (py: number, H: number) => {
    const { v0, v1 } = yRange.current, top = RULER + PAD, bottom = H - PAD;
    return v0 + (bottom - py) / (bottom - top) * (v1 - v0);
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const { x, y, W, H } = local(e);
    canvasRef.current!.setPointerCapture(e.pointerId);
    const v = view.current, ppf = W / (v.f1 - v.f0), anim = obj?.anim;
    // いちばん近いキーの点
    let best: { curve: CurveDef; frame: number; d: number } | null = null;
    if (anim && y > RULER) {
      const { v0, v1 } = yRange.current, top = RULER + PAD, bottom = H - PAD;
      for (const c of curves.filter(c => !hidden.has(c.id))) {
        const n = norm.current.get(c.id) ?? { mid: 0, half: 1 };
        for (const [f, key] of channelKeys(anim, c.ch) ?? []) {
          const d = Math.hypot((f - v.f0) * ppf - x, bottom - ((keyValue(c, key) - n.mid) / n.half - v0) / (v1 - v0) * (bottom - top) - y);
          if (d <= HIT && (!best || d < best.d)) best = { curve: c, frame: f, d };
        }
      }
    }
    // 押したキーのハンドル (キーの点より先に)
    const pk = picked.current, pc = pk && curves.find(c => c.id === pk.id);
    const h = handles.current.find(h => Math.hypot(h.x - x, h.y - y) <= HIT);
    if (h && pc && pk) {
      drag.current = { handle: h.which, curve: pc, frame: pk.frame };
      return;
    }
    if (best) {
      const keys = channelKeys(anim!, best.curve.ch)!;
      drag.current = { curve: best.curve, frame: best.frame, from: best.frame, base: new Map(keys), x0: x, moved: false };
      picked.current = { id: best.curve.id, frame: best.frame };
      clock.seekFrame(best.frame, 5);
      draw();
      return;
    }
    picked.current = null;
    const f = frameAtView(v, x, W);
    drag.current = { scrub: f };
    clock.seekFrame(f, 5);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const { x, y, W, H } = local(e);
    const n = 'curve' in d ? norm.current.get(d.curve.id) ?? { mid: 0, half: 1 } : null;
    const shown = n ? n.mid + toValue(y, H) * n.half : 0; // (表示の単位の値)
    if ('handle' in d) {
      // ハンドル: 前のキーとこのキーのあいだの割合にして、補間曲線の点にする (0〜1 に収める)
      const keys = obj?.anim && channelKeys(obj.anim, d.curve.ch), hs = keys && handleGeom(d.curve, keys, d.frame);
      if (!hs) return;
      const fx = view.current.f0 + x / W * (view.current.f1 - view.current.f0);
      const clamp = (u: number) => Math.min(Math.max(u, 0), 1);
      const cv = [...hs.curve] as Curve;
      cv[d.handle * 2] = clamp((fx - hs.prev[0]) / (hs.key[0] - hs.prev[0]));
      if (Math.abs(hs.key[1] - hs.prev[1]) > 1e-9) cv[d.handle * 2 + 1] = clamp((shown - hs.prev[1]) / (hs.key[1] - hs.prev[1]));
      engine.setKeyCurveAt(d.curve.ch, d.frame, cv);
    } else if ('curve' in d) {
      // キー: 左右はフレーム (6px 動かしてから)、上下は値
      if (!d.moved && Math.abs(x - d.x0) >= 6) d.moved = true;
      const f = d.moved ? Math.max(0, frameAtView(view.current, x, W)) : d.from;
      if (f !== d.frame) {
        engine.placeChannelKey(d.curve.ch, d.base, d.from, f);
        d.frame = f;
        picked.current = { id: d.curve.id, frame: f };
        clock.seekFrame(f, 5);
      }
      engine.setKeyValue(d.curve.ch, d.frame, d.curve.comp, shown / d.curve.k);
    }
    else {
      const f = frameAtView(view.current, x, W);
      if (f !== d.scrub) { d.scrub = f; clock.seekFrame(f, 5); }
    }
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d && 'scrub' in d) clock.seekFrame(d.scrub);
    draw();
  };

  return (
    <>
      <div className="area-header tl-header">
        {typeSelect}
        <span className="graph-title">{obj ? t('{name} のチャンネル', { name: t(sel?.name ?? '') }) : ''}</span>
        <button type="button" className="hbtn" aria-pressed={normalize} onClick={() => setNormalize(n => !n)}
                title={t('曲線ごとに -1〜1 にそろえて描く')}>{t('正規化')}</button>
      </div>
      <div className="tl-body graph-body">
        <canvas ref={canvasRef} className="graph-canvas" aria-label={t('グラフエディター (キーの点をドラッグで値・フレームを変える)')}
                onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} />
        {curves.length > 0 && (
          <ul className="graph-legend" aria-label={t('曲線')}>
            {curves.map(c => (
              <li key={c.id}>
                <button type="button" aria-pressed={!hidden.has(c.id)} onClick={() => setHidden(h => { const s = new Set(h); if (s.has(c.id)) s.delete(c.id); else s.add(c.id); return s; })}>
                  <span className="swatch" style={{ background: c.color }} />{c.label}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
