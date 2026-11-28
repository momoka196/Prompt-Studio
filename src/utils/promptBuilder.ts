import {
  ANIMA_LORA_CHAIN,
  CHARACTER_FORBIDDEN_FEATURES,
  COMFY_ARCH_DEFAULTS,
  DEFAULT_COMFY_SEED,
  EXPRESSION_PRESETS,
  HAIR_ACCESSORY_PRESETS,
  HAIR_BANGS_PRESETS,
  HairModifierPreset,
  HAIRSTYLE_PRESETS,
  MINIMAL_BACKGROUNDS,
  OUTFIT_PRESETS,
  POSE_PRESETS,
} from '../data/presets';
import {
  BuiltCharacterPrompt,
  BuiltNegativePromptResult,
  CharacterConfig,
  ComfyArchitecture,
  ComfyLoaderKey,
  ComfyLoraItem,
  ComfyProfile,
  ComfySamplerConfig,
  ConflictItem,
  MinimalBackgroundPreset,
  NegativeGuardMetadata,
  NegativeGuardRuleBadge,
  NegativeGuardRuleId,
  PromptSegment,
  SharedConfig,
  SimplePresetItem,
  WeightedSlot,
} from '../types/studio';

export const MAX_COMFY_LORAS = 16;
export const LORA_WEIGHT_MIN = -2.0;
export const LORA_WEIGHT_MAX = 2.0;

export function clampLoraWeight(w: number, fallback = 1.0): number {
  if (!Number.isFinite(w)) return fallback;
  return Math.min(LORA_WEIGHT_MAX, Math.max(LORA_WEIGHT_MIN, Math.round(w * 100) / 100));
}

export function isLoraActiveForCharacter(
  lora: ComfyLoraItem,
  enableFourthLora?: boolean
): boolean {
  if (lora.enabled === false) return false;
  if (!lora.name || !lora.name.trim()) return false;
  if (lora.condition === 'ibuki_only' && !enableFourthLora) return false;
  return true;
}

export function getActiveLorasForCharacter(
  profile: ComfyProfile | undefined,
  enableFourthLora?: boolean
): ComfyLoraItem[] {
  if (!profile?.loras) return [];
  return profile.loras
    .filter((lora) => isLoraActiveForCharacter(lora, enableFourthLora))
    .slice(0, MAX_COMFY_LORAS);
}

export function collectActiveLoraTriggerWords(
  profile: ComfyProfile | undefined,
  enableFourthLora?: boolean
): string[] {
  const activeLoras = getActiveLorasForCharacter(profile, enableFourthLora);
  const seen = new Set<string>();
  const triggers: string[] = [];
  for (const lora of activeLoras) {
    if (!lora.triggerWords || !lora.triggerWords.trim()) continue;
    for (const token of splitPromptTags(lora.triggerWords)) {
      const clean = stripWeightSyntax(token).replace(/\s+/g, ' ').trim();
      if (!clean || seen.has(clean)) continue;
      seen.add(clean);
      triggers.push(token);
    }
  }
  return triggers;
}

export function appendLoraTriggerWordsToPrompt(
  positivePrompt: string,
  triggerWords: string[]
): string {
  if (!triggerWords || triggerWords.length === 0) return positivePrompt;
  const existingClean = new Set(
    splitPromptTags(positivePrompt)
      .map((t) => stripWeightSyntax(t).replace(/\s+/g, ' ').trim())
      .filter(Boolean)
  );
  const extra: string[] = [];
  for (const token of triggerWords) {
    const clean = stripWeightSyntax(token).replace(/\s+/g, ' ').trim();
    if (!clean || existingClean.has(clean)) continue;
    existingClean.add(clean);
    extra.push(token);
  }
  if (extra.length === 0) return positivePrompt;
  const trimmed = positivePrompt.trim();
  return trimmed ? `${trimmed}, ${extra.join(', ')}` : extra.join(', ');
}

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

function findBalancedDelimiterIndices(raw: string): Set<number> {
  const paired = new Set<number>();
  const parenStack: number[] = [];
  const bracketStack: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '(') {
      parenStack.push(i);
    } else if (ch === ')') {
      const openIdx = parenStack.pop();
      if (openIdx !== undefined) {
        paired.add(openIdx);
        paired.add(i);
      }
    } else if (ch === '[') {
      bracketStack.push(i);
    } else if (ch === ']') {
      const openIdx = bracketStack.pop();
      if (openIdx !== undefined) {
        paired.add(openIdx);
        paired.add(i);
      }
    }
  }
  return paired;
}

export function splitPromptTags(raw: string): string[] {
  const paired = findBalancedDelimiterIndices(raw);
  const result: string[] = [];
  let current = '';
  let depth = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if ((ch === '(' || ch === '[') && paired.has(i)) {
      depth += 1;
      current += ch;
    } else if ((ch === ')' || ch === ']') && paired.has(i)) {
      depth = Math.max(0, depth - 1);
      current += ch;
    } else if ((ch === ',' || ch === '，' || ch === '\n') && depth === 0) {
      const trimmed = current.trim();
      if (trimmed) result.push(trimmed);
      current = '';
    } else {
      current += ch;
    }
  }
  const tail = current.trim();
  if (tail) result.push(tail);
  return result;
}

export function normalizeSlotTagsText(raw: string): string {
  const tokens = splitPromptTags(raw);
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const token of tokens) {
    const clean = stripWeightSyntax(token).replace(/\s+/g, ' ').trim();
    if (!clean) continue;
    if (seen.has(clean)) continue;
    seen.add(clean);
    deduped.push(token);
  }
  return deduped.join(', ');
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
  const tags = splitPromptTags(trimmed);
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
  activeProfile?: ComfyProfile;
  loraTriggerWords?: string[];
}

export type NegativeAutoGuardAnalysis = NegativeGuardMetadata;
export type { NegativeGuardMetadata, NegativeGuardRuleBadge, NegativeGuardRuleId };

export interface BuildEffectiveNegativeOptions {
  includeAppearance?: boolean;
  customPresets?: SimplePresetItem[];
  customBackgrounds?: MinimalBackgroundPreset[];
  selectedPresetTitles?: string[];
}

const NO_PLUSH_GUARD_TAGS = [
  '(plush:1.85)',
  '(plushie:1.85)',
  '(plush toy:1.85)',
  '(stuffed toy:1.85)',
  '(stuffed animal:1.85)',
  '(doll:1.9)',
  '(holding doll:1.9)',
  '(holding plush:1.9)',
  '(mascot:1.85)',
  '(1other:1.8)',
  '(pet:1.8)',
  '(familiar:1.85)',
  '(creature:1.85)',
  '(small creature:1.85)',
  '(cute creature:1.8)',
  '(living creature:1.7)',
  '(animal companion:1.75)',
  '(companion:1.65)',
  '(animal:1.6)',
  '(slime:1.7)',
  '(toy:1.8)',
  '(figurine:1.85)',
  '(mini figure:1.75)',
  '(nendoroid:1.7)',
  '(plush on floor:1.8)',
  '(doll on floor:1.8)',
  '(object on floor:1.65)',
  'small creature in arms',
  'creature held in arms',
  'holding a small being',
  '(chibi doll:1.75)',
  '(miniature doll:1.75)',
  '(miniature figurine:1.75)',
  '(mini clone:1.7)',
  '(look-alike:1.6)',
  '(duplicate:1.75)',
  '(clone:1.75)',
  '(multiple subjects:1.7)',
  'second character',
  'another character',
  'two characters in frame',
];

const ANTI_DUPLICATE_ONLY_TAGS = [
  '(1other:1.7)',
  '(pet:1.75)',
  '(familiar:1.8)',
  '(living creature:1.7)',
  '(animal companion:1.7)',
  '(slime:1.65)',
  '(figurine:1.75)',
  '(nendoroid:1.65)',
  '(plush on floor:1.7)',
  '(doll on floor:1.7)',
  '(chibi doll:1.7)',
  '(miniature doll:1.7)',
  '(miniature figurine:1.7)',
  '(mini clone:1.65)',
  '(look-alike:1.6)',
  '(duplicate:1.75)',
  '(clone:1.75)',
  '(multiple subjects:1.65)',
  'second character',
  'another character',
  'two characters in frame',
];

const PAJAMA_BED_GUARD_TAGS = [
  'bed',
  'on bed',
  'standing on bed',
  'lying on bed',
  'sitting on bed',
];

const PAJAMA_PLUSH_GUARD_TAGS = ['plush toy', 'stuffed toy', 'doll'];

const HAND_SAFETY_GUARD_TAGS = ['extra fingers', 'fused fingers', 'extra arms'];

const PLUSH_KEYWORD_RE =
  /\b(?:plush(?:ie|ies)?|stuffed\s+(?:toy|animal|bear|bunny|rabbit)s?|teddy\s*bear|dolls?|mascots?|holding\s+(?:a\s+)?(?:doll|plush(?:ie)?))\b|玩偶|毛绒(?:玩偶|玩具|公仔|小熊|兔)|公仔/i;

const PAJAMA_KEYWORD_RE =
  /\b(?:pajamas?|pyjamas?|nightwear|sleepwear|loungewear|roomwear|homewear|nightgown)\b|睡衣|居家服|家居服/i;

export const FORBIDDEN_TAGS_MAP = {
  generalAntiTexture: [
    'plastic skin',
    'doll-like',
    'mannequin',
    'smooth plastic',
    'doll skin',
    'doll face',
    'doll joints',
    'ball-jointed doll',
    'bjd',
    'porcelain skin',
    'plastic texture',
    'plastic look',
    'plastic shine',
    'plastic sheen',
    'waxy skin',
    'wax skin',
    'vinyl skin',
    'vinyl texture',
    'rubber skin',
    'rubbery skin',
    'latex skin',
    'glossy skin',
    'synthetic skin',
    'artificial skin',
    'fake skin',
    'resin skin',
  ],
} as const;

function escapeRegExpTerm(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const GENERAL_ANTI_TEXTURE_PHRASE_PATTERN = FORBIDDEN_TAGS_MAP.generalAntiTexture
  .slice()
  .sort((a, b) => b.length - a.length)
  .map((term) => escapeRegExpTerm(term).replace(/\s+/g, '\\s+'))
  .join('|');

const DOLL_PLASTIC_TEXTURE_TAG_RE = new RegExp(
  `\\b(?:${GENERAL_ANTI_TEXTURE_PHRASE_PATTERN}|doll[- ]?like|doll[- ]?skin|doll[- ]?face|doll[- ]?joints?|ball[- ]?jointed\\s*doll|plastic\\s*skin|smooth\\s*plastic)\\b|^plastic$`,
  'i'
);

const DOLL_PLASTIC_FULLTEXT_WEIGHTED_RE = new RegExp(
  `\\(\\s*(?:${GENERAL_ANTI_TEXTURE_PHRASE_PATTERN}|doll[- ]?like|doll[- ]?skin|doll[- ]?face|doll[- ]?joints?|ball[- ]?jointed\\s*doll|plastic\\s*skin|smooth\\s*plastic)\\s*:[0-9.]+\\s*\\)`,
  'gi'
);

const DOLL_PLASTIC_FULLTEXT_BARE_RE = new RegExp(
  `\\b(?:${GENERAL_ANTI_TEXTURE_PHRASE_PATTERN}|doll[- ]?like|doll[- ]?skin|doll[- ]?face|doll[- ]?joints?|ball[- ]?jointed\\s*doll|plastic\\s*skin|smooth\\s*plastic)\\b`,
  'gi'
);

export function isDollPlasticTextureTag(raw: string): boolean {
  const clean = stripWeightSyntax(raw).replace(/\s+/g, ' ').trim();
  if (!clean) return false;
  if (
    FORBIDDEN_TAGS_MAP.generalAntiTexture.some(
      (forbidden) => clean === forbidden || clean.includes(forbidden)
    )
  ) {
    return true;
  }
  return DOLL_PLASTIC_TEXTURE_TAG_RE.test(clean);
}

export function stripForbiddenAntiTextureFullText(rawText: string): {
  cleanedText: string;
  removedTerms: string[];
} {
  if (!rawText || !rawText.trim()) {
    return { cleanedText: rawText, removedTerms: [] };
  }
  const removed = new Set<string>();
  let next = rawText.replace(DOLL_PLASTIC_FULLTEXT_WEIGHTED_RE, (match) => {
    const clean = stripWeightSyntax(match).replace(/\s+/g, ' ').trim();
    if (clean) removed.add(clean);
    return '';
  });
  next = next.replace(DOLL_PLASTIC_FULLTEXT_BARE_RE, (match) => {
    const clean = match.replace(/\s+/g, ' ').trim().toLowerCase();
    if (clean) removed.add(clean);
    return '';
  });

  // 清理残余的空括号权重包装与多余逗号
  next = next
    .replace(/\(\s*(?:,\s*)*:[0-9.]+\s*\)/g, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s*,\s*(?:,\s*)+/g, ', ')
    .replace(/^[\s,，]+|[\s,，]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return {
    cleanedText: next,
    removedTerms: Array.from(removed),
  };
}

const VISIBLE_FINGER_HAND_ACTION_RE =
  /\b(?:touching chin|index fingers?|finger|peace sign|v sign|double peace|finger gun|pointing|salute|holding|hug|hugging|cupping|hand on cheek|one hand near cheek|hands on own thighs|hands resting|hands clasped|fidgeting fingers|touching hair|touching chest ribbon|arms crossed|arms at sides|both arms slightly raised|hands behind back|arms behind head|hand on own|covering lower face|peeking through fingers|fists|waving|reaching one hand|outstretched arms|forming heart with hands|hand on hip)\b/i;

const POSE_HANDS_BUSY_RE =
  /\b(?:with both hands|both hands|holding|hugging|hug|hands behind back|arms behind head|arms crossed|hands clasped|double peace|forming heart|both fists|hand on hip|one hand touching chin|index fingers?)\b/i;

const OUTDOOR_BG_RE =
  /\b(?:outdoor|park|meadow|sky|clouds|starry|night sky|sakura|cherry blossom|fireflies|street|beach|poolside|garden|forest)\b/i;

const STUDIO_BG_RE =
  /\b(?:photography studio|seamless white backdrop|studio backdrop|white backdrop)\b/i;

const NON_CLASSROOM_INDOOR_BG_RE =
  /\b(?:bedroom|living room|sofa|cafe|kitchen|bathroom)\b/i;

const CLASSROOM_BG_RE = /\b(?:classroom|school|desk|chalkboard)\b/i;

const EXPR_CLOSED_OR_WIDE_EYES_RE =
  /\b(?:closed eyes|eyes closed|closed-eye|half-closed eyes|sleepy|wide eyes|wide bright eyes|wide watery eyes|star-shaped pupils|heart-shaped pupils)\b|>_</i;

const EXPR_CLOSED_OR_HALF_EYES_RE =
  /\b(?:closed eyes|eyes closed|closed-eye|half-closed eyes|sleepy|one eye closed|wink|winking|blank stare|peeking through fingers|peeking eyes)\b|>_</i;

const EXPR_BLUSH_RE = /\b(?:blush|blushing|rosy cheeks)\b/i;

const GAZE_AWAY_OR_DOWN_RE =
  /\b(?:looking down at pages|averted gaze|turning head back|looking back at viewer|looking away|looking aside|looking to the side|sideways glance|glancing away|upturned pleading gaze|dreamy gaze|curious gaze|shy|closed eyes|eyes closed|closed-eye|blank stare)\b/i;

const EXPLICIT_STANDING_TAG_RE =
  /\b(?:standing(?:\s+(?:firmly|upright|straight|naturally|casually|on\s+tiptoes|on\s+one\s+leg|firmly\s+on\s+(?:one\s+leg|ground)|pose|still|tall|relaxed))?|stand\s+upright|upright\s+posture|feet\s+planted(?:\s+on\s+ground)?|both\s+feet\s+(?:planted\s+)?on\s+(?:the\s+)?ground)\b/i;

const STRONG_STANDING_ANCHOR_RE =
  /\b(?:standing\s+(?:firmly|upright|straight)|stand\s+upright|upright\s+posture|feet\s+planted\s+on\s+ground|both\s+feet\s+(?:planted\s+)?on\s+(?:the\s+)?ground)\b/i;

const SITTING_OR_CROUCHING_TAG_RE =
  /\b(?:sitting|seated|sit|kneeling|seiza|squatting|crouching|lying|wariza)\b/i;

const ANTI_SITTING_GUARD_TAGS = [
  '(sitting:1.7)',
  '(seated:1.65)',
  'sitting on chair',
  'sitting on desk',
  'sitting on floor',
];

const ANTI_TOP_HEAD_BOW_GUARD_TAGS = [
  '(bow on top of head:1.7)',
  '(hair bow on top of head:1.7)',
  '(top hair bow:1.65)',
  '(center hair bow:1.6)',
  '(front hair bow:1.6)',
  '(bow on crown of head:1.6)',
  '(headband bow:1.55)',
];

const ANTI_NO_HAIR_BOW_GUARD_TAGS = [
  '(hair bow:1.7)',
  '(black hair bow:1.7)',
  '(black bow:1.7)',
  '(hair bow on the side:1.6)',
];

export function isExplicitStandingPoseText(poseText: string): boolean {
  const trimmed = poseText.trim();
  if (!trimmed) return false;
  return EXPLICIT_STANDING_TAG_RE.test(trimmed) && !SITTING_OR_CROUCHING_TAG_RE.test(trimmed);
}

export function computeEffectiveSlotWeight(
  slotKey: string,
  rawText: string,
  configuredWeight: number
): number {
  const base = clampWeight(configuredWeight);
  if (slotKey === 'pose' && isExplicitStandingPoseText(rawText)) {
    const floor = STRONG_STANDING_ANCHOR_RE.test(rawText) ? 1.6 : 1.55;
    return clampWeight(Math.max(floor, base + 0.15));
  }
  return base;
}

const LEGACY_INITIAL_APPEARANCE_EXPR_TOKENS = new Set<string>([
  'gentle smile',
  'looking at viewer',
  'big eyes',
  'blush',
]);

const BUILTIN_CHAR_IDS_FOR_APPEARANCE_CLEAN = new Set<string>([
  'char-lan',
  'char-yi',
  'char-mari',
  'char-hoshino',
]);

export function stripLegacyExpressionTokensFromAppearance(
  charId: string,
  appearanceText: string
): string {
  if (!BUILTIN_CHAR_IDS_FOR_APPEARANCE_CLEAN.has(charId)) {
    return appearanceText;
  }
  const tokens = splitPromptTags(appearanceText);
  if (tokens.length === 0) return appearanceText;
  return tokens
    .filter((token) => {
      const clean = stripWeightSyntax(token).replace(/\s+/g, ' ').trim();
      return !LEGACY_INITIAL_APPEARANCE_EXPR_TOKENS.has(clean);
    })
    .join(', ');
}

const YI_HAIR_ACCESSORY_TOKENS = new Set<string>([
  'black bow',
  'hair bow on the side',
  'black hair bow',
  'black bow tying side ponytail',
  'ponytail tied with black bow',
  'black ribbon tying side ponytail',
  'two hair bows',
  ...HAIR_ACCESSORY_PRESETS.flatMap((acc) =>
    splitPromptTags(acc.tags).map((t) =>
      stripWeightSyntax(t).replace(/\s+/g, ' ').trim()
    )
  ).filter(Boolean),
]);

const YI_HAIR_BANGS_TOKENS = new Set<string>(
  HAIR_BANGS_PRESETS.flatMap((b) =>
    splitPromptTags(b.tags).map((t) =>
      stripWeightSyntax(t).replace(/\s+/g, ' ').trim()
    )
  ).filter(Boolean)
);

const YI_HAIRSTYLE_REMOVABLE_TOKENS = new Set<string>([
  'side ponytail',
  'ponytail on side',
  ...YI_HAIR_ACCESSORY_TOKENS,
  ...HAIRSTYLE_PRESETS.flatMap((preset) =>
    splitPromptTags(preset.tags).map((t) =>
      stripWeightSyntax(t).replace(/\s+/g, ' ').trim()
    )
  ).filter(Boolean),
]);

export function getCanonicalCharacterId(
  character: Pick<CharacterConfig, 'id' | 'templateId'>
): string {
  return character.templateId?.trim() || character.id;
}

export function canCustomizeCharacterHairstyle(character: CharacterConfig): boolean {
  return getCanonicalCharacterId(character) === 'char-yi';
}

function extractDefaultHairstyleTag(appearanceText: string, preferredPatterns: RegExp[], fallback: string): string {
  const tokens = splitPromptTags(appearanceText);
  for (const re of preferredPatterns) {
    const found = tokens.find((t) => re.test(stripWeightSyntax(t)));
    if (found) return found.trim();
  }
  return fallback;
}

export function getCharacterDefaultHairstyleOption(character: CharacterConfig): SimplePresetItem {
  const appText = character.appearance.text;
  const canonicalId = getCanonicalCharacterId(character);
  if (canonicalId === 'char-lan') {
    const tag = extractDefaultHairstyleTag(
      appText,
      [/^low twintails$/i, /\btwintails\b/i, /\b(?:long|short) hair\b/i],
      'low twintails'
    );
    return {
      id: 'default-lan',
      category: 'hairstyle',
      zhName: '低双马尾（蓝默认）',
      vibe: '原生默认 · 仅读取保留',
      tags: tag,
      defaultWeight: 1.0,
    };
  }
  if (canonicalId === 'char-mari') {
    const tag = extractDefaultHairstyleTag(
      appText,
      [/\bvery long low twintails\b/i, /\blow twintails\b/i, /\btwintails\b/i],
      'very long low twintails'
    );
    return {
      id: 'default-mari',
      category: 'hairstyle',
      zhName: '超长低双马尾（Mari 默认）',
      vibe: '原生默认 · 仅读取保留',
      tags: tag,
      defaultWeight: 1.0,
    };
  }
  if (canonicalId === 'char-hoshino') {
    const tag = extractDefaultHairstyleTag(
      appText,
      [/^long hair$/i, /\b(?:long|short|medium) hair\b/i],
      'long hair'
    );
    return {
      id: 'default-hoshino',
      category: 'hairstyle',
      zhName: '长发（Hoshino 默认）',
      vibe: '原生默认 · 仅读取保留',
      tags: tag,
      defaultWeight: 1.0,
    };
  }
  const customTag = extractDefaultHairstyleTag(
    appText,
    [/\b(?:twintails|ponytail|long hair|short hair|updo|bun|bob cut|braids?)\b/i],
    ''
  );
  return {
    id: `default-${character.id}`,
    category: 'hairstyle',
    zhName: '外貌默认发型',
    vibe: '跟随外貌槽位',
    tags: customTag || '由外貌槽位控制',
    defaultWeight: 1.0,
  };
}

export function inferYiHairstyleFromAppearance(appearanceText: string): SimplePresetItem | null {
  const tokenSet = new Set(
    splitPromptTags(appearanceText)
      .map((t) => stripWeightSyntax(t).replace(/\s+/g, ' ').trim())
      .filter(Boolean)
  );
  if (tokenSet.size === 0) return null;

  let bestMatch: { preset: SimplePresetItem; matchedCore: number; ratio: number } | null = null;
  for (const preset of HAIRSTYLE_PRESETS) {
    const coreTokens = splitPromptTags(preset.tags)
      .map((t) => stripWeightSyntax(t).replace(/\s+/g, ' ').trim())
      .filter((t) => t && !YI_HAIR_ACCESSORY_TOKENS.has(t));
    if (coreTokens.length === 0) continue;

    const matchedCore = coreTokens.filter((ct) => tokenSet.has(ct)).length;
    if (matchedCore === 0) continue;
    const ratio = matchedCore / coreTokens.length;
    if (ratio < 0.6) continue;

    if (
      !bestMatch ||
      matchedCore > bestMatch.matchedCore ||
      (matchedCore === bestMatch.matchedCore && ratio > bestMatch.ratio)
    ) {
      bestMatch = { preset, matchedCore, ratio };
    }
  }
  return bestMatch?.preset ?? null;
}

export function getCharacterHairstyleOptions(character: CharacterConfig): {
  options: SimplePresetItem[];
  isLockedToDefault: boolean;
  activePreset: SimplePresetItem;
  bangsOptions: HairModifierPreset[];
  activeBangs: HairModifierPreset;
  accessoryOptions: HairModifierPreset[];
  activeAccessory: HairModifierPreset;
} {
  if (canCustomizeCharacterHairstyle(character)) {
    const byId = character.hairstyleId
      ? HAIRSTYLE_PRESETS.find((p) => p.id === character.hairstyleId)
      : undefined;
    const activePreset =
      byId ?? inferYiHairstyleFromAppearance(character.appearance.text) ?? HAIRSTYLE_PRESETS[0];
    const activeBangs =
      (character.hairBangsId
        ? HAIR_BANGS_PRESETS.find((b) => b.id === character.hairBangsId)
        : undefined) ?? HAIR_BANGS_PRESETS[0];
    const activeAccessory =
      (character.hairAccessoryId
        ? HAIR_ACCESSORY_PRESETS.find((a) => a.id === character.hairAccessoryId)
        : undefined) ?? HAIR_ACCESSORY_PRESETS[0];
    return {
      options: HAIRSTYLE_PRESETS,
      isLockedToDefault: false,
      activePreset,
      bangsOptions: HAIR_BANGS_PRESETS,
      activeBangs,
      accessoryOptions: HAIR_ACCESSORY_PRESETS,
      activeAccessory,
    };
  }
  const def = getCharacterDefaultHairstyleOption(character);
  return {
    options: [def],
    isLockedToDefault: true,
    activePreset: def,
    bangsOptions: [],
    activeBangs: HAIR_BANGS_PRESETS[0],
    accessoryOptions: [],
    activeAccessory: HAIR_ACCESSORY_PRESETS[0],
  };
}

export interface HairstylePairingApplyOptions {
  bangsTags?: string;
  accessoryId?: string | null;
  accessoryTags?: string;
}

export function composeHairstyleTagsWithAccessory(
  presetTags: string,
  accessoryId?: string | null,
  accessoryTags?: string
): string[] {
  const baseTokens = splitPromptTags(presetTags);
  if (!accessoryId || accessoryId === 'acc-preset-bow') {
    return baseTokens;
  }
  const nonAccessoryTokens = baseTokens.filter((token) => {
    const clean = stripWeightSyntax(token).replace(/\s+/g, ' ').trim();
    return !YI_HAIR_ACCESSORY_TOKENS.has(clean);
  });
  if (accessoryId === 'acc-none') {
    return nonAccessoryTokens;
  }
  const customAccTokens = splitPromptTags(accessoryTags ?? '');
  return [...nonAccessoryTokens, ...customAccTokens];
}

export function applyHairstyleToAppearanceText(
  appearanceText: string,
  presetTags: string,
  pairing?: HairstylePairingApplyOptions
): string {
  const tokens = splitPromptTags(appearanceText);
  const replacementTokens = composeHairstyleTagsWithAccessory(
    presetTags,
    pairing?.accessoryId,
    pairing?.accessoryTags
  );
  const replaceBangs = pairing?.bangsTags !== undefined;
  const replacementBangsTokens = replaceBangs
    ? splitPromptTags(pairing.bangsTags ?? '')
    : [];

  if (tokens.length === 0) {
    return [...replacementTokens, ...replacementBangsTokens].join(', ');
  }

  let insertHairIdx = -1;
  let insertBangsIdx = -1;
  let blondeIndex = -1;

  tokens.forEach((token, idx) => {
    const clean = stripWeightSyntax(token).replace(/\s+/g, ' ').trim();
    if (insertHairIdx === -1 && YI_HAIRSTYLE_REMOVABLE_TOKENS.has(clean)) {
      insertHairIdx = idx;
    }
    if (insertBangsIdx === -1 && YI_HAIR_BANGS_TOKENS.has(clean)) {
      insertBangsIdx = idx;
    }
    if (blondeIndex === -1 && clean === 'blonde hair') {
      blondeIndex = idx;
    }
  });

  if (insertHairIdx === -1) {
    insertHairIdx = blondeIndex >= 0 ? blondeIndex + 1 : 0;
  }

  const out: string[] = [];
  let hairInserted = false;
  let bangsInserted = !replaceBangs;

  tokens.forEach((token, idx) => {
    if (!hairInserted && idx === insertHairIdx) {
      out.push(...replacementTokens);
      hairInserted = true;
    }
    if (!bangsInserted && insertBangsIdx >= 0 && idx === insertBangsIdx) {
      out.push(...replacementBangsTokens);
      bangsInserted = true;
    }
    const clean = stripWeightSyntax(token).replace(/\s+/g, ' ').trim();
    if (YI_HAIRSTYLE_REMOVABLE_TOKENS.has(clean)) return;
    if (replaceBangs && YI_HAIR_BANGS_TOKENS.has(clean)) return;
    out.push(token);
  });

  if (!hairInserted) {
    out.push(...replacementTokens);
  }
  if (!bangsInserted) {
    // If appearance had no prior bangs tokens, place bangs right after hairstyle replacement
    const lastHairToken = replacementTokens[replacementTokens.length - 1];
    const anchorIdx = lastHairToken ? out.indexOf(lastHairToken) : -1;
    if (anchorIdx >= 0) {
      out.splice(anchorIdx + 1, 0, ...replacementBangsTokens);
    } else {
      out.push(...replacementBangsTokens);
    }
  }

  return out.join(', ');
}

export function resolveEffectiveAppearanceSlot(character: CharacterConfig): WeightedSlot {
  if (!canCustomizeCharacterHairstyle(character)) {
    return character.appearance;
  }
  const { activePreset, activeBangs, activeAccessory } =
    getCharacterHairstyleOptions(character);
  return {
    ...character.appearance,
    text: applyHairstyleToAppearanceText(character.appearance.text, activePreset.tags, {
      bangsTags: activeBangs.tags,
      accessoryId: activeAccessory.id,
      accessoryTags: activeAccessory.tags,
    }),
  };
}

interface ResolvedCharacterPromptData {
  segments: PromptSegment[];
  fullText: string;
  resolvedAdjustments: string[];
  filteredAntiTextureTags: string[];
  hasBackgroundLock: boolean;
  hasHandSleeveConflict: boolean;
  hasPoseExprGuard: boolean;
}

function resolveAndBuildCharacterSegments(
  shared: SharedConfig,
  character: CharacterConfig,
  includeAppearance: boolean
): ResolvedCharacterPromptData {
  const resolvedAdjustments: string[] = [];
  const filteredAntiTextureSet = new Set<string>();
  const bgRaw = shared.background.text.trim();
  const hasBackgroundLock = bgRaw.length > 0;
  const compRaw = shared.composition.text.trim();
  const effectiveAppearanceSlot = resolveEffectiveAppearanceSlot(character);
  const appRaw = includeAppearance ? effectiveAppearanceSlot.text.trim() : '';
  const outfitRaw = character.outfit.text.trim();
  const poseRaw = character.pose.text.trim();
  const exprRaw = character.expression.text.trim();

  const hasFullBodyComp = /\b(?:full body|entire body visible|head to toe)\b/i.test(compRaw);
  const bgIsOutdoor = OUTDOOR_BG_RE.test(bgRaw);
  const bgIsStudio = STUDIO_BG_RE.test(bgRaw);
  const bgIsNonClassroomIndoor = NON_CLASSROOM_INDOOR_BG_RE.test(bgRaw) && !CLASSROOM_BG_RE.test(bgRaw);

  let hasHandSleeveConflict = false;
  let hasPoseExprGuard = false;
  let hasBgGuardAdjust = false;

  const outfitHasHiddenHands = /\bhands hidden in sleeves\b/i.test(outfitRaw);
  const poseOrExprNeedsHands =
    VISIBLE_FINGER_HAND_ACTION_RE.test(poseRaw) || VISIBLE_FINGER_HAND_ACTION_RE.test(exprRaw);
  if (outfitHasHiddenHands && poseOrExprNeedsHands) {
    hasHandSleeveConflict = true;
    resolvedAdjustments.push('解除「手藏袖中」与手指/持物动作的遮挡冲突');
  }

  const poseOccupyHands = POSE_HANDS_BUSY_RE.test(poseRaw);
  const exprCoversFaceWithHands = /\b(?:covering lower face with hands|peeking through fingers)\b/i.test(
    exprRaw
  );
  if (poseOccupyHands && exprCoversFaceWithHands) {
    hasPoseExprGuard = true;
    resolvedAdjustments.push('保留动作手部姿态，清理表情中重复的双手遮脸词避免多手畸形');
  }

  const exprHasText = exprRaw.length > 0;
  const exprClosedOrWideEyes = EXPR_CLOSED_OR_WIDE_EYES_RE.test(exprRaw);
  const exprClosedOrHalfEyes = EXPR_CLOSED_OR_HALF_EYES_RE.test(exprRaw);
  const exprHasBlush = EXPR_BLUSH_RE.test(exprRaw);
  const poseOrExprRedirectsGaze =
    GAZE_AWAY_OR_DOWN_RE.test(poseRaw) || GAZE_AWAY_OR_DOWN_RE.test(exprRaw);

  const appearanceHasHairOrnament =
    /\b(?:hair bow|black bow|red bow|white bow|two hair bows|hair bow on the side|black bow tying side ponytail|hair ribbon|hairclip|pearl hair ornament)\b/i.test(
      appRaw
    );

  const cleanTagsForSlot = (key: string, rawText: string): string => {
    const preScrubbed = stripForbiddenAntiTextureFullText(rawText);
    if (preScrubbed.removedTerms.length > 0) {
      hasPoseExprGuard = true;
      preScrubbed.removedTerms.forEach((t) => filteredAntiTextureSet.add(t));
      resolvedAdjustments.push('已对正向进行全文级严格过滤，移除类玩偶/塑料质感词，提升画面自然度');
    }

    const tokens = splitPromptTags(preScrubbed.cleanedText);
    const out: string[] = [];

    for (const token of tokens) {
      const clean = stripWeightSyntax(token).replace(/\s+/g, ' ').trim();
      if (!clean) continue;

      // 过滤类玩偶/塑料质感词，保持自然皮肤质感
      if (isDollPlasticTextureTag(clean)) {
        hasPoseExprGuard = true;
        filteredAntiTextureSet.add(clean);
        resolvedAdjustments.push('已对正向进行全文级严格过滤，移除类玩偶/塑料质感词，提升画面自然度');
        continue;
      }

      // 背景锁定：非背景槽位不允许自带 * background 覆盖场景
      if (hasBackgroundLock && key !== 'background' && /\bbackground\b/i.test(clean)) {
        hasBgGuardAdjust = true;
        continue;
      }

      // 服装 vs 动作/表情：手藏袖中与手部交互冲突
      if (key === 'outfit' && hasHandSleeveConflict && clean === 'hands hidden in sleeves') {
        continue;
      }

      // 服装 vs 发型发饰：已选蝴蝶结/发夹时清理服装中的 hair without hairbow
      if (key === 'outfit' && appearanceHasHairOrnament && clean === 'hair without hairbow') {
        hasPoseExprGuard = true;
        resolvedAdjustments.push('保留当前发型发饰，自动移除服装中的「hair without hairbow」冲突词');
        continue;
      }

      // 外貌 vs 表情 / 动作：已有显式表情时，清理外貌中残留的微笑/脸红/视线/眼型冲突词，避免覆盖可爱预设表情
      if (key === 'appearance') {
        if (
          exprHasText &&
          /^(?:gentle smile|soft smile|smile|happy|neutral expression|expressionless|blush|blushing|rosy cheeks)$/.test(
            clean
          )
        ) {
          hasPoseExprGuard = true;
          continue;
        }
        if (exprHasBlush && clean === 'blush') {
          continue;
        }
        if (exprClosedOrHalfEyes && /^(?:big eyes|tareme)$/.test(clean)) {
          hasPoseExprGuard = true;
          continue;
        }
        if ((poseOrExprRedirectsGaze || exprClosedOrHalfEyes) && clean === 'looking at viewer') {
          hasPoseExprGuard = true;
          continue;
        }
      }

      // 动作 vs 背景 / 构图 / 表情
      if (key === 'pose') {
        // 构图要求全身时，清理冲突的半身/大腿裁剪词
        if (
          hasFullBodyComp &&
          /^(?:upper body visible|thighs visible|cowboy shot|portrait)$/.test(clean)
        ) {
          hasBgGuardAdjust = true;
          resolvedAdjustments.push('已锁定「全身构图」，移除动作中冲突的半身裁剪词');
          continue;
        }
        // 背景是非教室（户外/影棚/卧室/客厅）时，清理课桌靠窗等固定场景家具词
        if (hasBackgroundLock && (bgIsOutdoor || bgIsStudio || bgIsNonClassroomIndoor)) {
          if (/^(?:sitting by window|wooden school desk|wooden chair)$/.test(clean)) {
            hasBgGuardAdjust = true;
            continue;
          }
          if (clean === 'sitting at desk') {
            hasBgGuardAdjust = true;
            out.push('sitting');
            continue;
          }
        }
        // 户外场景下将室内地板坐姿收敛为自然坐姿
        if (hasBackgroundLock && bgIsOutdoor && clean === 'sitting on floor') {
          hasBgGuardAdjust = true;
          out.push('sitting');
          continue;
        }
        // 已有显式表情时，去掉动作自带表情词与冲突眨眼/困倦状态
        if (exprHasText) {
          if (/^(?:gentle smile|soft smile|smile)$/.test(clean)) {
            hasPoseExprGuard = true;
            continue;
          }
          if (!/\bsleepy\b/i.test(exprRaw) && clean === 'sleepy relaxed posture') {
            hasPoseExprGuard = true;
            resolvedAdjustments.push('已按选定表情调和动作中的困倦状态词');
            out.push('relaxed posture');
            continue;
          }
          if (exprClosedOrWideEyes && /^(?:winking at camera|wink|one eye closed)$/.test(clean)) {
            hasPoseExprGuard = true;
            resolvedAdjustments.push('已按选定表情的眼部状态调和动作中的眨眼词');
            continue;
          }
        }
        if (
          GAZE_AWAY_OR_DOWN_RE.test(exprRaw) &&
          /^(?:looking at viewer|looking back at viewer)$/.test(clean)
        ) {
          hasPoseExprGuard = true;
          continue;
        }
      }

      // 表情 vs 动作：双手忙时避免再叠加双手遮脸/指缝偷瞄
      if (key === 'expression' && poseOccupyHands) {
        if (/^(?:covering lower face with hands|peeking through fingers)$/.test(clean)) {
          continue;
        }
      }

      out.push(token);
    }

    if (hasBgGuardAdjust && !resolvedAdjustments.some((m) => m.includes('背景'))) {
      resolvedAdjustments.push('已锁定全局背景设定，清理动作中与当前空间/构图冲突的场景词');
    }

    // 槽位内部去重
    const slotSeen = new Set<string>();
    const slotDeduped: string[] = [];
    for (const t of out) {
      const clean = stripWeightSyntax(t).replace(/\s+/g, ' ').trim();
      if (!clean || slotSeen.has(clean)) continue;
      slotSeen.add(clean);
      slotDeduped.push(t);
    }

    if (key === 'pose' && isExplicitStandingPoseText(slotDeduped.join(', '))) {
      const standingTokens: string[] = [];
      const detailTokens: string[] = [];
      for (const tok of slotDeduped) {
        const cleanTok = stripWeightSyntax(tok).replace(/\s+/g, ' ').trim();
        if (EXPLICIT_STANDING_TAG_RE.test(cleanTok)) {
          standingTokens.push(tok);
        } else {
          detailTokens.push(tok);
        }
      }
      const hasStrongAnchor = standingTokens.some((tok) =>
        STRONG_STANDING_ANCHOR_RE.test(stripWeightSyntax(tok))
      );
      if (!hasStrongAnchor && !/\bstanding on (?:tiptoes|one leg)\b/i.test(standingTokens.join(', '))) {
        standingTokens.unshift('standing upright');
      }
      return [...standingTokens, ...detailTokens].join(', ');
    }

    return slotDeduped.join(', ');
  };

  const isStandingPosePriority = isExplicitStandingPoseText(poseRaw);

  const candidates: {
    key: string;
    label: string;
    layer: 'shared' | 'character';
    slot: WeightedSlot;
  }[] = [
    { key: 'styleAnchor', label: '画风', layer: 'shared', slot: shared.styleAnchor },
    { key: 'appearance', label: '外貌', layer: 'character', slot: effectiveAppearanceSlot },
    ...(shared.bodyType && shared.bodyType.text.trim()
      ? [{ key: 'bodyType', label: '体型', layer: 'shared' as const, slot: shared.bodyType }]
      : []),
    ...(isStandingPosePriority
      ? [
          { key: 'pose', label: '动作', layer: 'character' as const, slot: character.pose },
          { key: 'outfit', label: '服装', layer: 'character' as const, slot: character.outfit },
        ]
      : [
          { key: 'outfit', label: '服装', layer: 'character' as const, slot: character.outfit },
          { key: 'pose', label: '动作', layer: 'character' as const, slot: character.pose },
        ]),
    { key: 'expression', label: '表情', layer: 'character', slot: character.expression },
    { key: 'composition', label: '构图', layer: 'shared', slot: shared.composition },
    { key: 'background', label: '场景', layer: 'shared', slot: shared.background },
  ];

  const globalSeenClean = new Set<string>();
  const segments: PromptSegment[] = [];

  for (const item of candidates) {
    if (!includeAppearance && item.key === 'appearance') continue;
    if (!item.slot.text.trim()) continue;

    const cleaned = cleanTagsForSlot(item.key, item.slot.text);
    if (!cleaned) continue;

    // 跨槽位全局去重（保留首次出现的词条，避免重复如 looking at viewer, blush, standing）
    const crossDeduped: string[] = [];
    for (const token of splitPromptTags(cleaned)) {
      const clean = stripWeightSyntax(token).replace(/\s+/g, ' ').trim();
      if (!clean) continue;
      if (globalSeenClean.has(clean)) continue;
      globalSeenClean.add(clean);
      crossDeduped.push(token);
    }

    const finalRaw = crossDeduped.join(', ');
    if (!finalRaw) continue;

    const slotFullTextFiltered = stripForbiddenAntiTextureFullText(finalRaw);
    if (slotFullTextFiltered.removedTerms.length > 0) {
      hasPoseExprGuard = true;
      slotFullTextFiltered.removedTerms.forEach((t) => filteredAntiTextureSet.add(t));
      resolvedAdjustments.push('已对正向进行全文级严格过滤，移除类玩偶/塑料质感词，提升画面自然度');
    }
    const strictlyFilteredRaw = slotFullTextFiltered.cleanedText;
    if (!strictlyFilteredRaw) continue;

    const effectiveWeight = computeEffectiveSlotWeight(
      item.key,
      strictlyFilteredRaw,
      item.slot.weight
    );
    const formatted = formatWeightedText(strictlyFilteredRaw, effectiveWeight);
    segments.push({
      key: item.key,
      label: item.label,
      layer: item.layer,
      rawText: strictlyFilteredRaw,
      weight: effectiveWeight,
      formatted,
    });
  }

  const baseText = segments.map((s) => s.formatted).join(', ');
  const hasSolo = /\bsolo\b/i.test(baseText);
  const has1Girl = /\b1girl\b/i.test(baseText);
  const soloPrefix = [!hasSolo ? '(solo:1.25)' : '', !has1Girl ? '1girl' : '']
    .filter(Boolean)
    .join(', ');
  const soloAnchor = soloPrefix ? `${soloPrefix}, ` : '';
  const assembledFullText = soloAnchor + baseText;
  const fullTextPass = stripForbiddenAntiTextureFullText(assembledFullText);
  if (fullTextPass.removedTerms.length > 0) {
    hasPoseExprGuard = true;
    fullTextPass.removedTerms.forEach((t) => filteredAntiTextureSet.add(t));
    resolvedAdjustments.push('已对正向进行全文级严格过滤，移除类玩偶/塑料质感词，提升画面自然度');
  }
  return {
    segments,
    fullText: fullTextPass.cleanedText,
    resolvedAdjustments: Array.from(new Set(resolvedAdjustments)),
    filteredAntiTextureTags: Array.from(filteredAntiTextureSet),
    hasBackgroundLock,
    hasHandSleeveConflict,
    hasPoseExprGuard,
  };
}

export function buildCharacterPrompt(
  shared: SharedConfig,
  character: CharacterConfig,
  options: BuildPromptOptions = {}
): BuiltCharacterPrompt {
  const includeAppearance = options.includeAppearance ?? true;
  const resolved = resolveAndBuildCharacterSegments(shared, character, includeAppearance);

  const rawTriggerWords = [
    ...(options.activeProfile
      ? collectActiveLoraTriggerWords(options.activeProfile, Boolean(character.enableFourthLora))
      : []),
    ...(options.loraTriggerWords ?? []),
  ];

  if (rawTriggerWords.length === 0) {
    return {
      fullText: resolved.fullText,
      segments: resolved.segments,
      resolvedAdjustments: resolved.resolvedAdjustments,
    };
  }

  const existingClean = new Set(
    splitPromptTags(resolved.fullText)
      .map((t) => stripWeightSyntax(t).replace(/\s+/g, ' ').trim())
      .filter(Boolean)
  );
  const dedupedTriggers: string[] = [];
  for (const token of rawTriggerWords) {
    const preScrubbed = stripForbiddenAntiTextureFullText(token).cleanedText;
    for (const part of splitPromptTags(preScrubbed)) {
      const clean = stripWeightSyntax(part).replace(/\s+/g, ' ').trim();
      if (!clean || existingClean.has(clean) || isDollPlasticTextureTag(part)) continue;
      existingClean.add(clean);
      dedupedTriggers.push(part);
    }
  }

  if (dedupedTriggers.length === 0) {
    return {
      fullText: resolved.fullText,
      segments: resolved.segments,
      resolvedAdjustments: resolved.resolvedAdjustments,
    };
  }

  const triggerText = dedupedTriggers.join(', ');
  const nextFullText = resolved.fullText ? `${resolved.fullText}, ${triggerText}` : triggerText;
  return {
    fullText: nextFullText,
    segments: [
      ...resolved.segments,
      {
        key: 'loraTriggers',
        label: 'LoRA词',
        layer: 'shared',
        rawText: triggerText,
        weight: 1.0,
        formatted: triggerText,
      },
    ],
    resolvedAdjustments: resolved.resolvedAdjustments,
  };
}

export function buildSharedNegativePrompt(shared: SharedConfig): string {
  const rawParts: string[] = [];
  if (shared.manualNegativeOverride !== null) {
    rawParts.push(...splitPromptTags(shared.manualNegativeOverride));
  } else {
    for (const group of shared.negativeGroups) {
      if (!group.enabled) continue;
      for (const tag of group.tags) {
        const formatted = formatWeightedText(tag.text, tag.weight);
        if (formatted) rawParts.push(formatted);
      }
    }
  }

  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const part of rawParts) {
    const clean = stripWeightSyntax(part).replace(/\s+/g, ' ').trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    deduped.push(part);
  }
  return deduped.join(', ');
}

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
    ...HAIRSTYLE_PRESETS,
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
    if (canCustomizeCharacterHairstyle(char)) {
      const activeHair = getCharacterHairstyleOptions(char).activePreset;
      extraTexts.push(activeHair.zhName, activeHair.vibe);
    }
  }

  if (options.selectedPresetTitles && options.selectedPresetTitles.length > 0) {
    extraTexts.push(...options.selectedPresetTitles);
  }
  return extraTexts;
}

export function buildNegativePromptWithMeta(
  shared: SharedConfig,
  targetCharacters: CharacterConfig | CharacterConfig[],
  options: BuildEffectiveNegativeOptions = {}
): BuiltNegativePromptResult {
  const charList = Array.isArray(targetCharacters)
    ? targetCharacters
    : [targetCharacters];
  const includeAppearance = options.includeAppearance ?? true;

  const charResolutions = charList.map((char) =>
    resolveAndBuildCharacterSegments(shared, char, includeAppearance)
  );
  const hasBackgroundLock = Boolean(shared.background.text.trim());
  const hasHandSleeveConflict = charResolutions.some((r) => r.hasHandSleeveConflict);
  const hasPoseExprGuard = charResolutions.some((r) => r.hasPoseExprGuard);
  const resolvedAdjustments = Array.from(
    new Set(charResolutions.flatMap((r) => r.resolvedAdjustments))
  );

  const positiveTexts: string[] = [
    shared.styleAnchor.text,
    shared.background.text,
    shared.composition.text,
    shared.bodyType?.text ?? '',
    ...charList.flatMap((c) => [
      includeAppearance ? resolveEffectiveAppearanceSlot(c).text : '',
      c.outfit.text,
      c.pose.text,
      c.expression.text,
    ]),
    ...collectMatchedPresetText(shared, charList, options),
  ];

  const combinedPositive = positiveTexts.filter(Boolean).join(' , ');
  const hasExplicitPlush = PLUSH_KEYWORD_RE.test(combinedPositive);
  const hasPajama = PAJAMA_KEYWORD_RE.test(combinedPositive);
  const hasExplicitStandingPose =
    charList.some((c) => isExplicitStandingPoseText(c.pose.text)) &&
    !SITTING_OR_CROUCHING_TAG_RE.test(combinedPositive);

  const rawBaseNegativePrompt = buildSharedNegativePrompt(shared).trim();
  const filteredDollPlasticTags: string[] = Array.from(
    new Set(charResolutions.flatMap((r) => r.filteredAntiTextureTags))
  );
  const filteredBaseParts: string[] = [];
  const existingCleanSet = new Set<string>();
  if (rawBaseNegativePrompt) {
    const negFullTextPass = stripForbiddenAntiTextureFullText(rawBaseNegativePrompt);
    for (const term of negFullTextPass.removedTerms) {
      if (!filteredDollPlasticTags.includes(term)) {
        filteredDollPlasticTags.push(term);
      }
    }
    for (const part of splitPromptTags(negFullTextPass.cleanedText)) {
      const clean = stripWeightSyntax(part).replace(/\s+/g, ' ').trim();
      if (!clean) continue;
      if (isDollPlasticTextureTag(part)) {
        if (!filteredDollPlasticTags.includes(clean)) {
          filteredDollPlasticTags.push(clean);
        }
        continue;
      }
      filteredBaseParts.push(part);
      existingCleanSet.add(clean);
    }
  }
  const baseNegativePrompt = filteredBaseParts.join(', ');

  const appendedTags: string[] = [];
  const seenAddedClean = new Set<string>();
  const pushUnique = (tag: string) => {
    const cleanKey = stripWeightSyntax(tag).replace(/\s+/g, ' ').trim();
    if (!cleanKey) return;
    if (isDollPlasticTextureTag(tag)) {
      if (!filteredDollPlasticTags.includes(cleanKey)) {
        filteredDollPlasticTags.push(cleanKey);
      }
      return;
    }
    const hasWeight = /\([^)]*:\s*[\d.]+\)/.test(tag);
    if (seenAddedClean.has(cleanKey)) return;
    if (!hasWeight && existingCleanSet.has(cleanKey)) return;
    seenAddedClean.add(cleanKey);
    appendedTags.push(tag.trim());
  };

  const positiveCleanSet = new Set(
    splitPromptTags(combinedPositive)
      .map((t) => stripWeightSyntax(t).replace(/_/g, ' ').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
  );
  const hasExplicitBedPose = /\b(?:on bed|lying on bed|sitting on bed)\b/i.test(combinedPositive);

  if (hasExplicitPlush) {
    ANTI_DUPLICATE_ONLY_TAGS.forEach(pushUnique);
  } else {
    NO_PLUSH_GUARD_TAGS.forEach(pushUnique);
  }

  if (hasPajama) {
    PAJAMA_BED_GUARD_TAGS.forEach((tag) => {
      const cleanTag = stripWeightSyntax(tag).replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
      if (positiveCleanSet.has(cleanTag)) return;
      if (hasExplicitBedPose && (cleanTag === 'bed' || cleanTag === 'on bed' || cleanTag === 'lying on bed')) {
        return;
      }
      pushUnique(tag);
    });
    if (!hasExplicitPlush) {
      PAJAMA_PLUSH_GUARD_TAGS.forEach(pushUnique);
    }
    ANTI_DUPLICATE_ONLY_TAGS.forEach(pushUnique);
  }

  if (hasHandSleeveConflict || hasPoseExprGuard) {
    HAND_SAFETY_GUARD_TAGS.forEach(pushUnique);
  }

  if (hasExplicitStandingPose) {
    ANTI_SITTING_GUARD_TAGS.forEach((tag) => {
      const cleanTag = stripWeightSyntax(tag).replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
      if (positiveCleanSet.has(cleanTag)) return;
      pushUnique(tag);
    });
  }

  const yiChar = includeAppearance
    ? charList.find((c) => getCanonicalCharacterId(c) === 'char-yi')
    : undefined;
  const yiHairOptions = yiChar ? getCharacterHairstyleOptions(yiChar) : null;
  const yiEffectiveAppText = yiChar
    ? resolveEffectiveAppearanceSlot(yiChar).text
    : '';
  const shouldSuppressTopHeadBow = Boolean(
    yiChar &&
      yiHairOptions &&
      (yiHairOptions.activePreset.id === 'hair-side-ponytail' ||
        yiHairOptions.activeAccessory.id === 'acc-none' ||
        yiHairOptions.activeAccessory.id === 'acc-pearl-clips') &&
      !/\bblack hair bow\b/i.test(yiEffectiveAppText)
  );
  const isYiNoAccessory = Boolean(
    shouldSuppressTopHeadBow && yiHairOptions?.activeAccessory.id === 'acc-none'
  );

  if (shouldSuppressTopHeadBow) {
    ANTI_TOP_HEAD_BOW_GUARD_TAGS.forEach(pushUnique);
    if (!/\btwo hair bows\b/i.test(combinedPositive)) {
      pushUnique('(two hair bows:1.65)');
      pushUnique('(multiple hair bows:1.6)');
    }
    if (
      isYiNoAccessory &&
      !charList.some((c) => getCanonicalCharacterId(c) === 'char-lan')
    ) {
      ANTI_NO_HAIR_BOW_GUARD_TAGS.forEach(pushUnique);
    }
  }

  const rules: NegativeGuardRuleBadge[] = [];
  const triggeredRuleIds: NegativeGuardRuleId[] = [];

  if (hasExplicitPlush) {
    triggeredRuleIds.push('allow-plush-anti-dup');
    rules.push({
      id: 'allow-plush-anti-dup',
      label: '已选玩偶 · 仅防同化',
      detail: '已保留玩偶/毛绒玩具正向词，负向仅追加防地面宠偶/分身同化词',
      tone: 'plush',
    });
  } else {
    triggeredRuleIds.push('anti-plush');
    rules.push({
      id: 'anti-plush',
      label: '未选玩偶 · 防玩偶/同化',
      detail: '未选玩偶，自动向负向去重追加防凭空刷出玩偶/地面小动物/魔宠摆件及分身同化词',
      tone: 'neutral',
    });
  }

  if (hasPajama) {
    triggeredRuleIds.push('anti-pajama-bed');
    rules.push({
      id: 'anti-pajama-bed',
      label: '睡衣/居家 · 防站床/同化',
      detail: hasExplicitPlush
        ? '检测到睡衣/居家服，自动压制床铺/站床与分身同化（已保留玩偶）'
        : '检测到睡衣/居家服，自动去重追加防床铺/站床与玩偶同化词',
      tone: 'pajama',
    });
  }

  if (hasBackgroundLock) {
    triggeredRuleIds.push('anti-bg-override');
    rules.push({
      id: 'anti-bg-override',
      label: '场景锁定 · 防覆盖',
      detail: '已锁定全局背景槽位空间设定，避免其他维度场景/背景词覆盖',
      tone: 'guard',
    });
  }

  if (hasHandSleeveConflict || hasPoseExprGuard || resolvedAdjustments.length > 0) {
    triggeredRuleIds.push('anti-pose-expr-conflict');
    rules.push({
      id: 'anti-pose-expr-conflict',
      label: '四维调和 · 防手部/神态打架',
      detail:
        resolvedAdjustments.length > 0
          ? resolvedAdjustments.join('；')
          : '已自动调和服装、动作与表情间的冲突词条并完成去重',
      tone: 'guard',
    });
  }

  if (hasExplicitStandingPose) {
    triggeredRuleIds.push('anti-sitting');
    rules.push({
      id: 'anti-sitting',
      label: '站姿优先 · 防坐姿偏差',
      detail: '已提升站姿槽位在提示词拼接中的顺位与权重，并在负向抑制坐姿/靠椅坐姿偏差',
      tone: 'guard',
    });
  }

  if (shouldSuppressTopHeadBow) {
    triggeredRuleIds.push('anti-top-head-bow');
    rules.push({
      id: 'anti-top-head-bow',
      label: isYiNoAccessory ? '无发饰 · 禁蝴蝶结' : '仅绑侧马尾 · 禁头顶蝴蝶结',
      detail: isYiNoAccessory
        ? '已选择无发饰，自动在负向压制头顶及侧边蝴蝶结'
        : '默认仅保留绑在侧马尾上的黑色蝴蝶结，自动在负向压制头顶蝴蝶结与双蝴蝶结',
      tone: 'guard',
    });
  }

  if (filteredDollPlasticTags.length > 0) {
    triggeredRuleIds.push('anti-doll-plastic');
    rules.push({
      id: 'anti-doll-plastic',
      label: '过滤塑料/人偶质感词',
      detail: `已自动识别并移除类玩偶/塑料质感词（${filteredDollPlasticTags.join(', ')}），提升画面自然度`,
      tone: 'guard',
    });
  }

  const suffix = appendedTags.join(', ');
  const negativePrompt = baseNegativePrompt
    ? suffix
      ? `${baseNegativePrompt}, ${suffix}`
      : baseNegativePrompt
    : suffix;

  return {
    negativePrompt,
    baseNegativePrompt,
    guardMeta: {
      hasExplicitPlush,
      hasPajama,
      hasBackgroundLock,
      hasPoseExprGuard,
      hasHandSleeveConflict,
      filteredDollPlasticTags,
      resolvedAdjustments,
      appendedTags,
      triggeredRuleIds,
      rules,
    },
  };
}

export function analyzeNegativeAutoGuards(
  shared: SharedConfig,
  targetCharacters: CharacterConfig | CharacterConfig[],
  options: BuildEffectiveNegativeOptions = {}
): NegativeAutoGuardAnalysis {
  return buildNegativePromptWithMeta(shared, targetCharacters, options).guardMeta;
}

export function buildEffectiveNegativePrompt(
  shared: SharedConfig,
  targetCharacters: CharacterConfig | CharacterConfig[],
  options: BuildEffectiveNegativeOptions = {}
): string {
  return buildNegativePromptWithMeta(shared, targetCharacters, options).negativePrompt;
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
  const negative = buildNegativePromptWithMeta(shared, characters, options).negativePrompt;
  blocks.push(`[共用负向提示词]\nNegative: ${negative}`);
  return blocks.join('\n\n');
}

export function buildWorkflowSnippet(
  shared: SharedConfig,
  character: CharacterConfig,
  options: BuildPromptOptions = {}
): string {
  const built = buildCharacterPrompt(shared, character, options);
  const negative = buildNegativePromptWithMeta(shared, character, options).negativePrompt;
  return `=== 正向（粘到共用服装节点）===\n${built.fullText}\n\n=== 负向（粘到共用负向节点）===\n${negative}`;
}

function stripWeightSyntax(raw: string): string {
  return raw
    .trim()
    .replace(/^\((.+):[0-9.]+\)$/g, '$1')
    .replace(/[()[\]]/g, '')
    .replace(/(?<=[^\s:;]):[0-9]+(?:\.[0-9]+)?/g, '')
    .trim()
    .toLowerCase();
}

function normalizeTagForMatch(raw: string): string {
  return stripWeightSyntax(raw).replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

function unwrapMultiTagGroup(token: string): {
  inner: string;
  weightSuffix: string;
  wrapped: boolean;
} | null {
  const trimmed = token.trim();
  if (!trimmed.startsWith('(') || !trimmed.endsWith(')')) return null;
  const weightedMatch = trimmed.match(/^\(([\s\S]+):([0-9.]+)\)$/);
  if (weightedMatch && /[,，\n]/.test(weightedMatch[1])) {
    return {
      inner: weightedMatch[1].trim(),
      weightSuffix: `:${weightedMatch[2]}`,
      wrapped: true,
    };
  }
  const plainInner = trimmed.slice(1, -1).trim();
  if (/[,，\n]/.test(plainInner)) {
    return {
      inner: plainInner,
      weightSuffix: '',
      wrapped: true,
    };
  }
  return null;
}

function splitCleanTerms(raw: string): string[] {
  return splitPromptTags(raw)
    .flatMap((part) => {
      const unwrapped = unwrapMultiTagGroup(part);
      return unwrapped ? splitPromptTags(unwrapped.inner) : [part];
    })
    .map((part) => normalizeTagForMatch(part))
    .filter((t) => t.length >= 2);
}

export function stripTagFromSlotText(slotText: string, targetTag: string): string {
  const cleanTarget = normalizeTagForMatch(targetTag);
  if (!cleanTarget || !slotText.trim()) return slotText;
  const escaped = cleanTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wordRe = /[\u4e00-\u9fa5]/.test(cleanTarget)
    ? new RegExp(escaped, 'i')
    : new RegExp(`^${escaped}$|\\b${escaped}\\b`, 'i');

  const out: string[] = [];
  for (const token of splitPromptTags(slotText)) {
    const bare = normalizeTagForMatch(token);
    if (!bare) continue;
    if (bare === cleanTarget) continue;

    const unwrapped = unwrapMultiTagGroup(token);
    if (unwrapped) {
      const innerStripped = stripTagFromSlotText(unwrapped.inner, cleanTarget);
      if (innerStripped.trim()) {
        out.push(
          unwrapped.weightSuffix
            ? `(${innerStripped}${unwrapped.weightSuffix})`
            : `(${innerStripped})`
        );
      }
      continue;
    }

    if (wordRe.test(bare)) continue;
    out.push(token);
  }
  return out.join(', ');
}

export function removeNegativeTagFromShared(
  shared: SharedConfig,
  targetTag: string
): SharedConfig {
  const cleanTarget = normalizeTagForMatch(targetTag);
  if (!cleanTarget) return shared;
  const escaped = cleanTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exactOrPhraseRe = /[\u4e00-\u9fa5]/.test(cleanTarget)
    ? new RegExp(escaped, 'i')
    : new RegExp(`^${escaped}$|\\b${escaped}\\b`, 'i');

  const nextManualOverride =
    shared.manualNegativeOverride !== null
      ? stripTagFromSlotText(shared.manualNegativeOverride, cleanTarget)
      : null;

  const nextNegativeGroups = shared.negativeGroups.map((group) => ({
    ...group,
    tags: group.tags
      .map((tag) => {
        const bare = normalizeTagForMatch(tag.text);
        if (!bare || bare === cleanTarget) {
          return null;
        }
        if (/[,，\n]/.test(tag.text)) {
          const stripped = stripTagFromSlotText(tag.text, cleanTarget);
          return stripped.trim() ? { ...tag, text: stripped } : null;
        }
        if (exactOrPhraseRe.test(bare)) {
          return null;
        }
        return tag;
      })
      .filter((t): t is NonNullable<typeof t> => t !== null),
  }));

  return {
    ...shared,
    manualNegativeOverride: nextManualOverride,
    negativeGroups: nextNegativeGroups,
  };
}

interface TaggedSlotToken {
  raw: string;
  clean: string;
  slot: NonNullable<ConflictItem['slot']>;
  scope: 'shared' | 'character';
  characterId?: string;
  characterName?: string;
}

function collectTaggedSlotTokens(
  text: string,
  slot: NonNullable<ConflictItem['slot']>,
  scope: 'shared' | 'character',
  characterId?: string,
  characterName?: string
): TaggedSlotToken[] {
  const out: TaggedSlotToken[] = [];
  for (const part of splitPromptTags(text)) {
    const unwrapped = unwrapMultiTagGroup(part);
    if (unwrapped) {
      out.push(
        ...collectTaggedSlotTokens(
          unwrapped.inner,
          slot,
          scope,
          characterId,
          characterName
        )
      );
      continue;
    }
    const clean = normalizeTagForMatch(part);
    if (!clean) continue;
    out.push({
      raw: part.trim(),
      clean,
      slot,
      scope,
      characterId,
      characterName,
    });
  }
  return out;
}

export function detectConflicts(
  shared: SharedConfig,
  characters: CharacterConfig[],
  options: BuildPromptOptions = {}
): ConflictItem[] {
  const conflicts: ConflictItem[] = [];
  const negativeString = buildSharedNegativePrompt(shared);
  const parseNegativeTerms = (rawNeg: string) =>
    splitPromptTags(rawNeg)
      .flatMap((part) => {
        const unwrapped = unwrapMultiTagGroup(part);
        return unwrapped ? splitPromptTags(unwrapped.inner) : [part];
      })
      .map((part) => ({
        raw: part.trim(),
        clean: normalizeTagForMatch(part),
      }))
      .filter((item) => item.clean.length >= 2);
  const negativeRawTerms = parseNegativeTerms(negativeString);
  const sharedNegCleanSet = new Set(negativeRawTerms.map((item) => item.clean));

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
      const resolvedApp = resolveEffectiveAppearanceSlot(char).text;
      const charPosText = [
        resolvedApp,
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

  // 2. 正向与负向冲突检测（包含共用负向与单角色实际护栏负向）
  const seenCollisionKeys = new Set<string>();
  const sharedPositiveTokens: TaggedSlotToken[] = [
    ...collectTaggedSlotTokens(shared.styleAnchor.text, 'styleAnchor', 'shared'),
    ...collectTaggedSlotTokens(shared.background.text, 'background', 'shared'),
    ...collectTaggedSlotTokens(shared.composition.text, 'composition', 'shared'),
  ];

  const positiveCollisionEntries = [
    {
      source: '共享层',
      characterId: undefined as string | undefined,
      tokens: sharedPositiveTokens,
      negTerms: negativeRawTerms,
    },
    ...characters.map((c) => {
      const charNegStr = buildNegativePromptWithMeta(shared, c, {
        ...options,
        includeAppearance: options.includeAppearance ?? true,
      }).negativePrompt;
      const charNegTerms = parseNegativeTerms(charNegStr);
      return {
        source: c.name,
        characterId: c.id as string | undefined,
        tokens: [
          ...collectTaggedSlotTokens(
            resolveEffectiveAppearanceSlot(c).text,
            'appearance',
            'character',
            c.id,
            c.name
          ),
          ...collectTaggedSlotTokens(c.outfit.text, 'outfit', 'character', c.id, c.name),
          ...collectTaggedSlotTokens(c.pose.text, 'pose', 'character', c.id, c.name),
          ...collectTaggedSlotTokens(
            c.expression.text,
            'expression',
            'character',
            c.id,
            c.name
          ),
        ],
        negTerms: charNegTerms.length > 0 ? charNegTerms : negativeRawTerms,
      };
    }),
  ];

  for (const entry of positiveCollisionEntries) {
    for (const posTok of entry.tokens) {
      const posTerm = posTok.clean;
      if (posTerm.length < 2) continue;
      for (const negItem of entry.negTerms) {
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

          const isInSharedNeg = sharedNegCleanSet.has(negItem.clean);
          const fixType: ConflictItem['fixType'] = isInSharedNeg
            ? 'remove-negative-tag'
            : posTok.scope === 'shared'
            ? 'remove-shared-tag'
            : posTok.slot !== 'appearance'
            ? 'remove-character-tag'
            : undefined;
          const targetTag = isInSharedNeg ? negItem.clean : posTok.clean;

          conflicts.push({
            id: `conflict-neg-${dedupeKey}`,
            severity: isExact ? 'error' : 'warning',
            title: `正向与负向存在冲突词 "${negItem.clean}"`,
            detail: `「${entry.source}」正向包含 "${posTerm}"，但负向/护栏同时压制了 "${negItem.raw}"。`,
            characterId: entry.characterId,
            slot: isInSharedNeg ? undefined : posTok.slot,
            fixType,
            targetTag,
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

  // 4. 铁律 1：禁止补充会盖住 LoRA 人脸的通用五官美化词 + 塑胶/假人词残留
  const LORA_FACE_OVERRIDE_TERMS = [
    'detailed face',
    'beautiful face',
    'beautiful eyes',
    'intricate eyes',
    'anime face',
  ];

  const sharedSlotTokens: TaggedSlotToken[] = [
    ...collectTaggedSlotTokens(shared.styleAnchor.text, 'styleAnchor', 'shared'),
    ...collectTaggedSlotTokens(shared.background.text, 'background', 'shared'),
    ...collectTaggedSlotTokens(shared.composition.text, 'composition', 'shared'),
  ];

  for (const tok of sharedSlotTokens) {
    const matchedIron1 = LORA_FACE_OVERRIDE_TERMS.find((b) => tok.clean.includes(b));
    if (matchedIron1) {
      conflicts.push({
        id: `conflict-iron1-shared-${tok.slot}-${matchedIron1}`,
        severity: 'warning',
        title: `不建议在共享层添加 "${matchedIron1}"`,
        detail: `共享层包含 "${tok.raw}"，容易盖住 Anima LoRA 学到的角色五官。`,
        slot: tok.slot,
        fixType: 'remove-shared-tag',
        targetTag: tok.clean,
      });
    }
    if (isDollPlasticTextureTag(tok.raw)) {
      conflicts.push({
        id: `conflict-plastic-shared-${tok.slot}-${tok.clean}`,
        severity: 'warning',
        title: `共享层包含塑胶/手办质感词 "${tok.clean}"`,
        detail: `共享层包含 "${tok.raw}"，可能导致角色面部/材质出现塑胶或手办感。`,
        slot: tok.slot,
        fixType: 'remove-shared-tag',
        targetTag: tok.clean,
      });
    }
  }

  // 5. 逐角色检测：铁律 1、塑胶质感词、禁用词、构图/姿势/背景/服装/表情语义互斥冲突
  const seenSemanticIds = new Set<string>();
  const pushSemanticConflict = (item: ConflictItem) => {
    if (seenSemanticIds.has(item.id)) return;
    seenSemanticIds.add(item.id);
    conflicts.push(item);
  };

  for (const char of characters) {
    const charSlotTokens: TaggedSlotToken[] = [
      ...collectTaggedSlotTokens(
        resolveEffectiveAppearanceSlot(char).text,
        'appearance',
        'character',
        char.id,
        char.name
      ),
      ...collectTaggedSlotTokens(char.outfit.text, 'outfit', 'character', char.id, char.name),
      ...collectTaggedSlotTokens(char.pose.text, 'pose', 'character', char.id, char.name),
      ...collectTaggedSlotTokens(
        char.expression.text,
        'expression',
        'character',
        char.id,
        char.name
      ),
    ];

    for (const tok of charSlotTokens) {
      const matchedIron1 = LORA_FACE_OVERRIDE_TERMS.find((b) => tok.clean.includes(b));
      if (matchedIron1) {
        pushSemanticConflict({
          id: `conflict-iron1-${char.id}-${tok.slot}-${matchedIron1}`,
          severity: 'warning',
          title: `不建议添加 "${matchedIron1}"`,
          detail: `「${char.name}」包含 "${tok.raw}"，容易盖住 LoRA 学到的角色五官。`,
          characterId: char.id,
          slot: tok.slot,
          fixType: tok.slot === 'appearance' ? undefined : 'remove-character-tag',
          targetTag: tok.clean,
        });
      }
      if (isDollPlasticTextureTag(tok.raw)) {
        pushSemanticConflict({
          id: `conflict-plastic-${char.id}-${tok.slot}-${tok.clean}`,
          severity: 'warning',
          title: `检测到塑胶/手办质感残留词 "${tok.clean}"`,
          detail: `「${char.name}」包含 "${tok.raw}"，容易让画面偏向塑料/手办质感。`,
          characterId: char.id,
          slot: tok.slot,
          fixType: tok.slot === 'appearance' ? undefined : 'remove-character-tag',
          targetTag: tok.clean,
        });
      }
    }

    // 5a. 角色专属禁用词（防串特征）检测
    if (char.forbiddenTags && char.forbiddenTags.trim()) {
      const forbiddenList = splitCleanTerms(char.forbiddenTags);
      const appearanceForForbiddenCheck = canCustomizeCharacterHairstyle(char)
        ? applyHairstyleToAppearanceText(char.appearance.text, '', {
            bangsTags: '',
            accessoryId: 'acc-none',
          })
        : char.appearance.text;
      const forbiddenCheckTokens: TaggedSlotToken[] = [
        ...collectTaggedSlotTokens(
          appearanceForForbiddenCheck,
          'appearance',
          'character',
          char.id,
          char.name
        ),
        ...collectTaggedSlotTokens(char.outfit.text, 'outfit', 'character', char.id, char.name),
        ...collectTaggedSlotTokens(char.pose.text, 'pose', 'character', char.id, char.name),
        ...collectTaggedSlotTokens(
          char.expression.text,
          'expression',
          'character',
          char.id,
          char.name
        ),
      ];
      for (const fTag of forbiddenList) {
        const matched = forbiddenCheckTokens.find(
          (ct) =>
            ct.clean === fTag ||
            new RegExp(`\\b${fTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(ct.clean)
        );
        if (matched) {
          pushSemanticConflict({
            id: `conflict-char-forbidden-${char.id}-${fTag}`,
            severity: 'warning',
            title: `角色「${char.name}」命中禁用词 "${fTag}"`,
            detail: `「${char.name}」出现了禁用特征 "${matched.raw}"，可能串角，可移除该词或点击忽略。`,
            characterId: char.id,
            slot: matched.slot,
            fixType:
              matched.slot !== 'appearance' ? 'remove-character-tag' : 'remove-forbidden-tag',
            targetTag: matched.slot !== 'appearance' ? matched.clean : fTag,
          });
        }
      }
    }

    const combinedTokens = [...sharedSlotTokens, ...charSlotTokens];

    // 5b. 景别/构图冲突：共享层有 full body / head to toe，但角色槽位拉取了半身/大头裁切词
    const hasFullBody = combinedTokens.some((t) =>
      /\b(?:full body|entire body visible|head to toe)\b/i.test(t.clean)
    );
    const partialFramingTok = charSlotTokens.find(
      (t) =>
        t.slot !== 'appearance' &&
        /\b(?:upper body|cowboy shot|half body|bust shot|close-up|portrait|cropped legs|cropped torso|face focus)\b/i.test(
          t.clean
        )
    );
    if (hasFullBody && partialFramingTok) {
      pushSemanticConflict({
        id: `conflict-framing-${char.id}-${partialFramingTok.clean}`,
        severity: 'warning',
        title: `构图景别冲突：全身构图 vs "${partialFramingTok.clean}"`,
        detail: `「${char.name}」包含半身/特写裁切词 "${partialFramingTok.raw}"，与全局构图 "full body / head to toe" 冲突，可能导致截肢或构图混乱。`,
        characterId: char.id,
        slot: partialFramingTok.slot,
        fixType: 'remove-character-tag',
        targetTag: partialFramingTok.clean,
      });
    }

    // 5c. 动作姿态互斥：站姿 vs 坐/躺/跪/蹲
    const standingTok = combinedTokens.find(
      (t) =>
        t.slot !== 'appearance' &&
        /\b(?:standing|standing upright|standing firmly|tiptoe|tiptoes)\b/i.test(t.clean)
    );
    const nonStandingTok = combinedTokens.find(
      (t) =>
        t.slot !== 'appearance' &&
        /\b(?:sitting|seiza|kneeling|squatting|crouching|lying|lying on bed|on back|on stomach)\b/i.test(
          t.clean
        )
    );
    if (standingTok && nonStandingTok) {
      const fixTok = nonStandingTok.scope === 'character' ? nonStandingTok : standingTok;
      pushSemanticConflict({
        id: `conflict-posture-${char.id}-${standingTok.clean}-${nonStandingTok.clean}`,
        severity: 'warning',
        title: `动作姿态冲突："${standingTok.clean}" vs "${nonStandingTok.clean}"`,
        detail: `「${char.name}」同时存在站立词 "${standingTok.raw}" 与坐/躺/跪姿词 "${nonStandingTok.raw}"，容易导致腿部结构扭曲。`,
        characterId: char.id,
        slot: fixTok.slot,
        fixType: fixTok.scope === 'character' ? 'remove-character-tag' : 'remove-shared-tag',
        targetTag: fixTok.clean,
      });
    }

    // 5d. 背景室内外 / 空白背景互斥
    const nonAppearanceCombinedTokens = combinedTokens.filter(
      (t) => t.scope === 'shared' || t.slot !== 'appearance'
    );
    const indoorTok = nonAppearanceCombinedTokens.find((t) =>
      /\b(?:indoors?|classroom|bedroom|living room|kitchen|hallway|tatami|cafe interior)\b/i.test(
        t.clean
      )
    );
    const outdoorTok = nonAppearanceCombinedTokens.find(
      (t) =>
        !/\b(?:street view|outside window|window view|view of)\b/i.test(t.clean) &&
        /\b(?:outdoors?|park|street|beach|forest|meadow|rooftop|night sky)\b/i.test(t.clean)
    );
    if (indoorTok && outdoorTok) {
      const fixTok = outdoorTok.scope === 'character' ? outdoorTok : indoorTok;
      const scopeId =
        indoorTok.scope === 'shared' && outdoorTok.scope === 'shared' ? 'shared' : char.id;
      pushSemanticConflict({
        id: `conflict-bg-inout-${scopeId}-${indoorTok.clean}-${outdoorTok.clean}`,
        severity: 'warning',
        title: `背景室内外冲突："${indoorTok.clean}" vs "${outdoorTok.clean}"`,
        detail: `提示词中同时存在室内场景词 "${indoorTok.raw}" 与室外场景词 "${outdoorTok.raw}"，可能造成背景撕裂。`,
        characterId: fixTok.characterId,
        slot: fixTok.slot,
        fixType: fixTok.scope === 'character' ? 'remove-character-tag' : 'remove-shared-tag',
        targetTag: fixTok.clean,
      });
    }

    const simpleBgTok = nonAppearanceCombinedTokens.find((t) =>
      /\b(?:simple background|white background|plain background|transparent background)\b/i.test(
        t.clean
      )
    );
    const richBgTok = nonAppearanceCombinedTokens.find((t) =>
      /\b(?:detailed background|classroom|bedroom|living room|cafe|park|forest|street|beach)\b/i.test(
        t.clean
      )
    );
    if (simpleBgTok && richBgTok) {
      const fixTok = simpleBgTok.scope === 'character' ? simpleBgTok : richBgTok;
      const scopeId =
        simpleBgTok.scope === 'shared' && richBgTok.scope === 'shared' ? 'shared' : char.id;
      pushSemanticConflict({
        id: `conflict-bg-detail-${scopeId}-${simpleBgTok.clean}-${richBgTok.clean}`,
        severity: 'warning',
        title: `纯色背景与精细背景冲突："${simpleBgTok.clean}"`,
        detail: `提示词中同时出现纯色/简洁背景 "${simpleBgTok.raw}" 与细节场景 "${richBgTok.raw}"。`,
        characterId: fixTok.characterId,
        slot: fixTok.slot,
        fixType: fixTok.scope === 'character' ? 'remove-character-tag' : 'remove-shared-tag',
        targetTag: fixTok.clean,
      });
    }

    // 5e. 表情互斥（双闭眼 vs 直视镜头；闭嘴 vs 张嘴/吐舌）
    const bothEyesClosedTok = charSlotTokens.find(
      (t) =>
        t.slot !== 'appearance' &&
        /^(?:closed eyes|eyes closed)$/i.test(t.clean)
    );
    const gazeOpenEyesTok = charSlotTokens.find(
      (t) =>
        t.slot !== 'appearance' &&
        /\b(?:looking at viewer|eye contact|sparkling eyes|wide eyes|open eyes)\b/i.test(t.clean)
    );
    if (bothEyesClosedTok && gazeOpenEyesTok) {
      pushSemanticConflict({
        id: `conflict-expr-eyes-${char.id}`,
        severity: 'warning',
        title: `表情眼神冲突："${bothEyesClosedTok.clean}" vs "${gazeOpenEyesTok.clean}"`,
        detail: `「${char.name}」同时包含闭眼词 "${bothEyesClosedTok.raw}" 与睁眼/注视镜头词 "${gazeOpenEyesTok.raw}"。`,
        characterId: char.id,
        slot: bothEyesClosedTok.slot,
        fixType: 'remove-character-tag',
        targetTag: bothEyesClosedTok.clean,
      });
    }

    const closedMouthTok = charSlotTokens.find(
      (t) => t.slot !== 'appearance' && /^closed mouth$/i.test(t.clean)
    );
    const openMouthTok = charSlotTokens.find(
      (t) =>
        t.slot !== 'appearance' &&
        /\b(?:open mouth|parted lips|tongue out|blep)\b/i.test(t.clean)
    );
    if (closedMouthTok && openMouthTok) {
      pushSemanticConflict({
        id: `conflict-expr-mouth-${char.id}`,
        severity: 'warning',
        title: `口型表情冲突："${closedMouthTok.clean}" vs "${openMouthTok.clean}"`,
        detail: `「${char.name}」同时包含 "${closedMouthTok.raw}" 与 "${openMouthTok.raw}"。`,
        characterId: char.id,
        slot: closedMouthTok.slot,
        fixType: 'remove-character-tag',
        targetTag: closedMouthTok.clean,
      });
    }

    // 5f. 服装穿着/袖长互斥
    const clothedTok = charSlotTokens.find(
      (t) => t.slot === 'outfit' && /\bfully clothed\b/i.test(t.clean)
    );
    const unclothedTok = charSlotTokens.find(
      (t) =>
        (t.slot === 'outfit' || t.slot === 'pose') &&
        /\b(?:nude|topless|bottomless|swimsuit|bikini|lingerie|underwear)\b/i.test(t.clean)
    );
    if (clothedTok && unclothedTok) {
      pushSemanticConflict({
        id: `conflict-outfit-clothed-${char.id}`,
        severity: 'warning',
        title: `服装互斥冲突："${clothedTok.clean}" vs "${unclothedTok.clean}"`,
        detail: `「${char.name}」同时包含全包裹服饰词 "${clothedTok.raw}" 与露肤/泳装词 "${unclothedTok.raw}"。`,
        characterId: char.id,
        slot: clothedTok.slot,
        fixType: 'remove-character-tag',
        targetTag: clothedTok.clean,
      });
    }

    const longSleeveTok = charSlotTokens.find(
      (t) => t.slot === 'outfit' && /\b(?:long sleeves|extra-long sleeves)\b/i.test(t.clean)
    );
    const noSleeveTok = charSlotTokens.find(
      (t) =>
        t.slot === 'outfit' && /\b(?:sleeveless|bare arms|short sleeves)\b/i.test(t.clean)
    );
    if (longSleeveTok && noSleeveTok) {
      pushSemanticConflict({
        id: `conflict-outfit-sleeve-${char.id}`,
        severity: 'warning',
        title: `袖长描述冲突："${longSleeveTok.clean}" vs "${noSleeveTok.clean}"`,
        detail: `「${char.name}」服装槽位同时包含 "${longSleeveTok.raw}" 与 "${noSleeveTok.raw}"。`,
        characterId: char.id,
        slot: noSleeveTok.slot,
        fixType: 'remove-character-tag',
        targetTag: noSleeveTok.clean,
      });
    }

    // 5g. 单人/多人数量标签内部冲突
    const soloInPrompt = combinedTokens.find((t) => /^(?:solo|1girl)$/i.test(t.clean));
    const multiInPrompt = combinedTokens.find((t) =>
      /\b(?:2girls|3girls|multiple girls|crowd|1boy)\b/i.test(t.clean)
    );
    if (soloInPrompt && multiInPrompt) {
      const fixTok = multiInPrompt.scope === 'character' ? multiInPrompt : soloInPrompt;
      pushSemanticConflict({
        id: `conflict-count-${char.id}-${multiInPrompt.clean}`,
        severity: 'error',
        title: `人数标签自相矛盾："${soloInPrompt.clean}" vs "${multiInPrompt.clean}"`,
        detail: `「${char.name}」与共享层同时包含 "${soloInPrompt.raw}" 和 "${multiInPrompt.raw}"，会导致人数错乱。`,
        characterId: fixTok.characterId,
        slot: fixTok.slot,
        fixType: fixTok.scope === 'character' ? 'remove-character-tag' : 'remove-shared-tag',
        targetTag: fixTok.clean,
      });
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
  usedSeed: number;
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

  const activeLoras = getActiveLorasForCharacter(profile, params.enableFourthLora);

  activeLoras.forEach((lora, idx) => {
    const nodeId = String(20 + idx);
    workflow[nodeId] = {
      class_type: 'LoraLoader',
      inputs: {
        lora_name: lora.name.trim(),
        strength_model: clampLoraWeight(lora.model, 1.0),
        strength_clip: clampLoraWeight(lora.clip, 1.0),
        model: modelSource!,
        clip: clipSource!,
      },
    };
    modelSource = [nodeId, 0];
    clipSource = [nodeId, 1];
  });

  const sampling = profile.sampling;
  const seedMode = sampling.seedMode ?? 'fixed';
  const configuredSeed =
    typeof sampling.seed === 'number' &&
    Number.isFinite(sampling.seed) &&
    sampling.seed >= 0
      ? Math.floor(sampling.seed)
      : DEFAULT_COMFY_SEED;
  const seed =
    seedMode === 'random'
      ? Math.floor(Math.random() * 2147483647)
      : configuredSeed;

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
    usedSeed: seed,
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
  usedSeed: number;
}> {
  const baseUrl = params.comfyUrl.trim().replace(/\/+$/, '');
  if (!baseUrl) {
    throw new Error('请先填写 ComfyUI 服务地址（默认 http://127.0.0.1:8188）');
  }

  const triggerWords = collectActiveLoraTriggerWords(params.profile, params.enableFourthLora);
  const effectivePositivePrompt = appendLoraTriggerWordsToPrompt(
    params.positivePrompt,
    triggerWords
  );

  const { workflow, usedModelSummary, activeLorasCount, usedSeed } =
    buildComfyWorkflowFromProfile({
      profile: params.profile,
      characterName: params.characterName,
      positivePrompt: effectivePositivePrompt,
      negativePrompt: params.negativePrompt,
      enableFourthLora: params.enableFourthLora,
    });

  const clientId = `chibiprompt-${Math.random().toString(36).slice(2, 10)}`;

  // 把本次生成的完整参数嵌进 PNG（ComfyUI SaveImage 会把 extra_pnginfo 写成 PNG 文本块），
  // 这样重启项目/清缓存后，参数仍随图片存在，随时可查。
  const loraRecords = Object.values(workflow)
    .filter((n) => n.class_type === 'LoraLoader')
    .map((n) => {
      const inp = n.inputs as Record<string, unknown>;
      return { name: inp.lora_name, model: inp.strength_model, clip: inp.strength_clip };
    });
  const samplerInputs = (workflow['13']?.inputs ?? {}) as Record<string, unknown>;

  const response = await fetch(`${baseUrl}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      prompt: workflow,
      extra_data: {
        extra_pnginfo: {
          chibiprompt: {
            character: params.characterName,
            createdAt: new Date().toISOString(),
            model: usedModelSummary,
            loras: loraRecords,
            seed: samplerInputs.seed,
            steps: samplerInputs.steps,
            cfg: samplerInputs.cfg,
            sampler: samplerInputs.sampler_name,
            scheduler: samplerInputs.scheduler,
            width: (workflow['12']?.inputs as Record<string, unknown>)?.width,
            height: (workflow['12']?.inputs as Record<string, unknown>)?.height,
            positive: effectivePositivePrompt,
            negative: params.negativePrompt,
          },
        },
      },
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
    usedSeed,
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
      model: clampLoraWeight(l.model, 1.0),
      clip: clampLoraWeight(l.clip, 1.0),
      condition: l.condition ?? null,
      enabled: l.enabled !== false,
      ...(l.triggerWords?.trim() ? { triggerWords: l.triggerWords.trim() } : {}),
      ...(l.note?.trim() ? { note: l.note.trim() } : {}),
    })),
    sampling: {
      width: profile.sampling.width,
      height: profile.sampling.height,
      steps: profile.sampling.steps,
      cfg: profile.sampling.cfg,
      sampler: profile.sampling.sampler,
      scheduler: profile.sampling.scheduler,
      denoise: profile.sampling.denoise ?? 1.0,
      seedMode: profile.sampling.seedMode ?? 'fixed',
      seed: profile.sampling.seed ?? DEFAULT_COMFY_SEED,
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
    .slice(0, MAX_COMFY_LORAS)
    .map((item, idx) => ({
      id: `lora-${Date.now()}-${idx}`,
      name: typeof item.name === 'string' ? item.name : '',
      model: clampLoraWeight(typeof item.model === 'number' ? item.model : 1.0, 1.0),
      clip: clampLoraWeight(typeof item.clip === 'number' ? item.clip : 1.0, 1.0),
      condition: item.condition === 'ibuki_only' ? 'ibuki_only' : null,
      enabled: item.enabled !== false,
      triggerWords: typeof item.triggerWords === 'string' ? item.triggerWords : '',
      note: typeof item.note === 'string' ? item.note : '',
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
      seedMode: rawSampling.seedMode === 'random' ? 'random' : 'fixed',
      seed:
        typeof rawSampling.seed === 'number' &&
        Number.isFinite(rawSampling.seed) &&
        rawSampling.seed >= 0
          ? Math.floor(rawSampling.seed)
          : archPreset.defaultSampling.seed ?? DEFAULT_COMFY_SEED,
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
      seedMode: sampler.seedMode ?? 'fixed',
      seed: sampler.seed ?? DEFAULT_COMFY_SEED,
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
