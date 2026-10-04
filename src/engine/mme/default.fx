// webgl-grid の既定のエフェクト。.fx を割り当てていない物を、MMD の標準の描き方に近い形で描く
// (object・object_ss・zplot・shadow・edge)。MME の決まりで渡される値だけを使う

// --- 行列 ---
float4x4 WvpMatrix      : WORLDVIEWPROJECTION;
float4x4 WorldMatrix    : WORLD;
float4x4 ViewMatrix     : VIEW;
float4x4 LightWvpMatrix : WORLDVIEWPROJECTION < string Object = "Light"; >; // セルフシャドウの深度マップのカメラ

// --- ライトとカメラ ---
float3 LightDirection : DIRECTION < string Object = "Light"; >;
float3 LightDiffuse   : DIFFUSE   < string Object = "Light"; >; // MME の決まりで 0
float3 LightAmbient   : AMBIENT   < string Object = "Light"; >;
float3 LightSpecular  : SPECULAR  < string Object = "Light"; >;
float3 CameraPosition : POSITION  < string Object = "Camera"; >;

// --- 材質 ---
float4 MatDiffuse     : DIFFUSE       < string Object = "Geometry"; >;
float3 MatAmbient     : AMBIENT       < string Object = "Geometry"; >;
float3 MatEmissive    : EMISSIVE      < string Object = "Geometry"; >;
float3 MatSpecular    : SPECULAR      < string Object = "Geometry"; >;
float  MatPower       : SPECULARPOWER < string Object = "Geometry"; >;
float3 MatToonColor   : TOONCOLOR;
float4 MatEdgeColor   : EDGECOLOR;
float4 MatGroundColor : GROUNDSHADOWCOLOR;
bool   spadd; // スフィアマップが加算

static float4 DiffuseColor  = MatDiffuse * float4(LightDiffuse, 1.0); // アルファだけが効く
static float3 BaseColor     = saturate(MatAmbient * LightAmbient + MatEmissive);
static float3 SpecularColor = MatSpecular * LightSpecular;

// 影の中かを比べるときに、深度から引く量 (自分の面に影が落ちないように)
static const float ShadowBias = 0.001;

// --- テクスチャ ---
texture MatTexture : MATERIALTEXTURE;
sampler MatTexSampler = sampler_state {
    texture = <MatTexture>;
    MINFILTER = LINEAR; MAGFILTER = LINEAR;
};
texture MatSphere : MATERIALSPHEREMAP;
sampler MatSphereSampler = sampler_state {
    texture = <MatSphere>;
    MINFILTER = LINEAR; MAGFILTER = LINEAR;
};
texture MatToon : MATERIALTOONTEXTURE;
sampler MatToonSampler = sampler_state {
    texture = <MatToon>;
    MINFILTER = LINEAR; MAGFILTER = LINEAR;
    ADDRESSU = CLAMP; ADDRESSV = CLAMP;
};
// セルフシャドウの深度マップ (R に z / w)。MMD が s0 に入れる
sampler DefSampler : register(s0);

// --- 本体 (object・object_ss) ---
struct ObjectOut {
    float4 Pos      : POSITION;
    float2 Tex      : TEXCOORD0;
    float3 Normal   : TEXCOORD1;
    float3 ToEye    : TEXCOORD2;
    float2 SphereUv : TEXCOORD3;
    float4 LightPos : TEXCOORD4; // ライトのカメラから見た位置
    float4 Color    : COLOR0;
};

ObjectOut Object_VS(float4 Pos : POSITION, float3 Normal : NORMAL, float2 Tex : TEXCOORD0)
{
    ObjectOut o = (ObjectOut)0;
    o.Pos = mul(Pos, WvpMatrix);
    float3 n = normalize(mul(Normal, (float3x3)WorldMatrix));
    o.Normal = n;
    o.ToEye = CameraPosition - mul(Pos, WorldMatrix).xyz;
    o.Tex = Tex;
    // スフィアマップは視点から見た法線の xy で引く (v は下向き)
    float2 nv = mul(n, (float3x3)ViewMatrix).xy;
    o.SphereUv = float2(nv.x * 0.5 + 0.5, nv.y * -0.5 + 0.5);
    o.LightPos = mul(Pos, LightWvpMatrix);
    o.Color = float4(BaseColor, DiffuseColor.a);
    return o;
}

// 1 は日なた、0 は影の中。深度マップの外は日なた
float SelfShadowLit(float4 lightPos)
{
    float2 uv = float2(lightPos.x / lightPos.w * 0.5 + 0.5, lightPos.y / lightPos.w * -0.5 + 0.5);
    float depth = lightPos.z / lightPos.w;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || depth > 1.0) return 1.0;
    float stored = tex2D(DefSampler, uv).r;
    return depth - ShadowBias > stored ? 0.0 : 1.0;
}

float4 Object_PS(ObjectOut IN, uniform bool useTexture, uniform bool useSphereMap, uniform bool useToon, uniform bool selfShadow) : COLOR0
{
    float3 n = normalize(IN.Normal);
    float4 color = IN.Color;
    if (useTexture) color *= tex2D(MatTexSampler, IN.Tex);
    if (useSphereMap) {
        float3 sphere = tex2D(MatSphereSampler, IN.SphereUv).rgb;
        if (spadd) color.rgb += sphere;
        else color.rgb *= sphere;
    }
    // トゥーン: 光の当たる側はテクスチャの上 (明るい側)、裏は下 (TOONCOLOR の側)
    float3 toon = float3(1.0, 1.0, 1.0);
    if (useToon) toon = tex2D(MatToonSampler, float2(0.0, 0.5 - dot(n, -LightDirection) * 0.5)).rgb;
    if (selfShadow) {
        if (SelfShadowLit(IN.LightPos) < 0.5) toon = MatToonColor;
    }
    color.rgb *= toon;
    // 反射 (半ベクトルと法線)。pow の底が 0 にならないよう少しだけ持ち上げる
    float3 h = normalize(normalize(IN.ToEye) - LightDirection);
    color.rgb += pow(max(0.00001, dot(h, n)), MatPower) * SpecularColor;
    return color;
}

#define OBJECT_TECHNIQUE(name, mmdPass, tex, sphere, toonOn, ss) \
technique name < string MMDPass = mmdPass; bool UseTexture = tex; bool UseSphereMap = sphere; bool UseToon = toonOn; > { \
    pass DrawObject { \
        AlphaBlendEnable = TRUE; SrcBlend = SRCALPHA; DestBlend = INVSRCALPHA; \
        VertexShader = compile vs_3_0 Object_VS(); \
        PixelShader  = compile ps_3_0 Object_PS(tex, sphere, toonOn, ss); \
    } \
}

OBJECT_TECHNIQUE(ObjectTec0, "object", false, false, false, false)
OBJECT_TECHNIQUE(ObjectTec1, "object", true,  false, false, false)
OBJECT_TECHNIQUE(ObjectTec2, "object", false, true,  false, false)
OBJECT_TECHNIQUE(ObjectTec3, "object", true,  true,  false, false)
OBJECT_TECHNIQUE(ObjectTec4, "object", false, false, true,  false)
OBJECT_TECHNIQUE(ObjectTec5, "object", true,  false, true,  false)
OBJECT_TECHNIQUE(ObjectTec6, "object", false, true,  true,  false)
OBJECT_TECHNIQUE(ObjectTec7, "object", true,  true,  true,  false)

OBJECT_TECHNIQUE(ObjectSsTec0, "object_ss", false, false, false, true)
OBJECT_TECHNIQUE(ObjectSsTec1, "object_ss", true,  false, false, true)
OBJECT_TECHNIQUE(ObjectSsTec2, "object_ss", false, true,  false, true)
OBJECT_TECHNIQUE(ObjectSsTec3, "object_ss", true,  true,  false, true)
OBJECT_TECHNIQUE(ObjectSsTec4, "object_ss", false, false, true,  true)
OBJECT_TECHNIQUE(ObjectSsTec5, "object_ss", true,  false, true,  true)
OBJECT_TECHNIQUE(ObjectSsTec6, "object_ss", false, true,  true,  true)
OBJECT_TECHNIQUE(ObjectSsTec7, "object_ss", true,  true,  true,  true)

// --- セルフシャドウの深度マップ (zplot) ---
struct ZPlotOut {
    float4 Pos      : POSITION;
    float4 LightPos : TEXCOORD0;
};

ZPlotOut ZPlot_VS(float4 Pos : POSITION)
{
    ZPlotOut o;
    o.Pos = mul(Pos, LightWvpMatrix);
    o.LightPos = o.Pos;
    return o;
}

float4 ZPlot_PS(float4 LightPos : TEXCOORD0) : COLOR0
{
    return float4(LightPos.z / LightPos.w, 0.0, 0.0, 1.0);
}

technique ZPlotTec < string MMDPass = "zplot"; > {
    pass ZValuePlot {
        AlphaBlendEnable = FALSE;
        VertexShader = compile vs_3_0 ZPlot_VS();
        PixelShader  = compile ps_3_0 ZPlot_PS();
    }
}

// --- 地面の影 (shadow)。WORLD に地面へ潰す行列が入っている ---
float4 Shadow_VS(float4 Pos : POSITION) : POSITION
{
    return mul(Pos, WvpMatrix);
}

float4 Shadow_PS() : COLOR0
{
    return MatGroundColor;
}

technique ShadowTec < string MMDPass = "shadow"; > {
    pass DrawShadow {
        AlphaBlendEnable = TRUE; SrcBlend = SRCALPHA; DestBlend = INVSRCALPHA;
        VertexShader = compile vs_3_0 Shadow_VS();
        PixelShader  = compile ps_3_0 Shadow_PS();
    }
}

// --- 輪郭線 (edge)。頂点は法線の向きに広げてある。裏の面だけを描く ---
float4 Edge_VS(float4 Pos : POSITION) : POSITION
{
    return mul(Pos, WvpMatrix);
}

float4 Edge_PS() : COLOR0
{
    return MatEdgeColor;
}

technique EdgeTec < string MMDPass = "edge"; > {
    pass DrawEdge {
        CullMode = CW;
        VertexShader = compile vs_3_0 Edge_VS();
        PixelShader  = compile ps_3_0 Edge_PS();
    }
}
