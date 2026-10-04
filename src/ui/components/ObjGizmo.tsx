import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import * as THREE from 'three';
import { t } from '../../core/i18n';
import type { Obj } from '../../engine/types';
import { useEngine, useUi } from '../EngineContext';

// --- ライト・カメラのギズモ (Blender のライトのパワー・カメラの焦点距離のギズモ) ---
// ライトかカメラをアクティブにしていると、ビューポートの目印のそばに取っ手を出す。
// 左右にドラッグして、ライトはパワー (サンは強さ) を、カメラは視野角を変える (Shift で細かく、Esc でやめる)。
// 取っ手の位置は、描くたびに目印の位置に合わせる
const v = new THREE.Vector3();

export function ObjGizmo() {
  const engine = useEngine();
  const sel = useUi(s => s.sel);
  const poseMode = useUi(s => s.poseMode);
  const transform = useUi(s => s.transform);
  const ref = useRef<HTMLDivElement>(null);
  const kind = sel?.kind === 'light' ? 'light' : sel?.kind === 'camera' ? 'camera' : null;
  const show = !!kind && !poseMode && !transform;

  // 描いたあと: 目印の画面の位置へ動かす (後ろにあれば隠す)
  useEffect(() => {
    if (!show) return;
    const place = () => {
      const el = ref.current, o = engine.selection.current, canvas = engine.viewport.canvas;
      if (!el || !o || !canvas || !(o.light || o.camera)) return;
      o.node.getWorldPosition(v).project(engine.graph.camera);
      const behind = v.z > 1 || Math.abs(v.x) > 1.2 || Math.abs(v.y) > 1.2;
      el.style.visibility = behind || o.hidden || o.colHidden ? 'hidden' : '';
      el.style.left = `${(v.x + 1) / 2 * canvas.clientWidth}px`;
      el.style.top = `${(1 - v.y) / 2 * canvas.clientHeight}px`;
    };
    place();
    return engine.viewport.onRender(place);
  }, [engine, show, sel?.id]);

  if (!show || !sel) return null;
  const light = sel.light, cam = sel.camera;
  const sun = light?.type === 'sun';
  const label = light ? (sun ? t('強さ') : t('パワー')) : t('視野角');
  const text = light ? (sun ? `${light.strength.toFixed(2)} W/m²` : `${Math.round(light.power)} W`) : `${Math.round(cam?.fov ?? 0)}°`;

  // ドラッグ: 右へで強く (広く)。ライトは掛け算 (100px で 2 倍強)、カメラは 1px で 0.2°
  const onDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const o = engine.selection.current;
    if (e.button !== 0 || !o) return;
    e.preventDefault();
    e.stopPropagation();
    const btn = e.currentTarget;
    btn.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const start = { power: o.light?.power ?? 0, strength: o.light?.strength ?? 0, fov: o.camera?.fov ?? 0 };
    engine.history.checkpoint();
    const apply = (dx: number, fine: boolean) => {
      const k = fine ? 0.1 : 1;
      if (o.light) {
        const f = Math.pow(2, dx * k / 100);
        engine.setLight(o.light.type === 'sun' ? { strength: Math.min(start.strength * f || dx * k * 0.01, 1000) } : { power: Math.min(start.power * f || dx * k, 1e6) });
      } else engine.setCamera({ fov: Math.min(Math.max(start.fov + dx * k * 0.2, 5), 150) });
      engine.viewport.requestDraw();
    };
    const restore = () => { if (o.light) engine.setLight({ power: start.power, strength: start.strength }); else engine.setCamera({ fov: start.fov }); };
    const move = (ev: PointerEvent) => apply(ev.clientX - x0, ev.shiftKey);
    const key = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.stopPropagation(); restore(); end(); } };
    const end = () => {
      btn.removeEventListener('pointermove', move);
      btn.removeEventListener('pointerup', end);
      btn.removeEventListener('pointercancel', end);
      removeEventListener('keydown', key, true);
      engine.history.soon();
    };
    btn.addEventListener('pointermove', move);
    btn.addEventListener('pointerup', end);
    btn.addEventListener('pointercancel', end);
    addEventListener('keydown', key, true);
  };

  return (
    <div className={`obj-gizmo ${kind}`} ref={ref}>
      <button type="button" className="obj-gizmo-handle" aria-label={t('{what} (左右にドラッグ)', { what: label })} title={t('{what} (左右にドラッグ)', { what: label })}
              onPointerDown={onDown} onKeyDown={e => onKeyStep(e, engine.selection.current)} />
      <span className="obj-gizmo-value">{text}</span>
    </div>
  );

  // キーボード: ←→ で少しずつ (Shift で大きく)
  function onKeyStep(e: ReactKeyboardEvent, o: Obj | null) {
    if (!o || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    e.preventDefault();
    e.stopPropagation();
    const d = (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 5 : 1);
    if (o.light) {
      const f = Math.pow(1.1, d);
      engine.setLight(o.light.type === 'sun' ? { strength: Math.max(o.light.strength * f, d > 0 ? 0.01 : 0) } : { power: Math.max(o.light.power * f, d > 0 ? 1 : 0) });
    } else if (o.camera) engine.setCamera({ fov: Math.min(Math.max(o.camera.fov + d, 5), 150) });
    engine.viewport.requestDraw();
  }
}
