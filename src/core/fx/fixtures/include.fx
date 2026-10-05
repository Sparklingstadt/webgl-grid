// #include を大文字小文字の違うパスで書いた見本 (listFiles で探す)
#include "inc\common.FXSUB"

float4 IncludePS() : COLOR0
{
    return float4(CommonColor(), 1.0) * CommonScale;
}

technique IncludeTec {
    pass P {
        VertexShader = compile vs_3_0 CommonVS();
        PixelShader  = compile ps_3_0 IncludePS();
    }
}
