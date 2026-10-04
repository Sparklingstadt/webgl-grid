import { SKIN, type SkinData } from '../../core/mme/skinning.ts';

// 材質ごとの MME 用の情報。flags は PMX の材質のフラグ:
// 0x02 地面の影・0x04 セルフシャドウの深度に描く・0x08 セルフシャドウを受ける・0x10 輪郭線
export interface MmdMaterialInfo { flags: number; sphereMode: 0 | 1 | 2 | 3; edgeSize: number }
export interface MmdData {
  skin: SkinData;
  materials: MmdMaterialInfo[];
  // 頂点ごとの輪郭線の太さ。その頂点を最初に使う材質 (面の順) の太さ × 頂点の edgeRatio。どの面にも使われない頂点は 0
  vertexEdgeSize: Float32Array;
}

// .pmx を MMD のパーサーで読み直し (MMDLoader は SDEF・QDEF を BDEF に変えて、C・R0・R1 も捨てるので)、
// 変形・材質・輪郭線の情報を取り出す。座標は左手系のまま (leftToRight = false)
export async function readMmdData(pmx: Blob | ArrayBuffer): Promise<MmdData> {
  const buffer = pmx instanceof Blob ? await pmx.arrayBuffer() : pmx;
  const { MMDParser } = await import('../../vendor/three-mmd/mmdparser.module.js');
  const data = new MMDParser.Parser().parsePmx(buffer, false);
  const vertices: VertexData[] = data.vertices;
  const count = vertices.length;
  const skin: SkinData = {
    count,
    type: new Uint8Array(count),
    bones: new Int32Array(count * 4),
    weights: new Float32Array(count * 4),
    sdef: new Float32Array(count * 9),
  };
  for (let v = 0; v < count; v++) {
    const p = vertices[v];
    // パーサーは SDEF を BDEF2 (type 1) に書き換えるが、C・R0・R1 は残す
    skin.type[v] = p.skinC ? SKIN.SDEF : p.type === 4 ? SKIN.QDEF : p.type;
    for (let k = 0; k < p.skinIndices.length && k < 4; k++) {
      skin.bones[v * 4 + k] = Math.max(0, p.skinIndices[k]); // 使わない骨は -1
      skin.weights[v * 4 + k] = p.skinWeights[k];
    }
    if (p.skinC) {
      skin.sdef.set(p.skinC, v * 9);
      skin.sdef.set(p.skinR0!, v * 9 + 3);
      skin.sdef.set(p.skinR1!, v * 9 + 6);
    }
  }

  const pmxMaterials: { flag: number; envFlag: number; edgeSize: number; faceCount: number }[] = data.materials;
  const materials = pmxMaterials.map((m): MmdMaterialInfo => ({ flags: m.flag, sphereMode: m.envFlag as MmdMaterialInfo['sphereMode'], edgeSize: m.edgeSize }));

  // 頂点を最初に使う材質 (面は材質の順に並んでいる)
  const vertexEdgeSize = new Float32Array(count);
  const seen = new Uint8Array(count);
  const faces: { indices: number[] }[] = data.faces;
  let face = 0;
  for (const m of pmxMaterials) {
    for (const end = face + m.faceCount; face < end && face < faces.length; face++) {
      for (const i of faces[face].indices) {
        if (seen[i]) continue;
        seen[i] = 1;
        vertexEdgeSize[i] = m.edgeSize * vertices[i].edgeRatio;
      }
    }
  }
  return { skin, materials, vertexEdgeSize };
}

interface VertexData {
  type: number;
  skinIndices: number[];
  skinWeights: number[];
  skinC?: number[];
  skinR0?: number[];
  skinR1?: number[];
  edgeRatio: number;
}
