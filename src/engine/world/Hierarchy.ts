import type { Obj } from '../types';
import type { World } from './World';

// --- 親子付け (Blender の Ctrl+P) ---
// 子は自分の位置・向き (場面での値) を持ったまま、親が動いた・回った分だけ一緒に動く。
// 親の前の位置 (parentPose) を覚えておき、変わったら、その動きを子に当てる (子を自分で動かしても、そのまま付いてくる)。
// 親が消えている (元に戻すで戻ってくるかもしれない) あいだは、付けたまま動かさない
export class Hierarchy {
  constructor(private world: World) {}

  parentOf(o: Obj) { return o.parent === undefined ? null : this.world.find(o.parent); }
  children(o: Obj) { return this.world.objects.filter(c => c.parent === o.id); }
  // 親にできるか (自分自身・自分の子孫は親にできない)
  canParent(child: Obj, parent: Obj) {
    for (let p: Obj | null = parent; p; p = this.parentOf(p)) if (p === child) return false;
    return true;
  }
  set(child: Obj, parent: Obj | null) {
    if (parent && !this.canParent(child, parent)) return false;
    child.parent = parent?.id;
    child.parentPose = parent ? { x: parent.x, z: parent.z, r: parent.r } : undefined;
    return true;
  }
  // 親の今の位置を覚え直す (元に戻した・開いたとき。子は動かさない)
  resetPoses() {
    for (const o of this.world.objects) {
      const p = this.parentOf(o);
      o.parentPose = p ? { x: p.x, z: p.z, r: p.r } : undefined;
    }
  }

  // 描く前: 親の動きを子に写す (親から順に)。動かした物があれば true
  follow() {
    const depth = (o: Obj) => { let d = 0; for (let p = this.parentOf(o); p && d < 64; p = this.parentOf(p)) d++; return d; };
    const kids = this.world.objects.filter(o => o.parent !== undefined).sort((a, b) => depth(a) - depth(b));
    let moved = false;
    for (const c of kids) {
      const p = this.parentOf(c);
      if (!p) { c.parentPose = undefined; continue; }
      const last = c.parentPose;
      c.parentPose = { x: p.x, z: p.z, r: p.r };
      if (!last || (last.x === p.x && last.z === p.z && last.r === p.r)) continue;
      // 前の親から見た位置にして、今の親から場面へ戻す
      const dx = c.x - last.x, dz = c.z - last.z;
      const lc = Math.cos(last.r), ls = Math.sin(last.r);
      const lx = dx * lc - dz * ls, lz = dx * ls + dz * lc;
      const nc = Math.cos(p.r), ns = Math.sin(p.r);
      c.x = p.x + lx * nc + lz * ns;
      c.z = p.z - lx * ns + lz * nc;
      c.r += p.r - last.r;
      moved = true;
    }
    return moved;
  }
}
