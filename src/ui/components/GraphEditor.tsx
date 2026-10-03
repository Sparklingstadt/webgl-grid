import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { channelKeys, evaluate, PROPS, type BoneKey, type Channel, type MorphKey } from '../../core/animation';
import { DEG } from '../../core/constants';
import { t } from '../../core/i18n';
import { fitView, frameAt as frameAtView, rulerStep, zoomView } from '../../core/timelineMath';
import type { BoneValue } from '../../core/types';
import type { Engine } from '../../engine';
import { isModel, type Obj } from '../../engine/types';
import { useEngine, useUi } from '../EngineContext';

// --- グラフエディター (Blender のグラフエディター): アクティブな物のチャンネルの値を、時間を横軸にした曲線で描く ---
// 位置 X は赤・Z は青・回転は緑 (度)・大きさは黄、ボーンは回転 X/Y/Z (度) と位置 X/Y/Z、表情は 0〜1。
// キーの点を上下にドラッグして値を変える。何もない所のドラッグで再生位置を動かす。ホイールで拡大縮小、Home で全体を表示。
// 左上の一覧で、曲線を出す・隠す。「正規化」で、曲線ごとに -1〜1 にそろえて描く (値の大きさの違う曲線を一緒に見る)
interface CurveDef { id: string; label: string; color: string; ch: Channel; comp: keyof BoneValue | null; k: number } // k: 表示の倍率 (ラジアン → 度)
const RULER = 22, PAD = 14, HIT = 7;
const BONE_COMPS: [keyof BoneValue, string, string, number][] = [
  ['rx', '回転 X', '#ff5a5a', 1], ['ry', '回転 Y', '#7ed957', 1], ['rz', '回転 Z', '#5aa0ff', 1],
  ['px', '位置 X', '#ff9a9a', 1], ['py', '位置 Y', '#b5e89c', 1], ['pz', '位置 Z', '#9cc4ff', 1],
];
const PROP_STYLE: Record<string, [string, number]> = { x: ['#ff5a5a', 1], z: ['#5aa0ff', 1], r: ['#7ed957', 1 / DEG], scale: ['#f2c94c', 1] };
const MORPH_COLORS = ['#d38cff', '#ff8cc6', '#8cf2ff', '#ffd08c'];

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
  return out;
}
// 曲線の、キーの値と、フレーム f の値
const keyValue = (c: CurveDef, key: BoneKey | MorphKey) => (c.comp ? (key as BoneKey).v[c.comp] : (key as MorphKey).v) * c.k;
function valueAt(c: CurveDef, ev: ReturnType<typeof evaluate>) {
  if (c.ch.kind === 'prop') return ev.props.get(c.ch.index);
  if (c.ch.kind === 'morph') return ev.morphs.get(c.ch.index);
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
  const drag = useRef<{ curve: CurveDef; frame: number } | { scrub: number } | null>(null);
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
      for (const [f, key] of keys ?? []) {
        const px = x(f), py = y((keyValue(c, key) - n.mid) / n.half);
        if (px < -HIT || px > W + HIT) continue;
        const d = drag.current;
        const active = d && 'curve' in d && d.curve.id === c.id && d.frame === f;
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
    if (best) {
      drag.current = { curve: best.curve, frame: best.frame };
      clock.seekFrame(best.frame, 5);
      draw();
      return;
    }
    const f = frameAtView(v, x, W);
    drag.current = { scrub: f };
    clock.seekFrame(f, 5);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const { x, y, W, H } = local(e);
    if ('curve' in d) {
      const n = norm.current.get(d.curve.id) ?? { mid: 0, half: 1 };
      engine.setKeyValue(d.curve.ch, d.frame, d.curve.comp, (n.mid + toValue(y, H) * n.half) / d.curve.k);
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
        <canvas ref={canvasRef} className="graph-canvas" aria-label={t('グラフエディター (キーの点を上下にドラッグで値を変える)')}
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
