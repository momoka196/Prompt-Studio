import {
  QuickFillCategory,
  StudioConfig,
  WorkflowCollectionCard,
} from '../types/studio';

export const STUDIO_CONFIG_KEY = 'chibiprompt_studio_config_v3';
export const STUDIO_HISTORY_KEY = 'chibiprompt_studio_history_v3';
export const STUDIO_UI_CACHE_KEY = 'chibiprompt_studio_ui_cache_v1';
export const STUDIO_WORKFLOW_CARDS_KEY = 'chibiprompt_studio_workflow_cards_v1';

export type EditorSlotKey = 'appearance' | 'outfit' | 'pose' | 'expression';
export type RolePresetTab = 'slots' | 'hairstyle';
export type PresetStyleFilter = 'all' | 'sweet' | 'cozy' | 'school' | 'dynamic';

export interface UiCacheState {
  selectedCharId: string;
  includeAppearance: boolean;
  rolePresetTab: RolePresetTab;
  presetsExpanded: boolean;
  presetTab: QuickFillCategory;
  presetFilter: PresetStyleFilter;
  selectedPresetByChar: Record<string, Partial<Record<QuickFillCategory, string>>>;
  editorOpenSlot: EditorSlotKey | null;
  showForbidden: boolean;
  sharedBarExpanded: boolean;
  sharedOpenSlot: string | null;
  selectedBackgroundId: string | null;
  selectedBackgroundName: string | null;
  showNegGroups: boolean;
  posExpanded: boolean;
  negExpanded: boolean;
}

export const DEFAULT_UI_CACHE: UiCacheState = {
  selectedCharId: 'char-lan',
  includeAppearance: false,
  rolePresetTab: 'slots',
  presetsExpanded: true,
  presetTab: 'outfit',
  presetFilter: 'all',
  selectedPresetByChar: {},
  editorOpenSlot: null,
  showForbidden: false,
  sharedBarExpanded: false,
  sharedOpenSlot: null,
  selectedBackgroundId: null,
  selectedBackgroundName: null,
  showNegGroups: false,
  posExpanded: false,
  negExpanded: false,
};

export function loadUiCache(): UiCacheState {
  try {
    const raw = localStorage.getItem(STUDIO_UI_CACHE_KEY);
    if (!raw) return { ...DEFAULT_UI_CACHE };
    const parsed = JSON.parse(raw) as Partial<UiCacheState>;
    const validRolePresetTab: RolePresetTab =
      parsed.rolePresetTab === 'slots' || parsed.rolePresetTab === 'hairstyle'
        ? parsed.rolePresetTab
        : DEFAULT_UI_CACHE.rolePresetTab;
    const validTab: QuickFillCategory =
      parsed.presetTab === 'outfit' ||
      parsed.presetTab === 'pose' ||
      parsed.presetTab === 'expression'
        ? parsed.presetTab
        : DEFAULT_UI_CACHE.presetTab;
    const validFilter: PresetStyleFilter =
      parsed.presetFilter === 'all' ||
      parsed.presetFilter === 'sweet' ||
      parsed.presetFilter === 'cozy' ||
      parsed.presetFilter === 'school' ||
      parsed.presetFilter === 'dynamic'
        ? parsed.presetFilter
        : DEFAULT_UI_CACHE.presetFilter;
    const validEditorSlot: EditorSlotKey | null =
      parsed.editorOpenSlot === 'appearance' ||
      parsed.editorOpenSlot === 'outfit' ||
      parsed.editorOpenSlot === 'pose' ||
      parsed.editorOpenSlot === 'expression'
        ? parsed.editorOpenSlot
        : null;
    const validSelectedPresetByChar =
      parsed.selectedPresetByChar &&
      typeof parsed.selectedPresetByChar === 'object' &&
      !Array.isArray(parsed.selectedPresetByChar)
        ? parsed.selectedPresetByChar
        : {};

    return {
      selectedCharId:
        typeof parsed.selectedCharId === 'string' && parsed.selectedCharId
          ? parsed.selectedCharId
          : DEFAULT_UI_CACHE.selectedCharId,
      includeAppearance:
        typeof parsed.includeAppearance === 'boolean'
          ? parsed.includeAppearance
          : DEFAULT_UI_CACHE.includeAppearance,
      rolePresetTab: validRolePresetTab,
      presetsExpanded:
        typeof parsed.presetsExpanded === 'boolean'
          ? parsed.presetsExpanded
          : DEFAULT_UI_CACHE.presetsExpanded,
      presetTab: validTab,
      presetFilter: validFilter,
      selectedPresetByChar: validSelectedPresetByChar,
      editorOpenSlot: validEditorSlot,
      showForbidden:
        typeof parsed.showForbidden === 'boolean'
          ? parsed.showForbidden
          : DEFAULT_UI_CACHE.showForbidden,
      sharedBarExpanded:
        typeof parsed.sharedBarExpanded === 'boolean'
          ? parsed.sharedBarExpanded
          : DEFAULT_UI_CACHE.sharedBarExpanded,
      sharedOpenSlot:
        typeof parsed.sharedOpenSlot === 'string' ? parsed.sharedOpenSlot : null,
      selectedBackgroundId:
        typeof parsed.selectedBackgroundId === 'string'
          ? parsed.selectedBackgroundId
          : null,
      selectedBackgroundName:
        typeof parsed.selectedBackgroundName === 'string'
          ? parsed.selectedBackgroundName
          : null,
      showNegGroups:
        typeof parsed.showNegGroups === 'boolean'
          ? parsed.showNegGroups
          : DEFAULT_UI_CACHE.showNegGroups,
      posExpanded:
        typeof parsed.posExpanded === 'boolean'
          ? parsed.posExpanded
          : DEFAULT_UI_CACHE.posExpanded,
      negExpanded:
        typeof parsed.negExpanded === 'boolean'
          ? parsed.negExpanded
          : DEFAULT_UI_CACHE.negExpanded,
    };
  } catch {
    return { ...DEFAULT_UI_CACHE };
  }
}

export function patchUiCache(patch: Partial<UiCacheState>): void {
  try {
    const current = loadUiCache();
    const next = { ...current, ...patch };
    localStorage.setItem(STUDIO_UI_CACHE_KEY, JSON.stringify(next));
  } catch {
    // 忽略存储异常
  }
}

export function saveConfigSafely(config: StudioConfig): void {
  const payload = JSON.stringify(config);
  try {
    localStorage.setItem(STUDIO_CONFIG_KEY, payload);
  } catch {
    // 若本地存储空间不足（通常由历史快照过多引起），先裁减历史再重试写入主配置
    try {
      const rawHist = localStorage.getItem(STUDIO_HISTORY_KEY);
      if (rawHist) {
        const parsed = JSON.parse(rawHist);
        if (Array.isArray(parsed) && parsed.length > 3) {
          localStorage.setItem(STUDIO_HISTORY_KEY, JSON.stringify(parsed.slice(0, 3)));
          localStorage.setItem(STUDIO_CONFIG_KEY, payload);
          return;
        }
      }
      localStorage.removeItem(STUDIO_HISTORY_KEY);
      localStorage.setItem(STUDIO_CONFIG_KEY, payload);
    } catch {
      // 忽略无法恢复的存储异常
    }
  }
}

export function normalizeWorkflowCards(raw: unknown): WorkflowCollectionCard[] {
  if (!Array.isArray(raw)) return [];
  const cards: WorkflowCollectionCard[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Partial<WorkflowCollectionCard>;
    if (!rec.id || typeof rec.id !== 'string') continue;
    const now = Date.now();
    cards.push({
      id: rec.id,
      title:
        typeof rec.title === 'string' && rec.title.trim()
          ? rec.title.trim()
          : '未命名工作流卡片',
      tags: Array.isArray(rec.tags)
        ? rec.tags
            .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
            .map((t) => t.trim())
        : [],
      thumbnailDataUrl:
        typeof rec.thumbnailDataUrl === 'string' ? rec.thumbnailDataUrl : '',
      imageName: typeof rec.imageName === 'string' ? rec.imageName : '',
      workflowFileName:
        typeof rec.workflowFileName === 'string' ? rec.workflowFileName : 'workflow.json',
      workflowFormat:
        rec.workflowFormat === 'api' ||
        rec.workflowFormat === 'ui' ||
        rec.workflowFormat === 'png-embedded'
          ? rec.workflowFormat
          : 'unknown',
      rawWorkflowJson:
        typeof rec.rawWorkflowJson === 'string' ? rec.rawWorkflowJson : '{}',
      apiPromptJson:
        typeof rec.apiPromptJson === 'string' ? rec.apiPromptJson : undefined,
      extractedPositive:
        typeof rec.extractedPositive === 'string' ? rec.extractedPositive : '',
      extractedNegative:
        typeof rec.extractedNegative === 'string' ? rec.extractedNegative : '',
      fineTunedPositive:
        typeof rec.fineTunedPositive === 'string'
          ? rec.fineTunedPositive
          : typeof rec.extractedPositive === 'string'
          ? rec.extractedPositive
          : '',
      fineTunedNegative:
        typeof rec.fineTunedNegative === 'string'
          ? rec.fineTunedNegative
          : typeof rec.extractedNegative === 'string'
          ? rec.extractedNegative
          : '',
      positiveNodeId:
        typeof rec.positiveNodeId === 'string' ? rec.positiveNodeId : null,
      negativeNodeId:
        typeof rec.negativeNodeId === 'string' ? rec.negativeNodeId : null,
      nodeCandidates: Array.isArray(rec.nodeCandidates)
        ? rec.nodeCandidates.filter(
            (n): n is NonNullable<WorkflowCollectionCard['nodeCandidates']>[number] =>
              Boolean(n && typeof n === 'object' && typeof n.nodeId === 'string')
          )
        : [],
      applyFineTuneOnSend:
        typeof rec.applyFineTuneOnSend === 'boolean' ? rec.applyFineTuneOnSend : true,
      isPrivate: Boolean(rec.isPrivate),
      seedMode:
        rec.seedMode === 'fixed' || rec.seedMode === 'random' || rec.seedMode === 'workflow'
          ? rec.seedMode
          : 'workflow',
      fixedSeed:
        typeof rec.fixedSeed === 'number' && Number.isFinite(rec.fixedSeed) && rec.fixedSeed >= 0
          ? Math.floor(rec.fixedSeed)
          : undefined,
      lastRunAt: typeof rec.lastRunAt === 'number' ? rec.lastRunAt : undefined,
      lastPromptId:
        typeof rec.lastPromptId === 'string' ? rec.lastPromptId : undefined,
      createdAt: typeof rec.createdAt === 'number' ? rec.createdAt : now,
      updatedAt: typeof rec.updatedAt === 'number' ? rec.updatedAt : now,
    });
  }
  return cards;
}

export function loadWorkflowCards(): WorkflowCollectionCard[] {
  try {
    const raw = localStorage.getItem(STUDIO_WORKFLOW_CARDS_KEY);
    if (!raw) return [];
    return normalizeWorkflowCards(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function saveWorkflowCardsSafely(cards: WorkflowCollectionCard[]): {
  ok: boolean;
  error?: string;
} {
  try {
    const payload = JSON.stringify(cards);
    localStorage.setItem(STUDIO_WORKFLOW_CARDS_KEY, payload);
    return { ok: true };
  } catch {
    return {
      ok: false,
      error:
        '本地存储空间已满（QuotaExceeded），本次收藏卡片未能写入缓存。请先导出备份并清理部分旧卡片。',
    };
  }
}

