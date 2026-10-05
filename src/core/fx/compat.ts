// 既知のエフェクトのソースのうち、MMD での見え方が D3D9 の振る舞いに頼っているものの書き換え表。
// デコードしたソースの文字列 (字句解析の前) に、すべてのファイルで当てる。1 つの規則は同じ行の中だけを書き換える
// (行を増やしも減らしもしない。診断の行番号がずれない)。
// 規則を足すのは、(1) MMD での絵の証拠 (スクリーンショットなど) があり、(2) 標準の HLSL どおりに読むと絵が壊れ、(3) 全体の
// 規則 (pow など) を変えると別の式まで変わってしまうとき。足すときは、どのエフェクトか・D3D9 の何が違うか・証拠を、規則の上に書く。

// Ray-MMD (Shader/PhaseFunctions.fxsub の ComputeWaveLengthMie。Time of day・Time of night・Fog/AtmosphericFog が使う)
// D3D9 では pow(lambda, U - 2) (lambda は光の波長 ≈ 5e-7) が lambda として働く (Mie 係数 ∝ K / λ)。HLSL どおりの K / λ² だと
// 係数が 1 /m ほどになり (物理的な値は 2e-5 /m)、空の光が全部吸われて真っ黒になる。
// 証拠: MMD のスクリーンショット (gaj-cg/ray-mmd-docs-ja の 7_5_TimeOfDay。青い空・太陽のまわりのもや・雲。K / λ² では黒、
// Mie = 0 ではもやと雲がない) と、同じ空を OpenGL に移した newpolaris/Atmospheric-Scattering (「DirectX 9 のバグで pow の
// 指数が極端に小さいと線形に働く」として K / λ に変えている)。
// (空白は [ \t] だけ: 行をまたぐ書き方には当てない)
const RAY_MMD_MIE = /(return[ \t]+mieConst[ \t]*\*[ \t]*K[ \t]*\/[ \t]*)pow[ \t]*\([ \t]*lambda[ \t]*,[ \t]*[A-Za-z_]\w*[ \t]*-[ \t]*2(?:\.0*)?f?[ \t]*\)/g;

export function applyCompat(text: string): string {
  return text.replace(RAY_MMD_MIE, '$1lambda');
}
