// MMD の標準のシェーダーに近い見本 (object と object_ss の 2 つの technique)
float4x4 WorldViewProjMatrix : WORLDVIEWPROJECTION;
float4x4 WorldMatrix         : WORLD;
float3   LightDirection      : DIRECTION < string Object = "Light"; >;
float4   MaterialDiffuse     : DIFFUSE  < string Object = "Geometry"; >;
float3   MaterialAmbient     : AMBIENT  < string Object = "Geometry"; >;
float3   LightDiffuse        : DIFFUSE  < string Object = "Light"; >;
float3   LightAmbient        : AMBIENT  < string Object = "Light"; >;
static float4 DiffuseColor  = MaterialDiffuse * float4(LightDiffuse, 1.0);
static float3 AmbientColor  = saturate(MaterialAmbient * LightAmbient + MaterialDiffuse.rgb);

texture ObjectTexture : MATERIALTEXTURE;
sampler ObjTexSampler = sampler_state {
    texture = <ObjectTexture>;
    MINFILTER = LINEAR;
    MAGFILTER = LINEAR;
    ADDRESSU = WRAP;
    ADDRESSV = WRAP;
};

struct VS_OUTPUT {
    float4 Pos    : POSITION;
    float2 Tex    : TEXCOORD1;
    float3 Normal : TEXCOORD2;
    float4 Color  : COLOR0;
};

VS_OUTPUT Basic_VS(float4 Pos : POSITION, float3 Normal : NORMAL, float2 Tex : TEXCOORD0)
{
    VS_OUTPUT Out = (VS_OUTPUT)0;
    Out.Pos = mul(Pos, WorldViewProjMatrix);
    Out.Normal = normalize(mul(Normal, (float3x3)WorldMatrix));
    Out.Tex = Tex;
    Out.Color.rgb = AmbientColor;
    Out.Color.a = DiffuseColor.a;
    return Out;
}

float4 Basic_PS(VS_OUTPUT IN, uniform bool useTexture) : COLOR0
{
    float4 Color = IN.Color;
    float lighting = saturate(dot(normalize(IN.Normal), -LightDirection));
    Color.rgb += DiffuseColor.rgb * lighting;
    if (useTexture) {
        Color *= tex2D(ObjTexSampler, IN.Tex);
    }
    return Color;
}

technique MainTec0 < string MMDPass = "object"; bool UseTexture = false; > {
    pass DrawObject {
        VertexShader = compile vs_3_0 Basic_VS();
        PixelShader  = compile ps_3_0 Basic_PS(false);
    }
}

technique MainTec1 < string MMDPass = "object_ss"; bool UseTexture = true; > {
    pass DrawObject {
        VertexShader = compile vs_3_0 Basic_VS();
        PixelShader  = compile ps_3_0 Basic_PS(true);
    }
}
