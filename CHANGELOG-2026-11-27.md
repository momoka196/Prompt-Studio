# 改动报告 · 2026-11-27

对应提交：`b142150` feat: solo锚点+防玩偶分身加权+体型前置+PNG参数嵌入

## 背景

项目中生成的图片偶尔出现一个带角色配件的缩小版/宠物娃娃。多轮排查后确认：提示词里 `baby:1.7`、`toddlercon:1.6` 等高权重词与角色 LoRA 冲突，模型把冲突具象成画面里的第二个小对象；工作流为单次 KSampler，无局部重绘，排除工作流故障。

主人另有两点要求：① 体型词拼在人物前面；② 每次出图的参数要随图片保存、重启项目后仍可查。

## 改了什么

### 1. `src/data/presets.ts`
- 表情预设 `expr-closed-joy`：名称由「眯眼开心大笑 >_<」改为「眯眼开心大笑」；tags 去掉 `>_<`（该符号在训练数据里强绑定 Q 版表情包，容易被模型甩给第二对象），改为 `eyes closed in a happy smile, cheerful open mouth smile, rosy cheeks, uplifted eyebrows`。
- `SHARED_BODY_TYPE_STRING` 体型串内容**未改动**（主人硬规则：不得增删改体型词与权重）。

### 2. `src/utils/promptBuilder.ts`
- 正向提示词最前面自动加 `solo, 1girl, ` 锚点；已含 `solo` 则不重复加。
- `NO_PLUSH_GUARD_TAGS`、`ANTI_DUPLICATE_ONLY_TAGS`：玩偶/分身类负向词加权重（plush 1.8 / doll 1.9 / chibi 1.6 / duplicate 1.75 等），并补 `second character`、`another character`、`two characters in frame`、`small creature in arms` 等结构词。
- `pushUnique`：带权重的词允许覆盖已存在的裸词，避免加权词被去重逻辑跳过。
- `candidates` 顺序调整：体型串（bodyType）移到外貌（appearance）之前拼接。
- `postProfileToComfyUI`：提交时带 `extra_data.extra_pnginfo.chibiprompt`，记录角色、时间、模型、LoRA 列表与权重、seed、steps、cfg、采样器、调度器、尺寸、正负提示词。ComfyUI 的 SaveImage 会把它写成 PNG 文本块，重启项目/清缓存后参数仍随图存在。
  - 注意：只写 `chibiprompt`，不写 `workflow`。API 格式的 workflow 塞进 `workflow` 字段会让 ComfyUI 界面拖拽加载时报「该资产不包含工作流数据」；原生 `prompt` 字段由 ComfyUI 自己写，可正常恢复画布。

## 验证

- `npx tsc --noEmit` 通过。
- PNG 参数嵌入端到端实测：本机 anima 架构（UNET anima-base-v1.0 + CLIP qwen_3_06b_base + VAE qwen_image_vae）提交任务，回读生成的 PNG，文本块为 `prompt` + `chibiprompt`（移除 workflow 后），无警告根源。测试图已删除。

## 未解决 / 待主人拍板

娃娃问题在本轮改动后仍未验证根除。若仍出现，只剩两个方向，需主人明确同意后才动：

- A：调整体型串里的 `baby:1.7` / `toddlercon:1.6` / `pedo:1.6`（降权或剔除）——改的是主人配置的体型词，需重新确认。
- B：降低角色 LoRA `anima_ibuki_swimsuit_v1` 的强度——代价是角色相似度下降。

在主人拍板前，不再自行修改提示词、体型串或 LoRA。
