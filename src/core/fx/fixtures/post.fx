// ポストエフェクトの見本 (STANDARDSGLOBAL・RENDERCOLORTARGET・Script・uniform の引数のある 2 つの pass)
float Script : STANDARDSGLOBAL <
    string ScriptOutput = "color";
    string ScriptClass = "scene";
    string ScriptOrder = "postprocess";
> = 0.8;

float2 ViewportSize : VIEWPORTPIXELSIZE;
static float2 ViewportOffset = float2(0.5, 0.5) / ViewportSize;

texture2D ScnMap : RENDERCOLORTARGET <
    float2 ViewportRatio = { 1.0, 1.0 };
    int MipLevels = 1;
    string Format = "A8R8G8B8";
>;
sampler2D ScnSamp = sampler_state {
    texture = <ScnMap>;
    MinFilter = LINEAR; MagFilter = LINEAR; MipFilter = NONE;
    AddressU = CLAMP; AddressV = CLAMP;
};

texture2D T : RENDERCOLORTARGET <
    float2 ViewportRatio = { 1.0, 1.0 };
    string Format = "A8R8G8B8";
>;
sampler2D TSamp = sampler_state {
    texture = <T>;
    MinFilter = LINEAR; MagFilter = LINEAR; MipFilter = NONE;
    AddressU = CLAMP; AddressV = CLAMP;
};

texture2D DepthBuffer : RENDERDEPTHSTENCILTARGET <
    float2 ViewportRatio = { 1.0, 1.0 };
    string Format = "D24S8";
>;

float BlurScale = 1.0;
int LoopCount = 2;

struct VS_OUTPUT {
    float4 Pos : POSITION;
    float2 Tex : TEXCOORD0;
};

VS_OUTPUT PostVS(float4 Pos : POSITION, float2 Tex : TEXCOORD0)
{
    VS_OUTPUT Out;
    Out.Pos = Pos;
    Out.Tex = Tex + ViewportOffset;
    return Out;
}

float4 BlurPS(float2 Tex : TEXCOORD0, uniform sampler2D src, uniform float2 dir) : COLOR0
{
    float4 sum = tex2D(src, Tex) * 0.4;
    for (int i = 1; i <= 3; i++) {
        float2 d = dir * (float(i) * BlurScale) / ViewportSize;
        sum += (tex2D(src, Tex + d) + tex2D(src, Tex - d)) * 0.2;
    }
    return sum;
}

float4 FinalPS(float2 Tex : TEXCOORD0) : COLOR0
{
    return tex2D(TSamp, Tex);
}

float4 ClearColor = { 0, 0, 0, 0 };
float ClearDepth = 1.0;

technique PostTec <
    string Script =
        "RenderColorTarget0=ScnMap;"
        "RenderDepthStencilTarget=DepthBuffer;"
        "ClearSetColor=ClearColor;"
        "ClearSetDepth=ClearDepth;"
        "Clear=Color;"
        "Clear=Depth;"
        "ScriptExternal=Color;"
        "RenderColorTarget0=T;"
        "LoopByCount=LoopCount;"
        "Pass=Blur;"
        "LoopEnd=;"
        "RenderColorTarget0=;"
        "Pass=Final;";
> {
    pass Blur < string Script = "Draw=Buffer;"; > {
        ZEnable = false;
        AlphaBlendEnable = false;
        VertexShader = compile vs_3_0 PostVS();
        PixelShader  = compile ps_3_0 BlurPS(ScnSamp, float2(1, 0));
    }
    pass Final {
        ZEnable = false;
        AlphaBlendEnable = false;
        VertexShader = compile vs_3_0 PostVS();
        PixelShader  = compile ps_3_0 FinalPS();
    }
}
