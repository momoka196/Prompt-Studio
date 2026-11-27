export type QuickFillCategory = 'outfit' | 'pose' | 'expression';
export type PresetCategory = QuickFillCategory | 'hairstyle';

export interface SimplePresetItem {
  id: string;
  category: PresetCategory;
  zhName: string;
  vibe: string;
  tags: string;
  defaultWeight: number;
  isCustom?: boolean;
}

export interface MinimalBackgroundPreset {
  id: string;
  zhName: string;
  note: string;
  tags: string;
  isCustom?: boolean;
}

export interface WeightedSlot {
  text: string;
  weight: number;
}

export interface CharacterConfig {
  id: string;
  name: string;
  hairstyleId?: string | null;
  hairBangsId?: string | null;
  hairAccessoryId?: string | null;
  appearance: WeightedSlot;
  outfit: WeightedSlot;
  pose: WeightedSlot;
  expression: WeightedSlot;
  enableFourthLora?: boolean;
  forbiddenTags?: string;
}

export interface NegativeTagItem {
  id: string;
  text: string;
  weight: number;
}

export type NegativeGroupId =
  | 'anti-split'
  | 'anti-outfit-bleed'
  | 'anti-blank-bg'
  | 'anti-color-cast'
  | 'anti-stiff'
  | 'general-quality';

export interface NegativeGroup {
  id: NegativeGroupId;
  name: string;
  description: string;
  enabled: boolean;
  tags: NegativeTagItem[];
}

export interface SharedConfig {
  styleAnchor: WeightedSlot;
  background: WeightedSlot;
  selectedBackgroundId?: string | null;
  selectedBackgroundName?: string | null;
  composition: WeightedSlot;
  bodyType?: WeightedSlot;
  negativeGroups: NegativeGroup[];
  manualNegativeOverride: string | null;
}

export type ComfySeedMode = 'fixed' | 'random';

export interface ComfySamplerConfig {
  width: number;
  height: number;
  steps: number;
  cfg: number;
  samplerName: string;
  scheduler: string;
  denoise: number;
  enableLoraChain: boolean;
  seedMode?: ComfySeedMode;
  seed?: number;
}

export type ComfyArchitecture = 'anima' | 'sdxl' | 'illustrious' | 'sd15' | 'custom';

export type ComfyLoaderKey = 'checkpoint' | 'unet' | 'clip' | 'vae';

export interface ComfyLoadersConfig {
  checkpoint?: string;
  unet?: string;
  clip?: string;
  vae?: string;
  clipType?: string;
  enableCheckpoint?: boolean;
  enableUnet?: boolean;
  enableClip?: boolean;
  enableVae?: boolean;
}

export interface ComfyLoraItem {
  id?: string;
  name: string;
  model: number;
  clip: number;
  condition: 'ibuki_only' | null;
}

export interface ComfySamplingParams {
  width: number;
  height: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  denoise?: number;
  seedMode?: ComfySeedMode;
  seed?: number;
}

export interface ComfyProfile {
  id: string;
  name: string;
  architecture: ComfyArchitecture;
  loaders: ComfyLoadersConfig;
  loras: ComfyLoraItem[];
  sampling: ComfySamplingParams;
  manualSamplingFields?: (keyof ComfySamplingParams)[];
}

export interface LoaderValidationEntry {
  status: 'unchecked' | 'checking' | 'valid' | 'invalid' | 'error';
  available: string[];
  message?: string;
}

export type ComfyValidationMap = Record<ComfyLoaderKey, LoaderValidationEntry> & {
  loraAvailable: string[];
};

export interface StudioConfig {
  appearanceCleanedVersion?: number;
  bodyTypeInitializedVersion?: number;
  shared: SharedConfig;
  characters: CharacterConfig[];
  comfyUrl: string;
  comfyUnetName: string;
  comfyClipName: string;
  comfyVaeName: string;
  comfySampler?: ComfySamplerConfig;
  comfyProfiles?: ComfyProfile[];
  activeComfyProfileId?: string;
  customBackgrounds?: MinimalBackgroundPreset[];
  customPresets?: SimplePresetItem[];
}

export interface PromptSegment {
  key: string;
  label: string;
  layer: 'shared' | 'character';
  rawText: string;
  weight: number;
  formatted: string;
}

export interface BuiltCharacterPrompt {
  fullText: string;
  segments: PromptSegment[];
  resolvedAdjustments?: string[];
}

export type NegativeGuardRuleId =
  | 'anti-plush'
  | 'allow-plush-anti-dup'
  | 'anti-pajama-bed'
  | 'anti-bg-override'
  | 'anti-pose-expr-conflict'
  | 'anti-doll-plastic'
  | 'anti-sitting';

export interface NegativeGuardRuleBadge {
  id: NegativeGuardRuleId;
  label: string;
  detail: string;
  tone: 'neutral' | 'plush' | 'pajama' | 'guard';
}

export interface NegativeGuardMetadata {
  hasExplicitPlush: boolean;
  hasPajama: boolean;
  hasBackgroundLock: boolean;
  hasPoseExprGuard: boolean;
  hasHandSleeveConflict: boolean;
  filteredDollPlasticTags?: string[];
  resolvedAdjustments: string[];
  appendedTags: string[];
  triggeredRuleIds: NegativeGuardRuleId[];
  rules: NegativeGuardRuleBadge[];
}

export interface BuiltNegativePromptResult {
  negativePrompt: string;
  baseNegativePrompt: string;
  guardMeta: NegativeGuardMetadata;
}

export interface ConflictItem {
  id: string;
  severity: 'error' | 'warning';
  title: string;
  detail: string;
  characterId?: string;
  fixType?: 'remove-solo' | 'remove-negative-tag' | 'remove-forbidden-tag';
  targetTag?: string;
}

export interface HistorySnapshot {
  id: string;
  createdAt: number;
  label: string;
  config: StudioConfig;
}

export type WorkflowJsonFormat = 'api' | 'ui' | 'png-embedded' | 'unknown';

export interface WorkflowPromptNodeCandidate {
  nodeId: string;
  nodeType: string;
  title: string;
  text: string;
  roleHint: 'positive' | 'negative' | 'unknown';
  source: 'api' | 'ui' | 'evaluated';
  linkedFromNodeId?: string;
}

export interface WorkflowPromptTagItem {
  id: string;
  text: string;
  weight: number;
  enabled: boolean;
}

export interface WorkflowCollectionCard {
  id: string;
  title: string;
  tags: string[];
  thumbnailDataUrl: string;
  originalImageDataUrl?: string;
  originalImageMime?: string;
  originalImageWidth?: number;
  originalImageHeight?: number;
  hasOriginalImageBlob?: boolean;
  imageByteSize?: number;
  autoImportedSource?: 'png' | 'json' | 'manual';
  imageName: string;
  workflowFileName: string;
  workflowFormat: WorkflowJsonFormat;
  rawWorkflowJson: string;
  apiPromptJson?: string;
  extractedPositive: string;
  extractedNegative: string;
  fineTunedPositive: string;
  fineTunedNegative: string;
  positiveNodeId: string | null;
  negativeNodeId: string | null;
  nodeCandidates: WorkflowPromptNodeCandidate[];
  applyFineTuneOnSend: boolean;
  isPrivate?: boolean;
  seedMode?: 'workflow' | 'fixed' | 'random';
  fixedSeed?: number;
  lastRunAt?: number;
  lastPromptId?: string;
  lastFolderSyncAt?: number;
  createdAt: number;
  updatedAt: number;
}

