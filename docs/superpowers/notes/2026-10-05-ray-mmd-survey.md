# Ray-MMD 1.5.2 の調査

`npm run ray:survey` (`scripts/ray-survey.ts`) が書く。手で直さない。

## 1. DDS の形式

fx/ray-mmd-1.5.2/ がないので未調査

## 2. レンダーターゲット

515 個の .fx を compileEffect で変換して、RENDERCOLORTARGET・RENDERDEPTHSTENCILTARGET・OFFSCREENRENDERTARGET の宣言を集めた。
「エフェクト数」は、その宣言を (#include 経由も含めて) 持つ .fx の数。

| 種類 | Format | MipLevels | 大きさ | shared | targets.ts | エフェクト数 | 例 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| OFFSCREENRENDERTARGET | (なし) | (なし) | (なし = 画面と同じ) | shared | 対応 | 167 | Extension/Debug/DebugController.fx の MaterialMap |
| OFFSCREENRENDERTARGET | A16B16G16R16F | (なし) | ViewportRatio=1,1 |  | 対応 | 1 | ray.fx の FogMap |
| OFFSCREENRENDERTARGET | A8 | (なし) | ViewportRatio=1,1 |  | 未対応 | 1 | ray.fx の SSAOMap |
| OFFSCREENRENDERTARGET | A8R8G8B8 | (なし) | ViewportRatio=1,1 | shared | 対応 | 1 | ray.fx の MaterialMap |
| OFFSCREENRENDERTARGET | G32R32F | (なし) | Dimensions=1024,1024 |  | 対応 | 18 | Lighting/DiskLight/Default/disk_lighting_with_shadow_high.fx の ShadowMap |
| OFFSCREENRENDERTARGET | G32R32F | (なし) | Dimensions=1024,2048 |  | 対応 | 16 | Lighting/PointLight/Default/point_lighting_with_shadow_high.fx の ShadowMap |
| OFFSCREENRENDERTARGET | G32R32F | (なし) | Dimensions=256,256 |  | 対応 | 9 | Lighting/DiskLight/Default/disk_lighting_with_shadow_low.fx の ShadowMap |
| OFFSCREENRENDERTARGET | G32R32F | (なし) | Dimensions=512,512 |  | 対応 | 9 | Lighting/DiskLight/Default/disk_lighting_with_shadow_medium.fx の ShadowMap |
| OFFSCREENRENDERTARGET | G32R32F | (なし) | Dimensions=256,512 |  | 対応 | 8 | Lighting/PointLight/Default/point_lighting_with_shadow_low.fx の ShadowMap |
| OFFSCREENRENDERTARGET | G32R32F | (なし) | Dimensions=512,1024 |  | 対応 | 8 | Lighting/PointLight/Default/point_lighting_with_shadow_medium.fx の ShadowMap |
| OFFSCREENRENDERTARGET | G32R32F | (なし) | Dimensions=2048,2048 |  | 対応 | 2 | Lighting/DirectionalLight/Default/directional_lighting_ambient_with_shadow.fx の PSSM1 |
| OFFSCREENRENDERTARGET | R16F | (なし) | Width=256 Height=512 |  | 対応 | 24 | Lighting/PointLight/Default/point_fog_with_shadow_high.fx の VolumetricMap |
| OFFSCREENRENDERTARGET | R16F | (なし) | Width=256 Height=256 |  | 対応 | 20 | Lighting/DiskLight/Default/disk_fog_with_shadow_high.fx の VolumetricMap |
| OFFSCREENRENDERTARGET | R32F | (なし) | Dimensions=2048,2048 | shared | 対応 | 1 | ray.fx の PSSM1 |
| RENDERCOLORTARGET | (なし) | (なし) | (なし = 画面と同じ) | shared | 対応 | 438 | Extension/Debug/DebugController.fx の Gbuffer2RT |
| RENDERCOLORTARGET | (なし) | 0 | Dimensions=512,256 |  | 対応 | 2 | Skybox/Time of day/Time of lighting.fx の SpecularMap |
| RENDERCOLORTARGET | (なし) | (なし) | Dimensions=512,256 |  | 対応 | 2 | Skybox/Time of day/Time of lighting.fx の DiffuseMap |
| RENDERCOLORTARGET | A16B16G16R16F | (なし) | ViewportRatio=0.5,0.5 |  | 対応 | 9 | Fog/AtmosphericFog/atmospheric_fog with godray high.fx の FogMap |
| RENDERCOLORTARGET | A16B16G16R16F | (なし) | ViewportRatio=1,1 |  | 対応 | 1 | ray.fx の ScnMap |
| RENDERCOLORTARGET | A16B16G16R16F | (なし) | ViewportRatio=1,1 | shared | 対応 | 1 | ray.fx の LightSpecMap |
| RENDERCOLORTARGET | A16B16G16R16F | (なし) | ViewportRatio=0.25,0.25 |  | 対応 | 1 | ray.fx の BloomMap2nd |
| RENDERCOLORTARGET | A16B16G16R16F | (なし) | ViewportRatio=0.125,0.125 |  | 対応 | 1 | ray.fx の BloomMap3rd |
| RENDERCOLORTARGET | A16B16G16R16F | (なし) | ViewportRatio=0.0625,0.0625 |  | 対応 | 1 | ray.fx の BloomMap4th |
| RENDERCOLORTARGET | A16B16G16R16F | (なし) | ViewportRatio=0.03125,0.03125 |  | 対応 | 1 | ray.fx の BloomMap5th |
| RENDERCOLORTARGET | A2B10G10R10 | 0 | ViewportRatio=1,1 | shared | 未対応 | 1 | Extension/DummyScreen/DummyScreen.fx の DummyScreenTex |
| RENDERCOLORTARGET | A8R8G8B8 | (なし) | ViewportRatio=1,1 | shared | 対応 | 1 | ray.fx の Gbuffer2RT |
| RENDERCOLORTARGET | A8R8G8B8 | (なし) | ViewportRatio=1,1 |  | 対応 | 1 | ray.fx の SSDOMapTemp |
| RENDERCOLORTARGET | L8 | (なし) | ViewportRatio=1,1 |  | 未対応 | 1 | ray.fx の ShadowMap |
| RENDERCOLORTARGET | X8R8G8B8 | (なし) | ViewportRatio=1,1 |  | 対応 | 1 | Extension/Debug/DebugController.fx の ScnMap |
| RENDERDEPTHSTENCILTARGET | D24S8 | (なし) | ViewportRatio=1,1 |  | 対応 | 1 | ray.fx の DepthBuffer |

#### Task 7 で足す

`src/core/mme/targets.ts` (`src/engine/mme/Framebuffers.ts` が使う) にまだない形式。いまは警告を出して既定 (色は A8R8G8B8、深度は D24S8) にする:

- OFFSCREENRENDERTARGET A8: 1 件の宣言 (例: ray.fx の SSAOMap)
- RENDERCOLORTARGET A2B10G10R10: 1 件の宣言 (例: Extension/DummyScreen/DummyScreen.fx の DummyScreenTex)
- RENDERCOLORTARGET L8: 1 件の宣言 (例: ray.fx の ShadowMap)

OFFSCREENRENDERTARGET は 168 個の .fx にある (いまの `semantics.ts` では unsupported)。

## 3. ResourceName・ScriptOrder

#### ResourceName の拡張子

| 拡張子 | 宣言の数 | 異なる値の数 | 値 (14 個以下ならすべて、多ければ例) |
| --- | --- | --- | --- |
| .bmp | 3 | 1 | ../_MaterialMap/Fabric02_N by 2gou.bmp |
| .dds | 102 | 9 | ../../../shader/textures/ltc_1.dds、../../../shader/textures/ltc_2.dds、Shader/Textures/skydiff_hdr.dds、Shader/Textures/skyspec_hdr.dds、bricks_ao.dds、bricks_n.dds、texture/skybox.dds、texture/skydiff_hdr.dds、texture/skyspec_hdr.dds |
| .gif | 8 | 3 | bodyline.gif、rainbow.gif、texture/rance.gif |
| .hdr | 22 | 2 | IES.HDR、Textures/BRDF.hdr |
| .jpg | 4 | 3 | Shader/Textures/milky way.jpg、Shader/Textures/moon.jpg、Textures/moon.jpg |
| .png | 38 | 14 | ../../_MaterialMap/skin.png、../_MaterialMap/shift2.png、../_MaterialMap/skin.png、textures/Skin_-_Human_Albedo.png、textures/Skin_-_Human_Gloss.PNG、textures/Skin_-_Human_Normal.png、textures/curvature_body.png、textures/curvature_face.png、textures/noise.png、textures/thickness_body.png、textures/thickness_face.png、textures/wave.png、wetness.png、worn_metal.png |
| .tga | 4 | 2 | ../../shader/textures/BRDF.tga、shader/textures/cloud.tga |

#### ScriptOrder

| 値 | 宣言の数 | 例 |
| --- | --- | --- |
| postprocess | 2 | Extension/Debug/DebugController.fx の Script |
| standard | 1 | Extension/DummyScreen/DummyScreen.fx の Script |

#### ScriptClass

| 値 | 宣言の数 | 例 |
| --- | --- | --- |
| scene | 3 | Extension/Debug/DebugController.fx の Script |

## 変換の結果

515 個の .fx のうち 515 個を変換できた。
