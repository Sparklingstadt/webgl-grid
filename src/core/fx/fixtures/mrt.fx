// COLOR0〜2 の 3 つに出す見本 (G バッファのような書き出し)
float4x4 WorldViewProjMatrix : WORLDVIEWPROJECTION;
float4x4 WorldMatrix         : WORLD;
float4   MaterialDiffuse     : DIFFUSE < string Object = "Geometry"; >;

struct VS_OUTPUT {
    float4 Pos    : POSITION;
    float3 Normal : TEXCOORD0;
    float3 Pos3   : TEXCOORD1;
};

struct PS_OUTPUT {
    float4 Albedo   : COLOR0;
    float4 Normal   : COLOR1;
    float4 Position : COLOR2;
};

VS_OUTPUT GBufferVS(float4 Pos : POSITION, float3 Normal : NORMAL)
{
    VS_OUTPUT Out;
    Out.Pos = mul(Pos, WorldViewProjMatrix);
    Out.Normal = mul(Normal, (float3x3)WorldMatrix);
    Out.Pos3 = mul(Pos, WorldMatrix).xyz;
    return Out;
}

PS_OUTPUT GBufferPS(VS_OUTPUT IN)
{
    PS_OUTPUT Out;
    Out.Albedo = MaterialDiffuse;
    Out.Normal = float4(normalize(IN.Normal) * 0.5 + 0.5, 1.0);
    Out.Position = float4(IN.Pos3, 1.0);
    return Out;
}

technique GBufferTec < string MMDPass = "object"; > {
    pass DrawObject {
        VertexShader = compile vs_3_0 GBufferVS();
        PixelShader  = compile ps_3_0 GBufferPS();
    }
}
