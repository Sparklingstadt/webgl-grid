// テスト用 (e2e・単体) の小さな PMX 2.0 モデルを組み立てる (配布の決まりがあるモデルをリポジトリに入れないため)。
// 高さ 20 (MMD の単位) の四角柱 1 本。ボーンは「センター」(移動・回転) と「右腕」(回転)、表情は「まばたき」(目)。
// physics を付けると、センターに付いていく剛体と、それに関節でぶら下がる右腕の剛体 (物理演算) を足す。
// さらに、頭から斜め外へ伸びる髪の剛体と、それを錘 (何ともぶつからない剛体を固定の関節で付けたもの) で
// 斜めのまま保つ仕組みを足す (錘を外すと、髪は重力で垂れる)
class Writer {
  private bytes: number[] = [];
  private view = new DataView(new ArrayBuffer(8));
  u8(v: number) { this.bytes.push(v & 0xff); }
  u16(v: number) { this.view.setUint16(0, v, true); this.push(2); }
  i32(v: number) { this.view.setInt32(0, v, true); this.push(4); }
  f32(...vs: number[]) { for (const v of vs) { this.view.setFloat32(0, v, true); this.push(4); } }
  // 文字列: バイト数 (int32) + UTF-16LE
  text(s: string) {
    this.i32(s.length * 2);
    for (const ch of s) { const c = ch.charCodeAt(0); this.u8(c); this.u8(c >> 8); }
  }
  private push(n: number) { for (let i = 0; i < n; i++) this.bytes.push(this.view.getUint8(i)); }
  build() { return new Uint8Array(this.bytes); }
}

// texture: 材質に付けるテクスチャのファイル名 (なければテクスチャなし)
// flags: 材質のフラグ (0x01 両面・0x02 地面の影・0x04 セルフシャドウの深度・0x08 セルフシャドウを受ける・0x10 輪郭線)
// sdef: 上の 4 頂点を SDEF (骨は センター・右腕) にする
// parts: 材質を分ける (材質ごとの面の頂点番号 3 つずつと、輪郭線の太さ。なければ全部の面で 1 つ)
// edgeRatios: 頂点ごとの輪郭線の太さの倍率 (なければ 1)
export interface PmxOptions {
  physics?: boolean;
  texture?: string;
  flags?: number;
  sdef?: boolean;
  parts?: { faces: number[]; edgeSize?: number }[];
  edgeRatios?: number[];
}
export function makePmx(name = 'テスト人形', { physics = false, texture, flags = 0x01 | 0x10, sdef = false, parts, edgeRatios }: PmxOptions = {}): Uint8Array {
  const w = new Writer();
  // ヘッダー: 文字コード UTF-16、追加 UV なし、インデックスはすべて 4 バイト
  for (const c of 'PMX ') w.u8(c.charCodeAt(0));
  w.f32(2.0);
  w.u8(8);
  for (const v of [0, 0, 4, 4, 4, 4, 4, 4]) w.u8(v);
  w.text(name); w.text('test doll'); w.text('e2e テスト用'); w.text('for e2e tests');

  // 頂点: 4×20×4 の四角柱。下の 4 つはセンター、上の 4 つは右腕に付ける
  const xs = [-2, 2, 2, -2], zs = [-2, -2, 2, 2];
  w.i32(8);
  for (const y of [0, 20]) {
    for (let i = 0; i < 4; i++) {
      w.f32(xs[i], y, zs[i]);            // 位置
      w.f32(xs[i] / 2, 0, zs[i] / 2);    // 法線 (だいたい外向き)
      w.f32(0, 0);                       // UV
      if (sdef && y) {
        // SDEF: 骨 2 つ・重み・C (右腕の関節)・R0・R1 (C の近く)
        w.u8(3); w.i32(0); w.i32(1); w.f32(0.5);
        w.f32(0, 15, 0); w.f32(xs[i], 17, zs[i]); w.f32(xs[i], 13, zs[i]);
      } else {
        w.u8(0);                         // BDEF1
        w.i32(y ? 1 : 0);                // ボーン
      }
      w.f32(edgeRatios?.[i + (y ? 4 : 0)] ?? 1); // 輪郭線の太さ (倍率)
    }
  }
  // 面: 側面 4 枚 + 上下 (両面表示にするので向きは気にしない)
  const allFaces = [0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7, 4, 5, 6, 4, 6, 7, 0, 2, 1, 0, 3, 2];
  const materials = parts ?? [{ faces: allFaces, edgeSize: 1 }];
  const faces = materials.flatMap(m => m.faces);
  w.i32(faces.length);
  for (const f of faces) w.i32(f);
  if (texture) { w.i32(1); w.text(texture); } else w.i32(0); // テクスチャ

  // 材質 (既定は 1 つ)
  w.i32(materials.length);
  for (const m of materials) {
    w.text('体'); w.text('body');
    w.f32(0.9, 0.7, 0.5, 1);   // 拡散色
    w.f32(0, 0, 0); w.f32(5);  // 反射色・強さ
    w.f32(0.4, 0.3, 0.2);      // 環境色
    w.u8(flags);               // 既定は両面表示・輪郭線あり
    w.f32(0, 0, 0, 1); w.f32(m.edgeSize ?? 1); // 輪郭線の色・太さ
    w.i32(texture ? 0 : -1); w.i32(-1); w.u8(0); // テクスチャ・スフィアなし
    w.u8(1); w.u8(0);          // 共有トゥーン 0
    w.text('');
    w.i32(m.faces.length);
  }

  // ボーン: フラグは 回転 0x02・移動 0x04・表示 0x08・操作 0x10
  const bone = (n: string, pos: number[], parent: number, flags: number) => {
    w.text(n); w.text('');
    w.f32(...pos);
    w.i32(parent);
    w.i32(0);         // 変形の順番
    w.u16(flags);
    w.f32(0, 1, 0);   // 先の位置 (オフセット)
  };
  w.i32(5);
  bone('センター', [0, 8, 0], -1, 0x02 | 0x04 | 0x08 | 0x10);
  bone('右腕', [0, 15, 0], 0, 0x02 | 0x08 | 0x10);
  // 頭・髪・髪の錘は、ボーンのタブの一覧 (とアウトライナー) には出さない (表示・操作のフラグなし)
  bone('頭', [0, 18, 0], 0, 0x02);
  bone('髪', [0, 18, 0], 2, 0x02);
  bone('髪錘', [-3, 9, 0], 3, 0x02);

  // 表情: まばたき (目)。上の頂点を少し下げる
  w.i32(1);
  w.text('まばたき'); w.text('blink');
  w.u8(2);   // 分類: 目
  w.u8(1);   // 頂点モーフ
  w.i32(4);
  for (let i = 4; i < 8; i++) { w.i32(i); w.f32(0, -2, 0); }

  // 表示枠: Root (センター)、表情 (まばたき)、腕 (右腕)
  w.i32(3);
  const frame = (n: string, special: number, items: [number, number][]) => {
    w.text(n); w.text(''); w.u8(special);
    w.i32(items.length);
    for (const [target, index] of items) { w.u8(target); w.i32(index); }
  };
  frame('Root', 1, [[0, 0]]);
  frame('表情', 1, [[1, 0]]);
  frame('腕', 0, [[0, 1]]);

  if (!physics) {
    w.i32(0); // 剛体なし
    w.i32(0); // ジョイントなし
    return w.build();
  }
  // 剛体: 位置はモデルの座標 (ボーンからの相対ではない)
  const body = (n: string, bone: number, group: number, mask: number, radius: number, pos: number[], type: number) => {
    w.text(n); w.text('');
    w.i32(bone);
    w.u8(group); w.u16(mask);
    w.u8(0); w.f32(radius, 0, 0); // 球
    w.f32(...pos); w.f32(0, 0, 0);
    w.f32(1);                      // 質量
    w.f32(0.5, 0.5, 0, 0.5);       // 移動・回転の減衰、反発、摩擦
    w.u8(type);                    // 0: ボーンに付いていく、1: 物理演算
  };
  w.i32(5);
  body('センター剛体', 0, 0, 0xffff, 1, [0, 8, 0], 0);
  body('右腕剛体', 1, 1, 0, 0.5, [0, 17, 0], 1); // 何ともぶつからない
  body('頭剛体', 2, 0, 0, 1, [0, 18, 0], 0);
  // 髪は頭から 45° 外へ。ぶつかる相手はグループ 15 だけ (いないので、何ともぶつからないが錘ではない)
  body('髪剛体', 3, 2, 0x8000, 0.5, [3, 15, 0], 1);
  // 錘は、髪と合わせた重心が頭の真下に来る所に置く (だから髪は斜めのまま釣り合う)
  body('髪錘', 4, 3, 0, 0.5, [-3, 9, 0], 1);
  const joint = (n: string, a: number, b: number, pos: number[], rot: number) => {
    w.text(n); w.text('');
    w.u8(0);
    w.i32(a); w.i32(b);
    w.f32(...pos); w.f32(0, 0, 0);
    w.f32(0, 0, 0); w.f32(0, 0, 0);       // 移動はしない
    w.f32(-rot, -rot, -rot); w.f32(rot, rot, rot);
    w.f32(0, 0, 0); w.f32(0, 0, 0);       // ばねなし
  };
  w.i32(3);
  joint('右腕関節', 0, 1, [0, 15, 0], 0.5); // 右腕の剛体をセンターの剛体に、少しだけ回るようにつなぐ
  joint('髪関節', 2, 3, [0, 18, 0], 0.6);   // 髪を頭に、0.6 ラジアンまで回るようにつなぐ
  joint('髪錘関節', 3, 4, [3, 15, 0], 0);   // 錘を髪に固定する
  return w.build();
}
