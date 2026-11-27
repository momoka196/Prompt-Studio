import {
  ANIMA_LORA_CHAIN,
  CHARACTER_FORBIDDEN_FEATURES,
  COMFY_ARCH_DEFAULTS,
  EXPRESSION_PRESETS,
  MINIMAL_BACKGROUNDS,
  OUTFIT_PRESETS,
  POSE_PRESETS,
} from '../data/presets';
import {
  BuiltCharacterPrompt,
  CharacterConfig,
  ComfyArchitecture,
  ComfyLoaderKey,
  ComfyLoraItem,
  ComfyProfile,
  ComfySamplerConfig,
  ConflictItem,
  MinimalBackgroundPreset,
  PromptSegment,
  SharedConfig,
  SimplePresetItem,
  WeightedSlot,
} from '../types/studio';

export function clampWeight(w: number): number {
  if (!Number.isFinite(w)) return 1.0;
  return Math.min(2.0, Math.max(0.5, Math.round(w * 100) / 100));
}

export function formatWeightNumber(w: number): string {
  const clamped = clampWeight(w);
  return Number.isInteger(clamped) ? clamped.toFixed(1) : String(clamped);
}

export function formatWeightedText(text: string, weight: number): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const w = clampWeight(weight);
  if (Math.abs(w - 1.0) < 0.001) {
    return trimmed;
  }
  return `(${trimmed}:${formatWeightNumber(w)})`;
}

export interface PromptStats {
  tagCount: number;
  charCount: number;
  preview: string;
}

export function getPromptStats(text: string, maxPreviewTags = 6): PromptStats {
  const trimmed = text.trim();
  if (!trimmed) {
    return { tagCount: 0, charCount: 0, preview: '（空）' };
  }
  const tags = trimmed
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const previewSlice = tags.slice(0, maxPreviewTags).join(', ');
  const preview = tags.length > maxPreviewTags ? `${previewSlice}, ...` : previewSlice;
  return {
    tagCount: tags.length,
    charCount: trimmed.length,
    preview,
  };
}

export interface BuildPromptOptions {
  includeAppearance?: boolean;
  customPresets?: SimplePresetItem[];
  customBackgrounds?: MinimalBackgroundPreset[];
  selectedPresetTitles?: string[];
}

export interface NegativeGuardRuleBadge {
  id: 'anti-plush' | 'allow-plush-anti-dup' | 'anti-pajama-bed';
  label: string;
  detail: string;
  tone: 'neutral' | 'plush' | 'pajama';
}

export interface NegativeAutoGuardAnalysis {
  hasExplicitPlush: boolean;
  hasPajama: boolean;
  appendedTags: string[];
  rules: NegativeGuardRuleBadge[];
}

export interface BuildEffectiveNegativeOptions {
  customPresets?: SimplePresetItem[];
  customBackgrounds?: MinimalBackgroundPreset[];
  selectedPresetTitles?: string[];
}

export function buildCharacterPrompt(
  shared: SharedConfig,
  character: CharacterConfig,
  options: BuildPromptOptions = {}
): BuiltCharacterPrompt {
  const includeAppearance = options.includeAppearance ?? true;

  const candidates: {
    key: string;
    label: string;
    layer: 'shared' | 'character';
    slot: WeightedSlot;
  }[] = [
    { key: 'styleAnchor', label: '画风', layer: 'shared', slot: shared.styleAnchor },
    { key: 'background', label: '场景', layer: 'shared', slot: shared.background },
    { key: 'composition', label: '构图', layer: 'shared', slot: shared.composition },
    { key: 'appearance', label: '外貌', layer: 'character', slot: character.appearance },
    ...(shared.bodyType && shared.bodyType.text.trim()
      ? [{ key: 'bodyType', label: '体型', layer: 'shared' as const, slot: shared.bodyType }]
      : []),
    { key: 'outfit', label: '服装', layer: 'character', slot: character.outfit },
    { key: 'pose', label: '动作', layer: 'character', slot: character.pose },
    { key: 'expression', label: '表情', layer: 'character', slot: character.expression },
  ];

  const segments: PromptSegment[] = [];

  for (const item of candidates) {
    if (!includeAppearance && item.key === 'appearance') continue;
    const raw = item.slot.text.trim();
    if (!raw) continue;
    const formatted = formatWeightedText(raw, item.slot.weight);
    segments.push({
      key: item.key,
      label: item.label,
      layer: item.layer,
      rawText: raw,
      weight: clampWeight(item.slot.weight),
      formatted,
    });
  }

  return {
    fullText: segments.map((s) => s.formatted).join(', '),
    segments,
  };
}

export function buildSharedNegativePrompt(shared: SharedConfig): string {
  if (shared.manualNegativeOverride !== null) {
    return shared.manualNegativeOverride;
  }
  const parts: string[] = [];
  for (const group of shared.negativeGroups) {
    if (!group.enabled) continue;
    for (const tag of group.tags) {
      const formatted = formatWeightedText(tag.text, tag.weight);
      if (formatted) parts.push(formatted);
    }
  }
  return parts.join(', ');
}

const NO_PLUSH_GUARD_TAGS = [
  'plush',
  'plushie',
  'stuffed toy',
  'stuffed animal',
  'doll',
  'holding doll',
  'holding plush',
  'mascot',
  'chibi',
  'miniature',
  'mini character',
  'look-alike',
  'duplicate',
];

const ANTI_DUPLICATE_ONLY_TAGS = [
  'chibi',
  'miniature',
  'mini character',
  'look-alike',
  'duplicate',
];

const PAJAMA_BED_GUARD_TAGS = [
  'bed',
  'on bed',
  'standing on bed',
  'lying on bed',
];

const PAJAMA_PLUSH_GUARD_TAGS = ['plush toy', 'stuffed toy', 'doll'];

const PLUSH_KEYWORD_RE =
  /\b(?:plush(?:ie|ies)?|stuffed\s+(?:toy|animal)s?|dolls?|mascots?|holding\s+(?:a\s+)?(?:doll|plush(?:ie)?))\b|玩偶|毛绒|公仔/i;

const PAJAMA_KEYWORD_RE =
  /\b(?:pajamas?|pyjamas?|nightwear|sleepwear|loungewear|fleece)\b|睡衣|居家服/i;

function collectMatchedPresetText(
  shared: SharedConfig,
  characters: CharacterConfig[],
  options: BuildEffectiveNegativeOptions
): string[] {
  const extraTexts: string[] = [];
  if (shared.selectedBackgroundName) {
    extraTexts.push(shared.selectedBackgroundName);
  }
  const allBackgrounds = [...(options.customBackgrounds ?? []), ...MINIMAL_BACKGROUNDS];
  const bgTrimmed = shared.background.text.trim();
  const matchedBg =
    (shared.selectedBackgroundId
      ? allBackgrounds.find((b) => b.id === shared.selectedBackgroundId)
      : undefined) ??
    (bgTrimmed ? allBackgrounds.find((b) => b.tags.trim() === bgTrimmed) : undefined);
  if (matchedBg) {
    extraTexts.push(matchedBg.zhName, matchedBg.note);
  }

  const allPresets = [
    ...(options.customPresets ?? []),
    ...OUTFIT_PRESETS,
    ...POSE_PRESETS,
    ...EXPRESSION_PRESETS,
  ];
  for (const char of characters) {
    const slotTexts = [char.outfit.text, char.pose.text, char.expression.text]
      .map((t) => t.trim())
      .filter(Boolean);
    for (const slotText of slotTexts) {
      const normalizedSlot = splitCleanTerms(slotText).join(', ');
      const matched = allPresets.find(
        (p) =>
          p.tags.trim() === slotText ||
          (normalizedSlot && splitCleanTerms(p.tags).join(', ') === normalizedSlot)
      );
      if (matched) {
        extraTexts.push(matched.zhName, matched.vibe);
      }
    }
  }

  if (options.selectedPresetTitles && options.selectedPresetTitles.length > 0) {
    extraTexts.push(...options.selectedPresetTitles);
  }
  return extraTexts;
}

export function analyzeNegativeAutoGuards(
  shared: SharedConfig,
  targetCharacters: CharacterConfig | CharacterConfig[],
  options: BuildEffectiveNegativeOptions = {}
): NegativeAutoGuardAnalysis {
  const charList = Array.isArray(targetCharacters)
    ? targetCharacters
    : [targetCharacters];

  const positiveTexts: string[] = [
    shared.styleAnchor.text,
    shared.background.text,
    shared.composition.text,
    shared.bodyType?.text ?? '',
    ...charList.flatMap((c) => [
      c.appearance.text,
      c.outfit.text,
      c.pose.text,
      c.expression.text,
    ]),
    ...collectMatchedPresetText(shared, charList, options),
  ];

  const combinedPositive = positiveTexts.filter(Boolean).join(' , ');
  const hasExplicitPlush = PLUSH_KEYWORD_RE.test(combinedPositive);
  const hasPajama = PAJAMA_KEYWORD_RE.test(combinedPositive);

  const baseNegative = buildSharedNegativePrompt(shared);
  const existingCleanSet = new Set<string>();
  if (baseNegative.trim()) {
    for (const part of baseNegative.split(/[,，\n]+/)) {
      const clean = stripWeightSyntax(part).replace(/\s+/g, ' ').trim();
      if (clean) existingCleanSet.add(clean);
    }
  }

  const appendedTags: string[] = [];
  const seenAdded = new Set<string>();
  const pushUnique = (tag: string) => {
    const normalized = tag.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!normalized) return;
    if (existingCleanSet.has(normalized) || seenAdded.has(normalized)) return;
    seenAdded.add(normalized);
    appendedTags.push(tag.trim());
  };

  if (hasExplicitPlush) {
    ANTI_DUPLICATE_ONLY_TAGS.forEach(pushUnique);
  } else {
    NO_PLUSH_GUARD_TAGS.forEach(pushUnique);
  }

  if (hasPajama) {
    PAJAMA_BED_GUARD_TAGS.forEach(pushUnique);
    if (!hasExplicitPlush) {
      PAJAMA_PLUSH_GUARD_TAGS.forEach(pushUnique);
    }
    ANTI_DUPLICATE_ONLY_TAGS.forEach(pushUnique);
  }

  const rules: NegativeGuardRuleBadge[] = [];
  if (hasExplicitPlush) {
    rules.push({
      id: 'allow-plush-anti-dup',
      label: '已选玩偶 · 仅防同化',
      detail: '已保留玩偶/毛绒玩具正向词，负向仅追加防分身同化词',
      tone: 'plush',
    });
  } else {
    rules.push({
      id: 'anti-plush',
      label: '未选玩偶 · 防玩偶/同化',
      detail: '未选玩偶，自动压制凭空生成玩偶与分身同化',
      tone: 'neutral',
    });
  }

  if (hasPajama) {
    rules.push({
      id: 'anti-pajama-bed',
      label: '睡衣/居家 · 防站床/同化',
      detail: hasExplicitPlush
        ? '检测到睡衣/居家服，自动压制床铺/站床与分身同化（已保留玩偶）'
        : '检测到睡衣/居家服，自动压制床铺/站床与玩偶同化',
      tone: 'pajama',
    });
  }

  return {
    hasExplicitPlush,
    hasPajama,
    appendedTags,
    rules,
  };
}

export function buildEffectiveNegativePrompt(
  shared: SharedConfig,
  targetCharacters: CharacterConfig | CharacterConfig[],
  options: BuildEffectiveNegativeOptions = {}
): string {
  const baseNegative = buildSharedNegativePrompt(shared).trim();
  const analysis = analyzeNegativeAutoGuards(shared, targetCharacters, options);
  if (analysis.appendedTags.length === 0) {
    return baseNegative;
  }
  const suffix = analysis.appendedTags.join(', ');
  return baseNegative ? `${baseNegative}, ${suffix}` : suffix;
}

export function buildCopyAllOutput(
  shared: SharedConfig,
  characters: CharacterConfig[],
  options: BuildPromptOptions = {}
): string {
  const blocks: string[] = [];
  characters.forEach((char, idx) => {
    const built = buildCharacterPrompt(shared, char, options);
    blocks.push(`[${idx + 1}] ${char.name}\nPositive: ${built.fullText}`);
  });
  const negative = buildEffectiveNegativePrompt(shared, characters, options);
  blocks.push(`[共用负向提示词]\nNegative: ${negative}`);
  return blocks.join('\n\n');
}

export function buildWorkflowSnippet(
  shared: SharedConfig,
  character: CharacterConfig,
  options: BuildPromptOptions = {}
): string {
  const built = buildCharacterPrompt(shared, character, options);
  const negative = buildEffectiveNegativePrompt(shared, character, options);
  return `=== 正向（粘到共用服装节点）===\n${built.fullText}\n\n=== 负向（粘到共用负向节点）===\n${negative}`;
}

function stripWeightSyntax(raw: string): string {
  return raw
    .trim()
    .replace(/^\((.+):[0-9.]+\)$/g, '$1')
    .replace(/[()[\]]/g, '')
    .replace(/:[0-9.]+/g, '')
    .trim()
    .toLowerCase();
}

function splitCleanTerms(raw: string): string[] {
  return raw
    .split(/[,，\n]+/)
    .map((part) => stripWeightSyntax(part))
    .filter((t) => t.length >= 2);
}

export function detectConflicts(
  shared: SharedConfig,
  characters: CharacterConfig[]
): ConflictItem[] {
  const conflicts: ConflictItem[] = [];
  const negativeString = buildSharedNegativePrompt(shared);
  const negativeRawTerms = negativeString
    .split(/[,，\n]+/)
    .map((part) => ({
      raw: part.trim(),
      clean: stripWeightSyntax(part),
    }))
    .filter((item) => item.clean.length >= 2);

  // 1. 多人场景检测 solo
  if (characters.length > 1) {
    const sharedPosText = [
      shared.styleAnchor.text,
      shared.background.text,
      shared.composition.text,
    ].join(', ');

    if (/\bsolo\b/i.test(sharedPosText)) {
      conflicts.push({
        id: 'conflict-solo-shared',
        severity: 'error',
        title: `多人场景不应在正向写 solo`,
        detail: `当前共有 ${characters.length} 个角色，共享层正向中出现了 "solo"，会导致多人构图崩坏或漏画角色。`,
        fixType: 'remove-solo',
      });
    }

    characters.forEach((char) => {
      const charPosText = [
        char.appearance.text,
        char.outfit.text,
        char.pose.text,
        char.expression.text,
      ].join(', ');
      if (/\bsolo\b/i.test(charPosText)) {
        conflicts.push({
          id: `conflict-solo-${char.id}`,
          severity: 'error',
          title: `多人场景不应在正向写 solo`,
          detail: `当前共有 ${characters.length} 个角色，但「${char.name}」的正向提示词中包含 "solo"。`,
          characterId: char.id,
          fixType: 'remove-solo',
        });
      }
    });
  }

  // 2. 正向与负向冲突检测
  const seenCollisionKeys = new Set<string>();
  const sharedPositiveEntries = [
    { source: '共享层', text: `${shared.styleAnchor.text}, ${shared.background.text}, ${shared.composition.text}` },
    ...characters.map((c) => ({
      source: c.name,
      characterId: c.id,
      text: `${c.appearance.text}, ${c.outfit.text}, ${c.pose.text}, ${c.expression.text}`,
    })),
  ];

  for (const entry of sharedPositiveEntries) {
    const posTerms = splitCleanTerms(entry.text);
    for (const posTerm of posTerms) {
      for (const negItem of negativeRawTerms) {
        if (!negItem.clean) continue;
        // 完全相等，或正向词包含更短的负向压制词（避免 "standing" 误报撞车 "standing on bed"）
        const isExact = posTerm === negItem.clean;
        const isWordOverlap =
          negItem.clean.length >= 4 &&
          new RegExp(`\\b${negItem.clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(posTerm);

        if (isExact || isWordOverlap) {
          const dedupeKey = `${entry.source}::${posTerm}::${negItem.clean}`;
          if (seenCollisionKeys.has(dedupeKey)) continue;
          seenCollisionKeys.add(dedupeKey);

          conflicts.push({
            id: `conflict-neg-${dedupeKey}`,
            severity: isExact ? 'error' : 'warning',
            title: `正向与负向存在冲突词 "${negItem.clean}"`,
            detail: `「${entry.source}」正向包含 "${posTerm}"，但共用负向同时压制了 "${negItem.raw}"。`,
            characterId: 'characterId' in entry ? entry.characterId : undefined,
            fixType: 'remove-negative-tag',
            targetTag: negItem.clean,
          });
        }
      }
    }
  }

  // 3. 铁律 2：共用负向绝不允许出现任何发色/发型/瞳色/角色专属配件
  const seenForbiddenNeg = new Set<string>();
  for (const negItem of negativeRawTerms) {
    if (!negItem.clean) continue;
    for (const feature of CHARACTER_FORBIDDEN_FEATURES) {
      const escaped = feature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`\\b${escaped}\\b`, 'i').test(negItem.clean)) {
        const key = `${negItem.clean}::${feature}`;
        if (seenForbiddenNeg.has(key)) continue;
        seenForbiddenNeg.add(key);
        conflicts.push({
          id: `conflict-iron2-${key}`,
          severity: 'error',
          title: `共用负向触犯铁律 2：包含角色特征 "${feature}"`,
          detail: `共用负向包含 "${negItem.raw}"，会误伤对应角色的发色、瞳色、发型或专属配件，请从负向移除。`,
          fixType: 'remove-negative-tag',
          targetTag: negItem.clean,
        });
      }
    }
  }

  // 4. 铁律 1：禁止补充会盖住 LoRA 人脸的通用五官美化词
  const LORA_FACE_OVERRIDE_TERMS = ['detailed face', 'beautiful eyes', 'intricate eyes', 'anime face'];
  for (const entry of sharedPositiveEntries) {
    const posTerms = splitCleanTerms(entry.text);
    for (const badTerm of LORA_FACE_OVERRIDE_TERMS) {
      if (posTerms.some((t) => t.includes(badTerm))) {
        conflicts.push({
          id: `conflict-iron1-${entry.source}-${badTerm}`,
          severity: 'warning',
          title: `不建议添加 "${badTerm}"`,
          detail: `「${entry.source}」正向包含 "${badTerm}"，容易盖住 Anima LoRA 学到的角色五官。`,
          characterId: 'characterId' in entry ? entry.characterId : undefined,
        });
      }
    }
  }

  // 5. 角色专属禁用词（防串特征）检测
  for (const char of characters) {
    if (!char.forbiddenTags || !char.forbiddenTags.trim()) continue;
    const forbiddenList = splitCleanTerms(char.forbiddenTags);
    const charTerms = splitCleanTerms(
      `${char.appearance.text}, ${char.outfit.text}, ${char.pose.text}, ${char.expression.text}`
    );
    for (const fTag of forbiddenList) {
      const matched = charTerms.find(
        (ct) => ct === fTag || new RegExp(`\\b${fTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(ct)
      );
      if (matched) {
        conflicts.push({
          id: `conflict-char-forbidden-${char.id}-${fTag}`,
          severity: 'warning',
          title: `角色「${char.name}」命中禁用词 "${fTag}"`,
          detail: `「${char.name}」的正向提示词出现了禁用特征 "${matched}"，若为刻意选择的表情/服装可点击右侧忽略。`,
          characterId: char.id,
          fixType: 'remove-forbidden-tag',
          targetTag: fTag,
        });
      }
    }
  }

  return conflicts;
}

const OUTFIT_CANDIDATE_POOL = [
  'school uniform',
  'sailor uniform',
  'serafuku',
  'lolita dress',
  'maid dress',
  'yukata',
  'kimono',
  'swimsuit',
  'bikini',
  'hoodie',
  'pajamas',
  'raincoat',
  'sundress',
  'overalls',
  'cardigan',
  'capelet',
  'armor',
  'business suit',
  'tracksuit',
];

export function recommendAntiOutfitTags(characters: CharacterConfig[]): string[] {
  const wornText = characters
    .map((c) => c.outfit.text.toLowerCase())
    .join(', ');

  return OUTFIT_CANDIDATE_POOL.filter((candidate) => !wornText.includes(candidate)).slice(0, 8);
}

export interface LoaderNodeMeta {
  nodeType: string;
  inputKey: string;
  label: string;
  shortLabel: string;
}

export const LOADER_NODE_META: Record<ComfyLoaderKey, LoaderNodeMeta> = {
  checkpoint: {
    nodeType: 'CheckpointLoaderSimple',
    inputKey: 'ckpt_name',
    label: 'Checkpoint',
    shortLabel: 'ckpt',
  },
  unet: {
    nodeType: 'UNETLoader',
    inputKey: 'unet_name',
    label: 'UNETLoader',
    shortLabel: 'unet',
  },
  clip: {
    nodeType: 'CLIPLoader',
    inputKey: 'clip_name',
    label: 'CLIPLoader',
    shortLabel: 'clip',
  },
  vae: {
    nodeType: 'VAELoader',
    inputKey: 'vae_name',
    label: 'VAELoader',
    shortLabel: 'vae',
  },
};

export function getActiveLoaderKeys(profile: ComfyProfile): ComfyLoaderKey[] {
  if (profile.architecture === 'anima') {
    return ['unet', 'clip', 'vae'];
  }
  if (
    profile.architecture === 'sdxl' ||
    profile.architecture === 'illustrious' ||
    profile.architecture === 'sd15'
  ) {
    return ['checkpoint'];
  }
  const keys: ComfyLoaderKey[] = [];
  if (profile.loaders.enableCheckpoint) keys.push('checkpoint');
  if (profile.loaders.enableUnet) keys.push('unet');
  if (profile.loaders.enableClip) keys.push('clip');
  if (profile.loaders.enableVae) keys.push('vae');
  return keys;
}

export function sanitizeFilenamePrefix(name: string): string {
  return (
    (name || 'ChibiPrompt')
      .replace(/[\\/:*?"<>|]+/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '') || 'ChibiPrompt'
  );
}

export async function fetchComfyNodeOptions(
  comfyUrl: string,
  nodeType: string,
  inputKey: string
): Promise<string[]> {
  const baseUrl = comfyUrl.trim().replace(/\/+$/, '');
  if (!baseUrl) {
    throw new Error('请先填写 ComfyUI 服务地址（默认 http://127.0.0.1:8188）');
  }

  const response = await fetch(`${baseUrl}/object_info/${encodeURIComponent(nodeType)}`, {
    method: 'GET',
  });

  if (!response.ok) {
    throw new Error(`获取 ${nodeType} 列表失败 (${response.status}): ${response.statusText}`);
  }

  const data = (await response.json()) as Record<
    string,
    {
      input?: {
        required?: Record<string, unknown[]>;
        optional?: Record<string, unknown[]>;
      };
    }
  >;

  const rawField =
    data?.[nodeType]?.input?.required?.[inputKey] ??
    data?.[nodeType]?.input?.optional?.[inputKey];
  if (!Array.isArray(rawField) || rawField.length === 0) {
    return [];
  }

  const candidateList = Array.isArray(rawField[0]) ? rawField[0] : rawField;
  return candidateList.filter(
    (item): item is string => typeof item === 'string' && item.trim().length > 0
  );
}

export async function fetchAvailableUnets(comfyUrl: string): Promise<string[]> {
  return fetchComfyNodeOptions(comfyUrl, 'UNETLoader', 'unet_name');
}

type WorkflowNode = { class_type: string; inputs: Record<string, unknown> };

interface ComfyErrorDetailItem {
  type?: string;
  message?: string;
  details?: string;
  extra_info?: Record<string, unknown>;
}

interface ComfyApiErrorPayload {
  error?: {
    type?: string;
    message?: string;
    details?: string;
    extra_info?: unknown;
  };
  node_errors?: Record<
    string,
    {
      class_type?: string;
      errors?: ComfyErrorDetailItem[];
    }
  >;
}

export async function parseComfyErrorResponse(
  status: number,
  rawText: string,
  workflow: Record<string, WorkflowNode>,
  baseUrl: string
): Promise<string> {
  let parsed: ComfyApiErrorPayload | null = null;
  try {
    parsed = JSON.parse(rawText) as ComfyApiErrorPayload;
  } catch {
    return `ComfyUI 返回错误 (${status}): ${rawText || '未知错误'}`;
  }

  const messages: string[] = [];

  if (parsed?.node_errors && typeof parsed.node_errors === 'object') {
    for (const [nodeId, nodeErr] of Object.entries(parsed.node_errors)) {
      const wfNode = workflow[nodeId];
      const classType = nodeErr?.class_type || wfNode?.class_type || '节点';
      const errList = Array.isArray(nodeErr?.errors) ? nodeErr.errors : [];

      for (const err of errList) {
        const extra = err.extra_info ?? {};
        if (err.type === 'value_not_in_list') {
          const inputName =
            (typeof extra.input_name === 'string' && extra.input_name) ||
            'model';
          const receivedVal =
            (typeof extra.received_value === 'string' && extra.received_value) ||
            (wfNode?.inputs?.[inputName] !== undefined
              ? String(wfNode.inputs[inputName])
              : '') ||
            '(空)';

          let available: string[] = [];
          if (Array.isArray(extra.available_values)) {
            available = extra.available_values.filter(
              (v): v is string => typeof v === 'string'
            );
          } else if (classType && inputName) {
            try {
              available = await fetchComfyNodeOptions(baseUrl, classType, inputName);
            } catch {
              available = [];
            }
          }

          if (available.length > 0) {
            const preview = available.slice(0, 5).join('、');
            const suffix = available.length > 5 ? `（共 ${available.length} 项）` : '';
            messages.push(
              `模型 ${receivedVal} 不存在，可用的是：${preview}${suffix}`
            );
          } else {
            messages.push(
              `模型 ${receivedVal} 不存在于 ${classType} (#${nodeId}) 的可用列表`
            );
          }
        } else if (err.type === 'required_input_missing') {
          const inputName =
            (typeof extra.input_name === 'string' && extra.input_name) ||
            err.details ||
            '必填参数';
          messages.push(`节点 ${classType} (#${nodeId}) 缺少输入：${inputName}`);
        } else {
          const extraStr =
            Object.keys(extra).length > 0
              ? JSON.stringify(extra)
              : err.details || err.message || '参数校验失败';
          messages.push(`${classType} (#${nodeId}): ${extraStr}`);
        }
      }
    }
  }

  if (messages.length > 0) {
    return messages.join('；');
  }

  if (parsed?.error) {
    const extraInfo =
      parsed.error.extra_info !== undefined
        ? typeof parsed.error.extra_info === 'string'
          ? parsed.error.extra_info
          : JSON.stringify(parsed.error.extra_info)
        : '';
    const detail = parsed.error.details || extraInfo || parsed.error.message;
    if (detail) {
      return `ComfyUI (${status}): ${detail}`;
    }
  }

  return `ComfyUI 返回错误 (${status}): ${rawText || '未知错误'}`;
}

export function buildComfyWorkflowFromProfile(params: {
  profile: ComfyProfile;
  characterName: string;
  positivePrompt: string;
  negativePrompt: string;
  enableFourthLora?: boolean;
}): {
  workflow: Record<string, WorkflowNode>;
  usedModelSummary: string;
  activeLorasCount: number;
} {
  const { profile } = params;
  const activeKeys = getActiveLoaderKeys(profile);
  if (activeKeys.length === 0) {
    throw new Error('当前自定义架构未勾选任何模型加载节点，请至少启用 Checkpoint 或 UNET/CLIP/VAE');
  }

  const workflow: Record<string, WorkflowNode> = {};
  let modelSource: [string, number] | null = null;
  let clipSource: [string, number] | null = null;
  let vaeSource: [string, number] | null = null;
  const modelLabels: string[] = [];

  if (activeKeys.includes('checkpoint')) {
    const ckpt = (profile.loaders.checkpoint ?? '').trim();
    if (!ckpt) {
      throw new Error('ckpt 未填写，请在设置中填写或从列表选择 Checkpoint 模型');
    }
    workflow['1'] = {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: ckpt },
    };
    modelSource = ['1', 0];
    clipSource = ['1', 1];
    vaeSource = ['1', 2];
    modelLabels.push(ckpt);
  }

  if (activeKeys.includes('unet')) {
    const unet = (profile.loaders.unet ?? '').trim();
    if (!unet) {
      throw new Error('unet 未填写，请在设置中填写或读取 UNETLoader 列表');
    }
    workflow['2'] = {
      class_type: 'UNETLoader',
      inputs: {
        unet_name: unet,
        weight_dtype: 'default',
      },
    };
    modelSource = ['2', 0];
    modelLabels.push(unet);
  }

  if (activeKeys.includes('clip')) {
    const clip = (profile.loaders.clip ?? '').trim();
    if (!clip) {
      throw new Error('clip 未填写，请在设置中填写或读取 CLIPLoader 列表');
    }
    workflow['3'] = {
      class_type: 'CLIPLoader',
      inputs: {
        clip_name: clip,
        type: profile.loaders.clipType || 'stable_diffusion',
        device: 'default',
      },
    };
    clipSource = ['3', 0];
  }

  if (activeKeys.includes('vae')) {
    const vae = (profile.loaders.vae ?? '').trim();
    if (!vae) {
      throw new Error('vae 未填写，请在设置中填写或读取 VAELoader 列表');
    }
    workflow['4'] = {
      class_type: 'VAELoader',
      inputs: {
        vae_name: vae,
      },
    };
    vaeSource = ['4', 0];
  }

  if (!modelSource) {
    throw new Error('缺少 MODEL 来源，请启用 Checkpoint 或 UNETLoader');
  }
  if (!clipSource) {
    throw new Error('缺少 CLIP 来源，请启用 Checkpoint 或 CLIPLoader');
  }
  if (!vaeSource) {
    throw new Error('缺少 VAE 来源，请启用 Checkpoint 或 VAELoader');
  }

  const activeLoras = (profile.loras ?? []).filter((lora: ComfyLoraItem) => {
    if (!lora.name || !lora.name.trim()) return false;
    if (lora.condition === 'ibuki_only' && !params.enableFourthLora) return false;
    return true;
  });

  activeLoras.forEach((lora, idx) => {
    const nodeId = String(20 + idx);
    workflow[nodeId] = {
      class_type: 'LoraLoader',
      inputs: {
        lora_name: lora.name.trim(),
        strength_model: Number.isFinite(lora.model) ? lora.model : 1.0,
        strength_clip: Number.isFinite(lora.clip) ? lora.clip : 1.0,
        model: modelSource!,
        clip: clipSource!,
      },
    };
    modelSource = [nodeId, 0];
    clipSource = [nodeId, 1];
  });

  const sampling = profile.sampling;
  const seed = Math.floor(Math.random() * 2147483647);

  workflow['10'] = {
    class_type: 'CLIPTextEncode',
    inputs: {
      clip: clipSource,
      text: params.positivePrompt,
    },
  };
  workflow['11'] = {
    class_type: 'CLIPTextEncode',
    inputs: {
      clip: clipSource,
      text: params.negativePrompt,
    },
  };
  workflow['12'] = {
    class_type: 'EmptyLatentImage',
    inputs: {
      batch_size: 1,
      height: sampling.height || 1024,
      width: sampling.width || 1024,
    },
  };
  workflow['13'] = {
    class_type: 'KSampler',
    inputs: {
      cfg: sampling.cfg || 4.5,
      denoise: sampling.denoise ?? 1.0,
      latent_image: ['12', 0],
      model: modelSource,
      negative: ['11', 0],
      positive: ['10', 0],
      sampler_name: sampling.sampler || 'er_sde',
      scheduler: sampling.scheduler || 'simple',
      seed,
      steps: sampling.steps || 28,
    },
  };
  workflow['14'] = {
    class_type: 'VAEDecode',
    inputs: {
      samples: ['13', 0],
      vae: vaeSource,
    },
  };
  workflow['15'] = {
    class_type: 'SaveImage',
    inputs: {
      filename_prefix: sanitizeFilenamePrefix(params.characterName),
      images: ['14', 0],
    },
  };

  return {
    workflow,
    usedModelSummary: modelLabels.join(' + ') || 'Checkpoint',
    activeLorasCount: activeLoras.length,
  };
}

export async function postProfileToComfyUI(params: {
  comfyUrl: string;
  profile: ComfyProfile;
  characterName: string;
  positivePrompt: string;
  negativePrompt: string;
  enableFourthLora?: boolean;
}): Promise<{
  promptId: string;
  usedModelSummary: string;
  activeLorasCount: number;
}> {
  const baseUrl = params.comfyUrl.trim().replace(/\/+$/, '');
  if (!baseUrl) {
    throw new Error('请先填写 ComfyUI 服务地址（默认 http://127.0.0.1:8188）');
  }

  const { workflow, usedModelSummary, activeLorasCount } =
    buildComfyWorkflowFromProfile({
      profile: params.profile,
      characterName: params.characterName,
      positivePrompt: params.positivePrompt,
      negativePrompt: params.negativePrompt,
      enableFourthLora: params.enableFourthLora,
    });

  const clientId = `chibiprompt-${Math.random().toString(36).slice(2, 10)}`;
  const response = await fetch(`${baseUrl}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      prompt: workflow,
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    const friendlyMsg = await parseComfyErrorResponse(
      response.status,
      errText,
      workflow,
      baseUrl
    );
    throw new Error(friendlyMsg);
  }

  const data = (await response.json()) as { prompt_id?: string };
  return {
    promptId: data.prompt_id ?? 'submitted',
    usedModelSummary,
    activeLorasCount,
  };
}

export function exportComfyProfilePayload(profile: ComfyProfile): {
  name: string;
  architecture: ComfyArchitecture;
  loaders: ComfyProfile['loaders'];
  loras: ComfyLoraItem[];
  sampling: ComfyProfile['sampling'];
} {
  return {
    name: profile.name,
    architecture: profile.architecture,
    loaders: { ...profile.loaders },
    loras: (profile.loras ?? []).map((l) => ({
      name: l.name,
      model: l.model,
      clip: l.clip,
      condition: l.condition ?? null,
    })),
    sampling: {
      width: profile.sampling.width,
      height: profile.sampling.height,
      steps: profile.sampling.steps,
      cfg: profile.sampling.cfg,
      sampler: profile.sampling.sampler,
      scheduler: profile.sampling.scheduler,
      denoise: profile.sampling.denoise ?? 1.0,
    },
  };
}

const VALID_ARCHITECTURES: ComfyArchitecture[] = [
  'anima',
  'sdxl',
  'illustrious',
  'sd15',
  'custom',
];

export function parseComfyProfileImport(raw: unknown): ComfyProfile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Profile JSON 必须是对象结构');
  }
  const obj = raw as Record<string, unknown>;
  const archRaw = typeof obj.architecture === 'string' ? obj.architecture : 'anima';
  if (!VALID_ARCHITECTURES.includes(archRaw as ComfyArchitecture)) {
    throw new Error(`不支持的架构类型: ${archRaw}`);
  }
  const arch = archRaw as ComfyArchitecture;
  const archPreset = COMFY_ARCH_DEFAULTS[arch];

  if (!obj.loaders || typeof obj.loaders !== 'object') {
    throw new Error('Profile JSON 缺少 loaders 字段');
  }
  if (!obj.sampling || typeof obj.sampling !== 'object') {
    throw new Error('Profile JSON 缺少 sampling 字段');
  }

  const rawLoaders = obj.loaders as Record<string, unknown>;
  const rawSampling = obj.sampling as Record<string, unknown>;
  const rawLoras = Array.isArray(obj.loras) ? obj.loras : [];

  const loras: ComfyLoraItem[] = rawLoras
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    .slice(0, 8)
    .map((item, idx) => ({
      id: `lora-${Date.now()}-${idx}`,
      name: typeof item.name === 'string' ? item.name : '',
      model: typeof item.model === 'number' && Number.isFinite(item.model) ? item.model : 1.0,
      clip: typeof item.clip === 'number' && Number.isFinite(item.clip) ? item.clip : 1.0,
      condition: item.condition === 'ibuki_only' ? 'ibuki_only' : null,
    }));

  const name =
    typeof obj.name === 'string' && obj.name.trim()
      ? obj.name.trim()
      : `导入方案-${archPreset.label}`;

  return {
    id: `profile-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name,
    architecture: arch,
    loaders: {
      ...archPreset.defaultLoaders,
      ...(typeof rawLoaders.checkpoint === 'string' ? { checkpoint: rawLoaders.checkpoint } : {}),
      ...(typeof rawLoaders.unet === 'string' ? { unet: rawLoaders.unet } : {}),
      ...(typeof rawLoaders.clip === 'string' ? { clip: rawLoaders.clip } : {}),
      ...(typeof rawLoaders.vae === 'string' ? { vae: rawLoaders.vae } : {}),
      ...(typeof rawLoaders.clipType === 'string' ? { clipType: rawLoaders.clipType } : {}),
      ...(typeof rawLoaders.enableCheckpoint === 'boolean'
        ? { enableCheckpoint: rawLoaders.enableCheckpoint }
        : {}),
      ...(typeof rawLoaders.enableUnet === 'boolean'
        ? { enableUnet: rawLoaders.enableUnet }
        : {}),
      ...(typeof rawLoaders.enableClip === 'boolean'
        ? { enableClip: rawLoaders.enableClip }
        : {}),
      ...(typeof rawLoaders.enableVae === 'boolean'
        ? { enableVae: rawLoaders.enableVae }
        : {}),
    },
    loras,
    sampling: {
      width:
        typeof rawSampling.width === 'number' && Number.isFinite(rawSampling.width)
          ? rawSampling.width
          : archPreset.defaultSampling.width,
      height:
        typeof rawSampling.height === 'number' && Number.isFinite(rawSampling.height)
          ? rawSampling.height
          : archPreset.defaultSampling.height,
      steps:
        typeof rawSampling.steps === 'number' && Number.isFinite(rawSampling.steps)
          ? rawSampling.steps
          : archPreset.defaultSampling.steps,
      cfg:
        typeof rawSampling.cfg === 'number' && Number.isFinite(rawSampling.cfg)
          ? rawSampling.cfg
          : archPreset.defaultSampling.cfg,
      sampler:
        typeof rawSampling.sampler === 'string' && rawSampling.sampler.trim()
          ? rawSampling.sampler.trim()
          : archPreset.defaultSampling.sampler,
      scheduler:
        typeof rawSampling.scheduler === 'string' && rawSampling.scheduler.trim()
          ? rawSampling.scheduler.trim()
          : archPreset.defaultSampling.scheduler,
      denoise:
        typeof rawSampling.denoise === 'number' && Number.isFinite(rawSampling.denoise)
          ? rawSampling.denoise
          : archPreset.defaultSampling.denoise ?? 1.0,
    },
    manualSamplingFields: [],
  };
}

export async function postCharacterToComfyUI(params: {
  comfyUrl: string;
  unetName: string;
  clipName: string;
  vaeName: string;
  characterName: string;
  positivePrompt: string;
  negativePrompt: string;
  enableFourthLora?: boolean;
  sampler?: ComfySamplerConfig;
}): Promise<{ promptId: string; usedUnetName: string; availableUnets: string[] }> {
  const baseUrl = params.comfyUrl.trim().replace(/\/+$/, '');
  if (!baseUrl) {
    throw new Error('请先填写 ComfyUI 服务地址（默认 http://127.0.0.1:8188）');
  }

  const sampler: ComfySamplerConfig = params.sampler ?? {
    width: 832,
    height: 1216,
    steps: 28,
    cfg: 4.5,
    samplerName: 'er_sde',
    scheduler: 'simple',
    denoise: 1.0,
    enableLoraChain: true,
  };

  const legacyProfile: ComfyProfile = {
    id: 'legacy-anima',
    name: 'Anima-Legacy',
    architecture: 'anima',
    loaders: {
      unet: params.unetName.trim(),
      clip: params.clipName.trim(),
      vae: params.vaeName.trim(),
      clipType: 'stable_diffusion',
      enableUnet: true,
      enableClip: true,
      enableVae: true,
    },
    loras:
      sampler.enableLoraChain !== false
        ? ANIMA_LORA_CHAIN.map((l, idx) => ({
            id: `legacy-${idx}`,
            name: l.name,
            model: l.strengthModel,
            clip: l.strengthClip,
            condition: l.ibukiOnly ? 'ibuki_only' : null,
          }))
        : [],
    sampling: {
      width: sampler.width,
      height: sampler.height,
      steps: sampler.steps,
      cfg: sampler.cfg,
      sampler: sampler.samplerName,
      scheduler: sampler.scheduler,
      denoise: sampler.denoise,
    },
  };

  const res = await postProfileToComfyUI({
    comfyUrl: baseUrl,
    profile: legacyProfile,
    characterName: params.characterName,
    positivePrompt: params.positivePrompt,
    negativePrompt: params.negativePrompt,
    enableFourthLora: params.enableFourthLora,
  });

  return {
    promptId: res.promptId,
    usedUnetName: params.unetName.trim(),
    availableUnets: [],
  };
}
