// 髪の形を保つ「錘」を見つける (物理演算の剛体と関節のつながりだけを見る計算)。
//
// MMD のモデルでは、髪の節ごとに、何ともぶつからない剛体を固定の関節で付けて、
// その重さの釣り合いで、重力の中でもモデルの作者が作った髪の形を保つことがある (錘)。
// 錘を外すと、髪は重力で垂れる。胸などほかの部分の錘は外さないよう、頭からぶら下がる鎖の中だけを探す

export interface RigBody {
  type: number;        // 0: ボーンに付いていく、1・2: 物理演算
  groupTarget: number; // ぶつかる相手のグループ (0 なら何ともぶつからない)
  boneIndex: number;
}
export interface RigJoint {
  a: number;           // 剛体の番号
  b: number;
  locked: boolean;     // 移動も回転も 0 から 0 まで (動かない)
}

const isWeightLike = (b: RigBody) => b.type !== 0 && b.groupTarget === 0;

// 錘の剛体の番号を返す。isHeadBone は、そのボーンが頭 (かその子孫) かどうか
export function findHairWeights(bodies: RigBody[], joints: RigJoint[], isHeadBone: (boneIndex: number) => boolean): number[] {
  const links = new Map<number, number[]>();
  const link = (x: number, y: number) => { links.set(x, [...(links.get(x) ?? []), y]); };
  for (const j of joints) { link(j.a, j.b); link(j.b, j.a); }

  // 頭に付いていく剛体から、関節でつながる物理演算の剛体をたどる。
  // 錘どうしをつなぐ補助の関節で別の部分へ渡らないよう、錘から先へはたどらない
  const roots = bodies.map((_, i) => i).filter(i => bodies[i].type === 0 && isHeadBone(bodies[i].boneIndex));
  const chain = new Set<number>();
  const queue = [...roots];
  while (queue.length) {
    const cur = queue.shift()!;
    if (chain.has(cur) && isWeightLike(bodies[cur])) continue;
    for (const n of links.get(cur) ?? []) {
      if (bodies[n].type === 0 || chain.has(n)) continue;
      chain.add(n);
      if (!isWeightLike(bodies[n])) queue.push(n);
    }
  }
  // 錘: 何ともぶつからず、髪の剛体に固定の関節で付いている
  return [...chain].filter(i => isWeightLike(bodies[i]) && joints.some(j =>
    j.locked && ((j.a === i && chain.has(j.b) && !isWeightLike(bodies[j.b])) || (j.b === i && chain.has(j.a) && !isWeightLike(bodies[j.a])))))
    .sort((x, y) => x - y);
}
