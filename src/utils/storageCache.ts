import { PresetCategory, StudioConfig } from '../types/studio';

export const STUDIO_CONFIG_KEY = 'chibiprompt_studio_config_v3';
export const STUDIO_HISTORY_KEY = 'chibiprompt_studio_history_v3';
export const STUDIO_UI_CACHE_KEY = 'chibiprompt_studio_ui_cache_v1';

export type EditorSlotKey = 'appearance' | 'outfit' | 'pose' | 'expression';
export type PresetStyleFilter = 'all' | 'sweet' | 'cozy' | 'school' | 'dynamic';

export interface UiCacheState {
  selectedCharId: string;
  includeAppearance: boolean;
  presetsExpanded: boolean;
  presetTab: PresetCategory;
  presetFilter: PresetStyleFilter;
  selectedPresetByChar: Record<string, Partial<Record<PresetCategory, string>>>;
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
    const validTab: PresetCategory =
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
