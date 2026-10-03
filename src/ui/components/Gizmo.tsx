import { useEffect, useRef, type MouseEvent } from 'react';
import * as THREE from 'three';
import { useEngine } from '../EngineContext';

// Blender のナビゲーションギズモ: いまの視点から見た X・Y・Z 軸の向き。軸の丸をクリックすると、その向きから見る。
// (このページは Y が上。地面の軸は X が赤、Z が青、上向きの Y が緑)
const SIZE = 84, R = 30;
const AXES = [
  { view: 'right', dir: [1, 0, 0], color: '#ff3352', label: 'X', pos: true },
  { view: 'left', dir: [-1, 0, 0], color: '#ff3352', label: '', pos: false },
  { view: 'top', dir: [0, 1, 0], color: '#8bdc00', label: 'Y', pos: true },
  { view: '', dir: [0, -1, 0], color: '#8bdc00', label: '', pos: false }, // 下からは見られない
  { view: 'front', dir: [0, 0, 1], color: '#2890ff', label: 'Z', pos: true },
  { view: 'back', dir: [0, 0, -1], color: '#2890ff', label: '', pos: false },
];

export function Gizmo() {
  const engine = useEngine();
  const ref = useRef<HTMLCanvasElement>(null);
  const hover = useRef({ inside: false, axis: -1 });
  const spots = useRef<{ x: number; y: number; z: number }[]>([]);
  const drawRef = useRef(() => {});

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext('2d')!;
    const v = new THREE.Vector3();
    const draw = drawRef.current = () => {
      const dpr = Math.min(devicePixelRatio || 1, 2);
      if (canvas.width !== SIZE * dpr) canvas.width = canvas.height = SIZE * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, SIZE, SIZE);
      const c = SIZE / 2, m = engine.camera.camera.matrixWorldInverse;
      if (hover.current.inside) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
        ctx.beginPath();
        ctx.arc(c, c, SIZE / 2 - 1, 0, Math.PI * 2);
        ctx.fill();
      }
      spots.current = AXES.map(a => {
        v.set(a.dir[0], a.dir[1], a.dir[2]).transformDirection(m);
        return { x: c + v.x * R, y: c - v.y * R, z: v.z };
      });
      // 奥から手前の順に描く
      const order = AXES.map((_, i) => i).sort((a, b) => spots.current[a].z - spots.current[b].z);
      for (const i of order) {
        const a = AXES[i], p = spots.current[i];
        if (a.pos) {
          ctx.strokeStyle = a.color;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(c, c);
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.arc(p.x, p.y, a.pos ? 8.5 : 7, 0, Math.PI * 2);
        ctx.fillStyle = a.pos ? a.color : `${a.color}55`;
        ctx.fill();
        if (!a.pos) { ctx.strokeStyle = a.color; ctx.lineWidth = 1.2; ctx.stroke(); }
        if (hover.current.axis === i && a.view) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke(); }
        if (a.label) {
          ctx.fillStyle = '#151515';
          ctx.font = 'bold 10px system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(a.label, p.x, p.y + 0.5);
        }
      }
    };
    draw();
    return engine.viewport.onRender(draw);
  }, [engine]);

  // 押した位置にある軸のうち、一番手前のもの
  const axisAt = (e: MouseEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    let best = -1, bestZ = -Infinity;
    spots.current.forEach((p, i) => {
      if (Math.hypot(p.x - x, p.y - y) <= 10 && p.z > bestZ) { best = i; bestZ = p.z; }
    });
    return best;
  };
  return (
    <canvas ref={ref} id="gizmo" role="img" aria-label="視点の向き (軸の丸をクリックするとその向きから見る)"
            onPointerMove={e => { hover.current = { inside: true, axis: axisAt(e) }; drawRef.current(); }}
            onPointerLeave={() => { hover.current = { inside: false, axis: -1 }; drawRef.current(); }}
            onClick={e => { const i = axisAt(e); if (i >= 0 && AXES[i].view) engine.camera.snapView(AXES[i].view); }} />
  );
}
