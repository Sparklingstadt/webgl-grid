import { t } from './i18n';

// .pmx の材質だけを書き換える (ほかの部分はバイト単位でそのまま残すので、MMD 本体でもそのまま読める)。
// PMX 2.0 / 2.1 の書式で、頂点・面・テクスチャを読み飛ばして材質の場所を探す

// 材質の書き換える値。色は .pmx に入っている値そのまま (0〜1)
export interface PmxMaterialValues {
  diffuse: [number, number, number, number]; // 拡散色と不透明度
  specular: [number, number, number];
  specularPower: number;
  ambient: [number, number, number];
  edge: boolean;                             // 描画フラグの「エッジ」(0x10)
  edgeColor: [number, number, number, number];
  edgeSize: number;
}
export interface PmxMaterialEntry { name: string; offset: number } // offset: 拡散色の位置 (バイト)

const EDGE_FLAG = 0x10;

class Reader {
  pos = 0;
  constructor(readonly view: DataView, private utf16: boolean) {}
  u8() { return this.view.getUint8(this.pos++); }
  i32() { const v = this.view.getInt32(this.pos, true); this.pos += 4; return v; }
  f32() { const v = this.view.getFloat32(this.pos, true); this.pos += 4; return v; }
  skip(n: number) { this.pos += n; }
  text() {
    const len = this.i32();
    const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + this.pos, len);
    this.pos += len;
    return new TextDecoder(this.utf16 ? 'utf-16le' : 'utf-8').decode(bytes);
  }
}

// 材質の名前と場所。.pmx でなければ例外
export function readPmxMaterials(buffer: ArrayBuffer): PmxMaterialEntry[] {
  const view = new DataView(buffer);
  if (String.fromCharCode(...new Uint8Array(buffer, 0, 4)) !== 'PMX ') throw new Error(t('.pmx ファイルではありません'));
  const globalsCount = view.getUint8(8);
  const g = Array.from(new Uint8Array(buffer, 9, globalsCount));
  const [encoding, addUv, vertexIndexSize, textureIndexSize, , boneIndexSize] = g;
  const r = new Reader(view, encoding === 0);
  r.pos = 9 + globalsCount;
  for (let i = 0; i < 4; i++) r.text(); // モデル名・英語名・コメント・英語コメント
  // 頂点: 位置・法線・UV・追加 UV、変形の種類ごとのボーンと重み、エッジ倍率
  const vertices = r.i32();
  for (let i = 0; i < vertices; i++) {
    r.skip(12 + 12 + 8 + 16 * addUv);
    const type = r.u8();
    if (type === 0) r.skip(boneIndexSize);                         // BDEF1
    else if (type === 1) r.skip(2 * boneIndexSize + 4);            // BDEF2
    else if (type === 2 || type === 4) r.skip(4 * boneIndexSize + 16); // BDEF4・QDEF
    else if (type === 3) r.skip(2 * boneIndexSize + 4 + 36);       // SDEF
    else throw new Error(t('頂点の変形の種類が分かりません ({type})', { type }));
    r.skip(4);
  }
  r.skip(r.i32() * vertexIndexSize); // 面
  const textures = r.i32();
  for (let i = 0; i < textures; i++) r.text();
  const count = r.i32();
  const materials: PmxMaterialEntry[] = [];
  for (let i = 0; i < count; i++) {
    const name = r.text();
    r.text();
    materials.push({ name, offset: r.pos });
    r.skip(16 + 12 + 4 + 12 + 1 + 16 + 4); // 拡散色・反射色・反射の強さ・環境色・描画フラグ・エッジ色・エッジサイズ
    r.skip(2 * textureIndexSize + 1);      // テクスチャ・スフィア・スフィアモード
    const sharedToon = r.u8();
    r.skip(sharedToon === 0 ? textureIndexSize : 1);
    r.text();                              // メモ
    r.skip(4);                             // 面の数
  }
  return materials;
}

// patches (材質の番号 → 値) を書き込んだ、新しい .pmx のバイト列
export function patchPmxMaterials(buffer: ArrayBuffer, patches: Map<number, PmxMaterialValues>): Uint8Array {
  const materials = readPmxMaterials(buffer);
  const out = new Uint8Array(buffer.slice(0));
  const view = new DataView(out.buffer);
  for (const [index, v] of patches) {
    const m = materials[index];
    if (!m) throw new Error(t('材質 {index} がありません', { index }));
    let p = m.offset;
    const f = (...xs: number[]) => { for (const x of xs) { view.setFloat32(p, x, true); p += 4; } };
    f(...v.diffuse, ...v.specular, v.specularPower, ...v.ambient);
    const flag = view.getUint8(p);
    view.setUint8(p, v.edge ? flag | EDGE_FLAG : flag & ~EDGE_FLAG);
    p += 1;
    f(...v.edgeColor, v.edgeSize);
  }
  return out;
}
