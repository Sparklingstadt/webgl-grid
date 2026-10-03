import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { t } from '../../core/i18n';
import { fitView, frameAt as frameAtView, rulerStep, zoomView } from '../../core/timelineMath';
import { useEngine, useUi } from '../EngineContext';
import { NumField } from './NumField';

// Blender のタイムライン: 上の目盛りで再生位置 (青い再生ヘッド) を動かし、下にキーフレームの ◆ を並べる。
// ◆ はクリックで選び (Shift で追加)、左右にドラッグでずらす。ホイールで拡大縮小、Shift+ホイールで左右に動かす。
// 「チャンネル」を押すと、選んでいる物の行の下にチャンネル (ボーン・表情、形・ライトは位置・回転・大きさ) ごとの行を出す (左端の名前の上でホイールすると上下に動く)
// ドープシート (dopesheet) では、選んでいる物だけでなく、キーかモーションのある物すべての行を並べる。
// ほかの物の ◆ を押すと、その物を選んでからキーを選ぶ (アクティブな物の行は少し明るい)
const RULER = 24, ROW_Y = RULER + 6, ROW_H = 22, KEY_R = 6, LABEL_W = 140;

export function Timeline({ open, typeSelect, mode = 'timeline' }: { open: boolean; typeSelect: React.ReactNode; mode?: 'timeline' | 'dopesheet' }) {
  const all = mode === 'dopesheet';
  const engine = useEngine();
  const { clock } = engine;
  const frame = useUi(s => s.frame);
  const playing = useUi(s => s.playing);
  const start = useUi(s => s.start);
  const end = useUi(s => s.end);
  const keysVersion = useUi(s => s.keysVersion);
  const canKey = useUi(s => !!s.sel); // (キーを打てる物を選んでいる)
  const lang = useUi(s => s.lang); // (言語を変えたら、キャンバスの文字も描き直す)
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // 見えている範囲 (フレーム)。自分で拡大・移動するまでは、開始〜終了がちょうど入るように合わせる
  const view = useRef({ f0: -10, f1: 260, user: false });
  const keyDrag = useRef<{ x: number; delta: number } | null>(null);
  const scrollRows = useRef(0); // 上に隠れている行の数
  const expanded = engine.keyframes.expanded; // (切り替えると keysVersion が進むので、描き直される)
  const scrub = useRef<number | null>(null);
  const state = useRef({ frame, start, end });
  useLayoutEffect(() => { state.current = { frame, start, end }; }, [frame, start, end]); // (描くときに読む)

  const fit = useCallback(() => {
    const { start, end } = state.current;
    view.current = { ...fitView(start, end), user: false };
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    if (!W || !H) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const { frame, start, end } = state.current;
    const v = view.current;
    const ppf = W / (v.f1 - v.f0); // 1 フレームの幅 (px)
    const x = (f: number) => (f - v.f0) * ppf;
    ctx.fillStyle = '#282828';
    ctx.fillRect(0, 0, W, H);
    // 開始〜終了の外は暗くする
    ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
    ctx.fillRect(0, RULER, Math.max(x(start), 0), H);
    ctx.fillRect(x(end), RULER, W, H);
    // 目盛り: 数字の間隔が 50px 以上になる、きりのいい間隔
    const step = rulerStep(ppf);
    ctx.fillStyle = '#2e2e2e';
    ctx.fillRect(0, 0, W, RULER);
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let f = Math.ceil(v.f0 / step) * step; f <= v.f1; f += step) {
      const px = Math.round(x(f)) + 0.5;
      ctx.fillStyle = '#353535';
      ctx.fillRect(px - 0.5, RULER, 1, H - RULER);
      ctx.fillStyle = '#a8a8a8';
      ctx.fillText(String(f), px, RULER / 2);
    }
    // 行: 選んでいる物 (キーフレームとモーション)・チャンネルとカメラ (はみ出す分は上下に動かして見る)
    const list = engine.timelineRows(all);
    const fit = Math.max(Math.floor((H - ROW_Y) / ROW_H), 1);
    scrollRows.current = Math.min(Math.max(scrollRows.current, 0), Math.max(list.length - fit, 0));
    const rows = list.slice(scrollRows.current);
    const selKeys = engine.keyframes.selected;
    const kd = keyDrag.current;
    const diamond = (cx: number, cy: number, r: number) => {
      ctx.beginPath();
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r, cy);
      ctx.lineTo(cx, cy + r);
      ctx.lineTo(cx - r, cy);
      ctx.closePath();
    };
    rows.forEach((row, i) => {
      const y = ROW_Y + i * ROW_H, cy = y + ROW_H / 2;
      ctx.fillStyle = row.channel ? 'rgba(0, 0, 0, 0.12)' : i % 2 ? 'rgba(255, 255, 255, 0.025)' : 'rgba(255, 255, 255, 0.045)';
      ctx.fillRect(0, y, W, ROW_H);
      if (all && row.active && !row.channel) { ctx.fillStyle = 'rgba(71, 114, 179, 0.18)'; ctx.fillRect(0, y, W, ROW_H); }
      // モーション (VMD) のキーフレームは小さな灰色の ◆ (編集はできない)
      if (row.motion) {
        ctx.fillStyle = '#8a8a8a';
        let last = -Infinity;
        for (const f of row.motion) {
          const px = x(f);
          if (px < -4 || px > W + 4 || px - last < 1.5) continue; // 重なるほど詰まっている所は間引く
          last = px;
          diamond(px, cy, 3.5);
          ctx.fill();
        }
      }
      for (const f of row.keys) {
        const sel = row.active !== false && selKeys.has(f); // (キーの選択は、アクティブな物の)
        const px = x(f + (sel && kd ? kd.delta : 0));
        if (px < -KEY_R || px > W + KEY_R) continue;
        diamond(px, cy, row.channel ? KEY_R - 1.5 : KEY_R);
        ctx.fillStyle = sel ? '#ffbe33' : '#e8e8e8';
        ctx.fill();
        ctx.strokeStyle = '#111';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.fillStyle = row.channel ? 'rgba(200, 200, 200, 0.5)' : 'rgba(230, 230, 230, 0.55)';
      ctx.textAlign = 'left';
      ctx.fillText(row.label, row.channel ? 18 : 6, cy);
      ctx.textAlign = 'center';
    });
    if (list.length > fit) {
      // 上下に動かせることを、右端の細いつまみで見せる
      const trackH = H - ROW_Y, h = Math.max(trackH * fit / list.length, 12);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
      ctx.fillRect(W - 4, ROW_Y + (trackH - h) * scrollRows.current / (list.length - fit), 3, h);
    }
    if (!rows.length) {
      ctx.fillStyle = 'rgba(230, 230, 230, 0.4)';
      ctx.textAlign = 'left';
      ctx.fillText(all ? t('キーかモーションのある物が、ここに並びます (物を選んで I でキーを打つ)') : t('物を選ぶと、キーフレームとモーションがここに並びます'), 8, ROW_Y + ROW_H / 2);
    }
    // 再生ヘッド: 青い縦線と、目盛りの上の番号札
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
  }, [engine, all]);

  // 開始・終了が変わったら合わせ直す (自分で拡大・移動していなければ)
  useEffect(() => { if (!view.current.user) fit(); draw(); }, [start, end, fit, draw]);
  useEffect(() => { draw(); }, [frame, keysVersion, canKey, open, expanded, lang, draw]);
  useEffect(() => {
    const canvas = canvasRef.current!;
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    // ホイール: 拡大縮小 (カーソルの位置を中心に)。Shift か横スクロールで左右に動かす
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = view.current, W = canvas.clientWidth, span = v.f1 - v.f0;
      // 左端の名前の上: 行を上下に動かす
      if (e.clientX - canvas.getBoundingClientRect().left < LABEL_W && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        scrollRows.current += Math.sign(e.deltaY);
        draw();
        return;
      }
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const d = (e.shiftKey ? e.deltaY : e.deltaX) / W * span;
        v.f0 += d; v.f1 += d;
      } else {
        const r = canvas.getBoundingClientRect();
        const at = v.f0 + (e.clientX - r.left) / W * span;
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
    return { x: e.clientX - r.left, y: e.clientY - r.top, W: r.width };
  };
  const frameAt = (x: number, W: number) => frameAtView(view.current, x, W);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const { x, y, W } = local(e);
    canvasRef.current!.setPointerCapture(e.pointerId);
    // ◆ を押したら選んでドラッグ。それ以外は再生位置を動かす
    if (y > ROW_Y) {
      const rows = engine.timelineRows(all);
      const i = Math.floor((y - ROW_Y) / ROW_H) + scrollRows.current;
      const row = rows[i];
      // (ドープシート: ほかの物の行を押したら、その物を選ぶ)
      if (row?.objId !== undefined && !row.active) {
        engine.selectById(row.objId);
        engine.selectKeys([], false);
        row.active = true;
      }
      if (row?.editable) {
        const ppf = W / (view.current.f1 - view.current.f0);
        let hit: number | null = null, best = KEY_R + 2;
        for (const f of row.keys) {
          const d = Math.abs((f - view.current.f0) * ppf - x);
          if (d <= best) { best = d; hit = f; }
        }
        if (hit !== null) {
          if (e.shiftKey || !engine.keyframes.selected.has(hit)) engine.selectKeys([hit], e.shiftKey);
          // チャンネルの ◆: そのボーンを選んで、そのフレームへ (サイドバーで補間曲線を変えられる)
          if (row.channel) {
            if (row.channel.kind === 'bone') engine.setBoneSel(row.channel.index);
            clock.seekFrame(hit, 5);
          }
          keyDrag.current = { x, delta: 0 };
          draw();
          return;
        }
        if (!e.shiftKey && engine.keyframes.selected.size) engine.selectKeys([], false);
      }
    }
    scrub.current = frameAt(x, W);
    clock.seekFrame(scrub.current, 5);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const { x, W } = local(e);
    if (keyDrag.current) {
      const delta = Math.round((x - keyDrag.current.x) / (W / (view.current.f1 - view.current.f0)));
      if (delta !== keyDrag.current.delta) { keyDrag.current.delta = delta; draw(); }
    } else if (scrub.current !== null) {
      const f = frameAt(x, W);
      if (f !== scrub.current) { scrub.current = f; clock.seekFrame(f, 5); }
    }
  };
  const onPointerUp = () => {
    if (keyDrag.current) {
      const { delta } = keyDrag.current;
      keyDrag.current = null;
      if (delta) engine.moveSelectedKeys(delta); else draw();
    }
    if (scrub.current !== null) {
      clock.seekFrame(scrub.current); // 離したら、物理演算もその姿勢になじませる
      scrub.current = null;
    }
  };

  return (
    <>
      <div className="area-header tl-header">
        {typeSelect}
        <div className="grp">
          <button type="button" className="hbtn" disabled={!canKey} onClick={() => engine.insertKey()}
                  title={t('選んだ物のいまの値 (モデルはポーズと表情、形・ライトは位置・回転・大きさ) を、このフレームのキーフレームにする (I)')}>◆ {t('キー挿入')}</button>
          <button type="button" className="hbtn" disabled={!canKey} onClick={() => engine.deleteSelectedKeys()}
                  title={t('選んだキーフレームを削除 (タイムライン上で X)')}>{t('キー削除')}</button>
          <button type="button" className="hbtn" disabled={!canKey} aria-pressed={expanded} onClick={() => engine.keyframes.setExpanded(!expanded)}
                  title={t('チャンネル (ボーン・表情・位置・回転・大きさ) ごとのキーの行を出す')}>{expanded ? '▾' : '▸'} {t('チャンネル')}</button>
        </div>
        <div className="transport" role="group" aria-label={t('再生')}>
          <button type="button" onClick={() => clock.jumpToStart()} title={t('最初のフレームへ (Shift ←)')} aria-label={t('最初のフレームへ')}>
            <svg viewBox="0 0 14 14" aria-hidden="true"><path d="M3 2v10M12 2 5 7l7 5z" fill="currentColor" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg>
          </button>
          <button type="button" onClick={() => engine.jumpKey(-1)} title={t('前のキーフレームへ (↓)')} aria-label={t('前のキーフレームへ')}>
            <svg viewBox="0 0 14 14" aria-hidden="true"><path d="M5.5 7l3-3 3 3-3 3z" fill="currentColor" /><path d="M4 3.5 1.5 7 4 10.5" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>
          </button>
          <button type="button" onClick={() => clock.togglePlay()} aria-pressed={playing} title={t('再生 / 停止 (Space)')} aria-label={playing ? t('停止') : t('再生')}>
            <svg viewBox="0 0 14 14" aria-hidden="true">
              {playing ? <path d="M3.5 2.5h2.5v9H3.5zM8 2.5h2.5v9H8z" fill="currentColor" /> : <path d="M3.5 2 12 7l-8.5 5z" fill="currentColor" />}
            </svg>
          </button>
          <button type="button" onClick={() => engine.jumpKey(1)} title={t('次のキーフレームへ (↑)')} aria-label={t('次のキーフレームへ')}>
            <svg viewBox="0 0 14 14" aria-hidden="true"><path d="M2.5 7l3-3 3 3-3 3z" fill="currentColor" /><path d="M10 3.5 12.5 7 10 10.5" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>
          </button>
          <button type="button" onClick={() => clock.jumpToEnd()} title={t('最後のフレームへ (Shift →)')} aria-label={t('最後のフレームへ')}>
            <svg viewBox="0 0 14 14" aria-hidden="true"><path d="M11 2v10M2 2l7 5-7 5z" fill="currentColor" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg>
          </button>
        </div>
        <div className="frames">
          <NumField id="tl-frame" label={t('いまのフレーム')} value={frame} min={0} onCommit={v => clock.seekFrame(v)} />
          <label><span className="lbl">{t('開始')}</span><NumField label={t('開始フレーム')} value={start} min={0} onCommit={v => clock.setRange(v, Math.max(end, v + 1))} /></label>
          <label><span className="lbl">{t('終了')}</span><NumField label={t('終了フレーム')} value={end} min={1} onCommit={v => clock.setRange(Math.min(start, v - 1), v)} /></label>
        </div>
      </div>
      <div className="tl-body">
        <canvas ref={canvasRef} id="tl-canvas" aria-label={t('タイムライン (ドラッグで再生位置を動かす)')}
                onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
                onDoubleClick={e => { if (local(e as unknown as React.PointerEvent).y < RULER) { fit(); draw(); } }} />
      </div>
    </>
  );
}
