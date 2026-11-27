import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronRight, Download, Plus, ShieldAlert, Upload, X } from 'lucide-react';
import {
  EXPRESSION_PRESETS,
  OUTFIT_PRESETS,
  POSE_PRESETS,
  PresetCategory,
  SimplePresetItem,
} from '../data/presets';
import { CharacterConfig, WeightedSlot } from '../types/studio';
import { clampWeight, getPromptStats } from '../utils/promptBuilder';
import { parseCutePresetsImport } from '../utils/presetImporter';
import {
  EditorSlotKey,
  loadUiCache,
  patchUiCache,
  PresetStyleFilter,
} from '../utils/storageCache';
import { CompactSlotRow } from './CompactSlotRow';
import { getCharacterAvatarColor } from './CharacterSidebar';

interface CharacterEditorPanelProps {
  character: CharacterConfig;
  onUpdateCharacter: (updated: CharacterConfig) => void;
  customPresets: SimplePresetItem[];
  onUpdateCustomPresets: (items: SimplePresetItem[]) => void;
}

type SlotKey = 'appearance' | 'outfit' | 'pose' | 'expression';

const SLOT_DEFS: {
  key: SlotKey;
  label: string;
  placeholder: string;
  emptyHint?: string;
}[] = [
  {
    key: 'appearance',
    label: '外貌',
    placeholder: '留空即交给 LoRA 控制；如需手写，填发色/发型/瞳色/专属配饰...',
    emptyHint: '留空（交给 LoRA 控制）',
  },
  {
    key: 'outfit',
    label: '服装',
    placeholder: '例如：pink and white lolita dress, frilled apron, thighhighs',
  },
  {
    key: 'pose',
    label: '动作',
    placeholder: '例如：holding strawberry parfait with both hands, leaning forward',
  },
  {
    key: 'expression',
    label: '表情',
    placeholder: '例如：happy, open mouth, cute little fang, rosy blush',
  },
];

const STYLE_FILTERS: { id: PresetStyleFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'sweet', label: '甜美互动' },
  { id: 'cozy', label: '坐姿 / 居家' },
  { id: 'school', label: '校园 / 日常' },
  { id: 'dynamic', label: '动态 / 道具' },
];

function matchesStyleFilter(
  item: SimplePresetItem,
  filter: PresetStyleFilter
): boolean {
  if (filter === 'all') return true;
  const hay = `${item.zhName} ${item.vibe} ${item.tags}`.toLowerCase();

  if (filter === 'sweet') {
    return /甜|梦|洛丽塔|女仆|偶像|茶会|荷叶|比心|捧脸|捧|害羞|羞|星|爱|微|浅笑|笑|花|眨眼|wink|cat|lolita|maid|idol|heart|blush|smile|flustered|dreamy|curtsy|cheek|flower/.test(
      hay
    );
  }
  if (filter === 'cozy') {
    return /居|坐|跪|睡|慵|卫衣|滑肩|抱|哈欠|安详|放空|鼓腮|别扭|sit|floor|kneel|seiza|pajama|hoodie|hug|plushie|sleepy|pout|sulking|yawn|nap/.test(
      hay
    );
  }
  if (filter === 'school') {
    return /校|jk|水手|开衫|毛衣|背带|衬衫|课桌|书|阅读|敬礼|体操|学院|文艺|贝雷帽|风衣|大衣|标准|托下巴|站|school|cardigan|sailor|desk|book|reading|uniform|standing|salute|trench|duffle/.test(
      hay
    );
  }
  if (filter === 'dynamic') {
    return /跳|跃|转|举|伸|伞|气球|泳|运动|雨|奶茶|托盘|蛋糕|芭菲|比枪|踮脚|惊喜|吃|魔女|护士|巫女|指向|欢呼|跑|道具|互动|jump|hop|skip|spin|twirl|umbrella|balloon|swimsuit|tiptoe|parfait|cake|dynamic|sipping|reaching|witch|nurse|miko|point|cheer|run|wink/.test(
      hay
    );
  }
  return true;
}

function getCoreEnglishKeywords(tagsText: string, max = 2): string[] {
  return tagsText
    .split(',')
    .map((s) => s.replace(/^\(|\)$/g, '').replace(/:[0-9.]+$/g, '').trim())
    .filter(Boolean)
    .slice(0, max);
}

function normalizeTagToken(raw: string): string {
  return raw
    .trim()
    .replace(/^[\[(]+/, '')
    .replace(/[\])]+$/, '')
    .replace(/:[0-9.]+$/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

function extractCleanTags(text: string): string[] {
  return text
    .split(',')
    .map(normalizeTagToken)
    .filter(Boolean);
}

function isPresetMatchedInSlot(slotText: string, preset: SimplePresetItem): boolean {
  const trimmedSlot = slotText.trim();
  const trimmedPreset = preset.tags.trim();
  if (!trimmedSlot || !trimmedPreset) return false;
  if (trimmedSlot === trimmedPreset) return true;

  const slotTags = extractCleanTags(trimmedSlot);
  const presetTags = extractCleanTags(trimmedPreset);
  if (slotTags.length === 0 || presetTags.length === 0) return false;

  if (slotTags.join(', ') === presetTags.join(', ')) return true;

  const hasTag = (target: string) =>
    slotTags.some(
      (st) => st === target || (target.length >= 5 && st.includes(target))
    );

  if (presetTags.length <= 2) {
    return presetTags.every(hasTag);
  }

  const coreMatched = hasTag(presetTags[0]) && hasTag(presetTags[1]);
  if (!coreMatched) return false;

  const matchedCount = presetTags.filter(hasTag).length;
  return matchedCount >= Math.ceil(presetTags.length * 0.65);
}

function resolveActivePreset(
  category: PresetCategory,
  slotText: string,
  customPresets: SimplePresetItem[],
  cachedPresetId?: string
): SimplePresetItem | null {
  const trimmed = slotText.trim();
  if (!trimmed) return null;

  const builtin =
    category === 'outfit'
      ? OUTFIT_PRESETS
      : category === 'pose'
      ? POSE_PRESETS
      : EXPRESSION_PRESETS;
  const pool = [...customPresets.filter((p) => p.category === category), ...builtin];

  if (cachedPresetId) {
    const cachedItem = pool.find((p) => p.id === cachedPresetId);
    if (cachedItem && cachedItem.tags.trim() === trimmed) {
      return cachedItem;
    }
  }

  const exact = pool.find((p) => p.tags.trim() === trimmed);
  if (exact) return exact;

  const cleanJoined = extractCleanTags(trimmed).join(', ');
  const normalizedExact = pool.find(
    (p) => extractCleanTags(p.tags).join(', ') === cleanJoined
  );
  if (normalizedExact) return normalizedExact;

  if (cachedPresetId) {
    const cachedItem = pool.find((p) => p.id === cachedPresetId);
    if (cachedItem && isPresetMatchedInSlot(trimmed, cachedItem)) {
      return cachedItem;
    }
  }

  return pool.find((p) => isPresetMatchedInSlot(trimmed, p)) ?? null;
}

export const CharacterEditorPanel: React.FC<CharacterEditorPanelProps> = ({
  character,
  onUpdateCharacter,
  customPresets,
  onUpdateCustomPresets,
}) => {
  const [openSlot, setOpenSlotState] = useState<EditorSlotKey | null>(
    () => loadUiCache().editorOpenSlot
  );
  const [showForbidden, setShowForbiddenState] = useState<boolean>(
    () => loadUiCache().showForbidden
  );
  const [presetsExpanded, setPresetsExpandedState] = useState<boolean>(
    () => loadUiCache().presetsExpanded
  );
  const [presetTab, setPresetTabState] = useState<PresetCategory>(
    () => loadUiCache().presetTab
  );
  const [styleFilter, setStyleFilterState] = useState<PresetStyleFilter>(
    () => loadUiCache().presetFilter
  );
  const [selectedPresetByChar, setSelectedPresetByChar] = useState<
    Record<string, Partial<Record<PresetCategory, string>>>
  >(() => loadUiCache().selectedPresetByChar);

  const presetGridRef = useRef<HTMLDivElement | null>(null);
  const prevCharIdRef = useRef<string>(character.id);
  useEffect(() => {
    if (prevCharIdRef.current !== character.id) {
      prevCharIdRef.current = character.id;
      setPresetsExpandedState(true);
      patchUiCache({ presetsExpanded: true });
    }
  }, [character.id]);

  useEffect(() => {
    if (presetGridRef.current) {
      presetGridRef.current.scrollTop = 0;
    }
  }, [character.id, presetTab, styleFilter]);

  const setOpenSlot = (
    updater: EditorSlotKey | null | ((prev: EditorSlotKey | null) => EditorSlotKey | null)
  ) => {
    setOpenSlotState((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      patchUiCache({ editorOpenSlot: next });
      return next;
    });
  };

  const setShowForbidden = (updater: boolean | ((prev: boolean) => boolean)) => {
    setShowForbiddenState((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      patchUiCache({ showForbidden: next });
      return next;
    });
  };

  const setPresetsExpanded = (updater: boolean | ((prev: boolean) => boolean)) => {
    setPresetsExpandedState((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      patchUiCache({ presetsExpanded: next });
      return next;
    });
  };

  const setPresetTab = (tab: PresetCategory) => {
    setPresetTabState(tab);
    patchUiCache({ presetTab: tab });
  };

  const setStyleFilter = (filter: PresetStyleFilter) => {
    setStyleFilterState(filter);
    patchUiCache({ presetFilter: filter });
  };

  const recordPresetSelection = (
    charId: string,
    category: PresetCategory,
    presetId: string | null
  ) => {
    setSelectedPresetByChar((prev) => {
      const charMap = { ...(prev[charId] ?? {}) };
      if (presetId) {
        charMap[category] = presetId;
      } else {
        delete charMap[category];
      }
      const next = { ...prev, [charId]: charMap };
      patchUiCache({ selectedPresetByChar: next });
      return next;
    });
  };

  const [showPresetSave, setShowPresetSave] = useState(false);
  const [presetSaveName, setPresetSaveName] = useState('');
  const [showPresetImport, setShowPresetImport] = useState(false);
  const [presetImportText, setPresetImportText] = useState('');
  const [presetImportError, setPresetImportError] = useState<string | null>(null);
  const [presetImportNotice, setPresetImportNotice] = useState<string | null>(null);
  const presetFileRef = useRef<HTMLInputElement | null>(null);

  const avatar = getCharacterAvatarColor(character);

  const updateSlot = (key: SlotKey, patch: Partial<WeightedSlot>) => {
    if (
      patch.text !== undefined &&
      (key === 'outfit' || key === 'pose' || key === 'expression')
    ) {
      const matched = resolveActivePreset(key, patch.text, customPresets);
      recordPresetSelection(character.id, key, matched?.id ?? null);
    }

    onUpdateCharacter({
      ...character,
      [key]: {
        ...character[key],
        ...patch,
      },
    });
  };

  const handleApplyPreset = (preset: SimplePresetItem) => {
    const currentWeight = character[preset.category].weight;
    const nextWeight =
      preset.defaultWeight === 1.0
        ? 1.0
        : Math.abs(currentWeight - 1.0) < 0.001
        ? preset.defaultWeight
        : currentWeight;

    recordPresetSelection(character.id, preset.category, preset.id);
    onUpdateCharacter({
      ...character,
      [preset.category]: {
        text: preset.tags,
        weight: nextWeight,
      },
    });
  };

  const handleClearCategorySlot = (category: PresetCategory) => {
    recordPresetSelection(character.id, category, null);
    onUpdateCharacter({
      ...character,
      [category]: {
        ...character[category],
        text: '',
      },
    });
  };

  const builtinPresets =
    presetTab === 'outfit'
      ? OUTFIT_PRESETS
      : presetTab === 'pose'
      ? POSE_PRESETS
      : EXPRESSION_PRESETS;

  const customTabPresets = customPresets.filter((p) => p.category === presetTab);
  const allTabPresets = useMemo(
    () => [...customTabPresets, ...builtinPresets],
    [customTabPresets, builtinPresets]
  );
  const filteredPresets = useMemo(
    () => allTabPresets.filter((item) => matchesStyleFilter(item, styleFilter)),
    [allTabPresets, styleFilter]
  );

  const tabLabel =
    presetTab === 'outfit' ? '服装' : presetTab === 'pose' ? '动作' : '表情';

  const charCachedMap = selectedPresetByChar[character.id];
  const activeByCategory = useMemo(
    () => ({
      outfit: resolveActivePreset(
        'outfit',
        character.outfit.text,
        customPresets,
        charCachedMap?.outfit
      ),
      pose: resolveActivePreset(
        'pose',
        character.pose.text,
        customPresets,
        charCachedMap?.pose
      ),
      expression: resolveActivePreset(
        'expression',
        character.expression.text,
        customPresets,
        charCachedMap?.expression
      ),
    }),
    [
      character.outfit.text,
      character.pose.text,
      character.expression.text,
      customPresets,
      charCachedMap?.outfit,
      charCachedMap?.pose,
      charCachedMap?.expression,
    ]
  );

  const activeCurrentPreset = activeByCategory[presetTab];
  const activeSlotStats = getPromptStats(character[presetTab].text, 3);

  const forbiddenCount = (character.forbiddenTags ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean).length;

  const handleSaveCurrentAsPreset = () => {
    const slot = character[presetTab];
    const tags = slot.text.trim();
    if (!tags) return;
    const zhName =
      presetSaveName.trim() || `${tabLabel} #${customTabPresets.length + 1}`;
    const newItem: SimplePresetItem = {
      id: `custom-preset-${Date.now()}`,
      category: presetTab,
      zhName,
      vibe: '自定义',
      tags,
      defaultWeight: clampWeight(slot.weight),
      isCustom: true,
    };
    onUpdateCustomPresets([newItem, ...customPresets]);
    setPresetSaveName('');
    setShowPresetSave(false);
  };

  const handleImportPresets = (raw: string) => {
    setPresetImportError(null);
    setPresetImportNotice(null);
    const { items, error } = parseCutePresetsImport(raw, presetTab);
    if (error || items.length === 0) {
      setPresetImportError(error || '未解析到有效预设');
      return;
    }
    onUpdateCustomPresets([...items, ...customPresets]);
    setPresetImportText('');
    const firstCat = items[0]?.category;
    if (firstCat && items.every((i) => i.category === firstCat)) {
      setPresetTab(firstCat);
    }
    setStyleFilter('all');
    setPresetImportNotice(`成功导入 ${items.length} 条预设`);
  };

  const handleExportCustomPresets = () => {
    const blob = new Blob([JSON.stringify(customPresets, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'chibiprompt-cute-presets.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <section className="flex-1 min-w-0 lg:h-full lg:overflow-y-auto pr-0.5 flex flex-col gap-3">
      {/* 角色槽位编辑卡片：宽松呼吸感 44px 行高 */}
      <div className="rounded-[14px] studio-card overflow-hidden shrink-0">
        <div className="px-5 py-3.5 border-b border-[#EAEAEF] flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <span
              aria-hidden="true"
              style={{
                backgroundColor: avatar.bg,
                boxShadow: `0 0 0 3px ${avatar.ring}`,
              }}
              className="w-3 h-3 rounded-full shrink-0"
            />
            <h2 className="text-[14px] font-semibold text-[#1E2028] truncate">
              {character.name}
            </h2>
            {character.enableFourthLora && (
              <span className="text-[11px] font-medium text-[#E85D75] bg-[#FFF1F4] px-2 py-0.5 rounded-full whitespace-nowrap">
                第4层 LoRA 已启用
              </span>
            )}
          </div>

          <div className="flex items-center gap-3 shrink-0 text-[12px]">
            <label
              title="按导入说明，仅「伊」需要启用第 4 层 LoRA (anima_ibuki_swimsuit_v1)"
              className="inline-flex items-center gap-1.5 cursor-pointer select-none text-[#5A6072] hover:text-[#1E2028] transition-colors"
            >
              <input
                type="checkbox"
                checked={Boolean(character.enableFourthLora)}
                onChange={(e) =>
                  onUpdateCharacter({
                    ...character,
                    enableFourthLora: e.target.checked,
                  })
                }
                className="w-3.5 h-3.5 accent-[#7C5CFC] rounded"
              />
              <span>ibuki LoRA</span>
            </label>

            <button
              type="button"
              onClick={() => setShowForbidden((v) => !v)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[10px] text-[12px] font-medium transition-colors cursor-pointer ${
                showForbidden
                  ? 'bg-[#7C5CFC]/10 text-[#6B48F5]'
                  : 'text-[#686E7E] hover:text-[#1E2028] hover:bg-[#F5F5F9]'
              }`}
            >
              <ShieldAlert className="w-3.5 h-3.5" />
              <span>禁用词 ({forbiddenCount})</span>
            </button>
          </div>
        </div>

        {showForbidden && (
          <div className="flex items-center gap-2.5 px-5 py-2.5 border-b border-[#EAEAEF] bg-[#FAFAFC]">
            <span className="text-[11px] font-medium text-[#686E7E] whitespace-nowrap">
              防串禁用词
            </span>
            <input
              type="text"
              value={character.forbiddenTags ?? ''}
              onChange={(e) =>
                onUpdateCharacter({ ...character, forbiddenTags: e.target.value })
              }
              placeholder="逗号分隔，如：blonde hair, side ponytail, hoshino, mari"
              className="flex-1 rounded-[8px] border border-[#E0E0E6] bg-white px-2.5 py-1 text-[12px] font-mono text-[#1E2028] focus:border-[#7C5CFC] focus:outline-none"
            />
          </div>
        )}

        <div className="py-1 divide-y divide-[#EAEAEF]/80">
          {SLOT_DEFS.map((def) => (
            <CompactSlotRow
              key={def.key}
              label={def.label}
              text={character[def.key].text}
              weight={character[def.key].weight}
              expanded={openSlot === def.key}
              onToggleExpand={() =>
                setOpenSlot((prev) => (prev === def.key ? null : def.key))
              }
              onTextChange={(text) => updateSlot(def.key, { text })}
              onWeightChange={(weight) => updateSlot(def.key, { weight })}
              placeholder={def.placeholder}
              emptyHint={def.emptyHint}
            />
          ))}
        </div>
      </div>

      {/* 可爱预设快填：上方已选摘要条 + 分类切换 + 风格筛选 + 充足可视高度的卡片流 */}
      <div className="flex-1 min-h-[360px] rounded-[14px] studio-card flex flex-col overflow-hidden shrink-0 lg:shrink">
        <div
          role="button"
          tabIndex={0}
          onClick={() => setPresetsExpanded((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setPresetsExpanded((v) => !v);
            }
          }}
          className="px-5 py-3 flex items-center justify-between gap-3 cursor-pointer select-none hover:bg-[#FAFAFC] transition-colors duration-150 shrink-0"
        >
          <div className="flex items-center gap-2 min-w-0">
            <ChevronRight
              className={`w-4 h-4 text-[#949AA8] shrink-0 transition-transform duration-150 ${
                presetsExpanded ? 'rotate-90 text-[#7C5CFC]' : ''
              }`}
            />
            <span className="text-[13px] font-semibold text-[#1E2028] whitespace-nowrap">
              可爱预设快填
            </span>
            {activeCurrentPreset ? (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#F4F2FF] border border-[#7C5CFC]/30 text-[#6B48F5] text-[11px] font-medium truncate max-w-[200px]">
                <Check className="w-3 h-3 shrink-0" />
                <span className="truncate">
                  {tabLabel}：{activeCurrentPreset.zhName}
                </span>
              </span>
            ) : (
              <span className="text-[11px] text-[#8E94A4] tabular-nums truncate">
                服装 {OUTFIT_PRESETS.length} · 动作 {POSE_PRESETS.length} · 表情{' '}
                {EXPRESSION_PRESETS.length}
                {customPresets.length > 0 ? ` · 自定义 ${customPresets.length}` : ''}
              </span>
            )}
          </div>

          <div
            className="flex items-center gap-1.5 shrink-0"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => {
                setPresetsExpanded(true);
                setShowPresetImport((v) => !v);
                setShowPresetSave(false);
              }}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded-[10px] border border-[#E0E0E6] bg-white text-[#5A6072] hover:border-[#7C5CFC]/40 hover:text-[#7C5CFC] transition-colors cursor-pointer"
            >
              <Upload className="w-3 h-3" />
              <span>导入预设</span>
            </button>
          </div>
        </div>

        {presetsExpanded && (
          <div className="flex-1 min-h-0 px-5 pb-4 pt-3 border-t border-[#EAEAEF] flex flex-col gap-2.5">
            {/* 分类标签上方：固定「当前已选预设摘要条」 */}
            <div className="rounded-[10px] border border-[#E2E0F2] bg-[#FAF9FF] px-3 py-2 space-y-1.5 shrink-0">
              <div className="flex flex-wrap items-center justify-between gap-2 text-[11.5px]">
                <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                  <span className="font-medium text-[#5A6072] shrink-0">
                    当前已选{tabLabel}：
                  </span>
                  {activeCurrentPreset ? (
                    <span
                      className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold ${
                        activeCurrentPreset.isCustom
                          ? 'bg-[#E85D75] text-white'
                          : 'bg-[#7C5CFC] text-white'
                      }`}
                    >
                      <Check className="w-3 h-3 shrink-0" />
                      <span>{activeCurrentPreset.zhName}</span>
                    </span>
                  ) : character[presetTab].text.trim() ? (
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-white border border-[#D4D6E4] text-[#1E2028]">
                      自定义{tabLabel}（含 {activeSlotStats.tagCount} 词）
                    </span>
                  ) : (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] bg-[#EFEFF4] text-[#8E94A4]">
                      未选择
                    </span>
                  )}

                  {character[presetTab].text.trim() && (
                    <span
                      title={character[presetTab].text}
                      className="text-[11px] font-mono text-[#686E7E] truncate max-w-[260px]"
                    >
                      {activeSlotStats.preview}
                    </span>
                  )}
                </div>

                {character[presetTab].text.trim() && (
                  <button
                    type="button"
                    onClick={() => handleClearCategorySlot(presetTab)}
                    className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-[8px] border border-[#E2E3EA] bg-white text-[11px] font-medium text-[#686E7E] hover:border-[#F8C8D2] hover:bg-[#FFF1F3] hover:text-[#C93B58] cursor-pointer shrink-0 transition-colors"
                  >
                    <X className="w-3 h-3" />
                    <span>清除当前分类</span>
                  </button>
                )}
              </div>

              {/* 服装 / 动作 / 表情三槽位总览胶囊，点击切换对应分类 */}
              <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-[#EAE8F5]">
                {(
                  [
                    { key: 'outfit', label: '服装' },
                    { key: 'pose', label: '动作' },
                    { key: 'expression', label: '表情' },
                  ] as { key: PresetCategory; label: string }[]
                ).map((slotMeta) => {
                  const matched = activeByCategory[slotMeta.key];
                  const slotHasText = Boolean(character[slotMeta.key].text.trim());
                  const isCurrentTab = presetTab === slotMeta.key;
                  const summaryLabel = matched
                    ? matched.zhName
                    : slotHasText
                    ? `自定义 (${getPromptStats(character[slotMeta.key].text).tagCount}词)`
                    : '未选';

                  return (
                    <div
                      key={slotMeta.key}
                      className={`inline-flex items-center rounded-full border text-[10.5px] transition-colors ${
                        isCurrentTab
                          ? 'border-[#7C5CFC]/50 bg-white text-[#5B3DF5] font-medium shadow-2xs'
                          : 'border-[#E6E6EE] bg-white/75 text-[#5A6072] hover:border-[#7C5CFC]/35'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => setPresetTab(slotMeta.key)}
                        className="px-2 py-0.5 cursor-pointer flex items-center gap-1 max-w-[180px]"
                      >
                        <span className="text-[#8E94A4] shrink-0">
                          {slotMeta.label}:
                        </span>
                        <span className="truncate">{summaryLabel}</span>
                      </button>
                      {slotHasText && (
                        <button
                          type="button"
                          onClick={() => handleClearCategorySlot(slotMeta.key)}
                          title={`清空${slotMeta.label}`}
                          aria-label={`清空${slotMeta.label}`}
                          className="pr-1.5 text-[#949AA8] hover:text-[#E85D75] cursor-pointer"
                        >
                          <X className="w-2.5 h-2.5" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 主分类胶囊（服装 / 动作 / 表情）+ 保存/导出按钮 */}
            <div className="flex flex-wrap items-center justify-between gap-2 shrink-0">
              <div className="inline-flex items-center gap-1 rounded-full bg-[#F2F3F7] p-1">
                {(
                  [
                    { id: 'outfit', label: '可爱服装' },
                    { id: 'pose', label: '动作姿态' },
                    { id: 'expression', label: '萌系表情' },
                  ] as { id: PresetCategory; label: string }[]
                ).map((t) => {
                  const active = presetTab === t.id;
                  const hasMatched = Boolean(activeByCategory[t.id]);
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setPresetTab(t.id)}
                      className={`px-3.5 py-1 text-[12px] font-medium rounded-full transition-all cursor-pointer whitespace-nowrap inline-flex items-center gap-1.5 ${
                        active
                          ? 'bg-white text-[#6B48F5] shadow-[0_1px_3px_rgba(18,22,33,0.08)]'
                          : 'text-[#686E7E] hover:text-[#1E2028]'
                      }`}
                    >
                      <span>{t.label}</span>
                      {hasMatched && (
                        <span
                          className={`w-1.5 h-1.5 rounded-full ${
                            active ? 'bg-[#7C5CFC]' : 'bg-[#7C5CFC]/50'
                          }`}
                        />
                      )}
                    </button>
                  );
                })}
              </div>

              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setShowPresetSave((v) => !v);
                    setShowPresetImport(false);
                  }}
                  disabled={!character[presetTab].text.trim()}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-[11px] font-medium rounded-[10px] bg-[#F4F2FF] text-[#6B48F5] hover:bg-[#EBE6FF] cursor-pointer disabled:opacity-40 transition-colors"
                >
                  <Plus className="w-3 h-3" />
                  <span>存当前{tabLabel}</span>
                </button>
                {customPresets.length > 0 && (
                  <button
                    type="button"
                    onClick={handleExportCustomPresets}
                    className="inline-flex items-center gap-1 px-3 py-1.5 text-[11px] font-medium rounded-[10px] border border-[#E0E0E6] bg-white text-[#5A6072] hover:border-[#7C5CFC]/40 hover:text-[#7C5CFC] cursor-pointer transition-colors"
                  >
                    <Download className="w-3 h-3" />
                    <span>导出</span>
                  </button>
                )}
              </div>
            </div>

            {/* 轻量风格 / 场景快捷筛选胶囊 */}
            <div className="flex flex-wrap items-center justify-between gap-2 shrink-0">
              <div className="flex flex-wrap items-center gap-1.5">
                {STYLE_FILTERS.map((f) => {
                  const active = styleFilter === f.id;
                  return (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => setStyleFilter(f.id)}
                      className={`px-2.5 py-1 text-[11px] rounded-full border transition-colors cursor-pointer whitespace-nowrap ${
                        active
                          ? 'border-[#7C5CFC]/40 bg-[#F3F0FF] text-[#6B48F5] font-medium'
                          : 'border-transparent bg-[#F4F4F7] text-[#686E7E] hover:text-[#1E2028] hover:bg-[#ECECF2]'
                      }`}
                    >
                      {f.label}
                    </button>
                  );
                })}
              </div>
              <span className="text-[11px] text-[#949AA8] tabular-nums whitespace-nowrap">
                显示 {filteredPresets.length} / {allTabPresets.length}
              </span>
            </div>

            {showPresetSave && (
              <div className="flex items-center gap-2 rounded-[10px] border border-[#E0E0E6] bg-[#FAFAFC] p-2 shrink-0">
                <input
                  type="text"
                  value={presetSaveName}
                  onChange={(e) => setPresetSaveName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSaveCurrentAsPreset();
                  }}
                  placeholder={`输入${tabLabel}预设名称...`}
                  className="flex-1 rounded-[8px] border border-[#E0E0E6] bg-white px-2.5 py-1 text-[12px] text-[#1E2028] focus:border-[#7C5CFC] focus:outline-none"
                />
                <button
                  type="button"
                  onClick={handleSaveCurrentAsPreset}
                  className="px-3 py-1 text-[11px] font-medium rounded-[10px] bg-gradient-to-b from-[#8A6CFF] to-[#7C5CFC] text-white shadow-xs hover:brightness-105 cursor-pointer"
                >
                  保存
                </button>
              </div>
            )}

            {showPresetImport && (
              <div className="rounded-[10px] border border-[#E0E0E6] bg-[#FAFAFC] p-3 space-y-2 shrink-0">
                <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                  <span className="text-[#686E7E]">
                    支持 JSON / ComfyUI 工作流 / 按行「名称 | 英文词」或「名称 | 权重 | 英文词」
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        setPresetImportText(
                          presetTab === 'outfit'
                            ? '布丁水手裙 | 1.4 | pastel cream sailor dress, caramel brown ribbon, pleated skirt, white knee socks'
                            : presetTab === 'pose'
                            ? '单手叉腰歪头 | 1.4 | one hand on hip, cute head tilt, slight forward lean'
                            : '星星眼惊喜 | 1.4 | sparkling eyes, excited open mouth, light blush, happy'
                        )
                      }
                      className="text-[#7C5CFC] hover:underline cursor-pointer"
                    >
                      填入示例
                    </button>
                    <input
                      ref={presetFileRef}
                      type="file"
                      accept=".json,.txt,application/json,text/plain"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        const reader = new FileReader();
                        reader.onload = () =>
                          handleImportPresets(String(reader.result || ''));
                        reader.readAsText(file);
                        if (presetFileRef.current) presetFileRef.current.value = '';
                      }}
                      className="hidden"
                    />
                    <button
                      type="button"
                      onClick={() => presetFileRef.current?.click()}
                      className="px-2.5 py-0.5 rounded-[8px] border border-[#E0E0E6] bg-white text-[#4C5264] hover:border-[#7C5CFC]/40 cursor-pointer"
                    >
                      选文件
                    </button>
                  </div>
                </div>
                <textarea
                  value={presetImportText}
                  onChange={(e) => setPresetImportText(e.target.value)}
                  rows={2}
                  spellCheck={false}
                  placeholder="粘贴 JSON 或每行一条：预设名 | english tags..."
                  className="w-full rounded-[8px] border border-[#E0E0E6] bg-white px-2.5 py-1.5 text-[11px] font-mono text-[#1E2028] focus:border-[#7C5CFC] focus:outline-none"
                />
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <span>
                    {presetImportError && (
                      <span className="text-[#E85D75]">{presetImportError}</span>
                    )}
                    {presetImportNotice && (
                      <span className="text-emerald-600">{presetImportNotice}</span>
                    )}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleImportPresets(presetImportText)}
                    className="px-3 py-1 rounded-[10px] bg-gradient-to-b from-[#8A6CFF] to-[#7C5CFC] text-white font-medium cursor-pointer"
                  >
                    解析并导入
                  </button>
                </div>
              </div>
            )}

            {/* 清爽卡片流：只突出「简短中文名 + 2 个核心英文关键词」，10px 间距 */}
            {filteredPresets.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center py-8 text-center gap-2">
                <p className="text-[12px] text-[#8E94A4]">该风格分组下暂无匹配预设</p>
                <button
                  type="button"
                  onClick={() => setStyleFilter('all')}
                  className="px-3 py-1 rounded-[8px] bg-[#F4F2FF] text-[11.5px] font-medium text-[#6B48F5] hover:bg-[#EBE6FF] cursor-pointer"
                >
                  查看全部{tabLabel}
                </button>
              </div>
            ) : (
              <div
                ref={presetGridRef}
                className="flex-1 min-h-[190px] overflow-y-auto pr-1 grid grid-cols-1 sm:grid-cols-2 gap-[10px] content-start"
              >
                {filteredPresets.map((item) => {
                  const isActive = activeCurrentPreset?.id === item.id;
                  const coreKeywords = getCoreEnglishKeywords(item.tags, 2);

                  return (
                    <div
                      key={item.id}
                      className={`group/card relative rounded-[12px] transition-all duration-150 ${
                        isActive
                          ? item.isCustom
                            ? 'border-2 border-[#E85D75] bg-[#FFF1F3] shadow-[0_3px_12px_rgba(232,93,117,0.14)]'
                            : 'border-2 border-[#7C5CFC] bg-[#F3F0FF] shadow-[0_3px_12px_rgba(124,92,252,0.16)]'
                          : 'border border-[#EAEAEF] bg-[#FAFAFC]/80 hover:bg-white hover:border-[#D4D6E4] hover:shadow-xs'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => handleApplyPreset(item)}
                        title={item.tags}
                        className="w-full text-left px-3.5 py-2.5 cursor-pointer"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span
                            className={`text-[12.5px] font-semibold truncate flex items-center gap-1.5 ${
                              isActive
                                ? item.isCustom
                                  ? 'text-[#B42343]'
                                  : 'text-[#5B3DF5]'
                                : 'text-[#1E2028]'
                            }`}
                          >
                            {item.isCustom && (
                              <span className="w-1.5 h-1.5 rounded-full bg-[#E85D75] shrink-0" />
                            )}
                            <span className="truncate">{item.zhName}</span>
                          </span>

                          <div
                            className={`flex items-center gap-1.5 shrink-0 ${
                              item.isCustom ? 'pr-5' : ''
                            }`}
                          >
                            {isActive ? (
                              <span
                                className={`inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-[10px] font-semibold whitespace-nowrap ${
                                  item.isCustom
                                    ? 'bg-[#E85D75] text-white'
                                    : 'bg-[#7C5CFC] text-white'
                                }`}
                              >
                                <Check className="w-2.5 h-2.5" />
                                <span>已选</span>
                              </span>
                            ) : (
                              <span className="text-[10.5px] text-[#A0A6B4] opacity-0 group-hover/card:opacity-100 transition-opacity duration-150 whitespace-nowrap">
                                {item.vibe}
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          {coreKeywords.map((kw, idx) => (
                            <span
                              key={`${item.id}-kw-${idx}`}
                              className={`inline-flex items-center px-2 py-0.5 rounded-[6px] text-[10.5px] leading-tight whitespace-nowrap ${
                                isActive
                                  ? item.isCustom
                                    ? 'bg-[#E85D75]/15 text-[#B42343] font-medium'
                                    : 'bg-[#7C5CFC]/15 text-[#5B3DF5] font-medium'
                                  : 'bg-[#EFEFF4] text-[#555B6E]'
                              }`}
                            >
                              {kw}
                            </span>
                          ))}
                        </div>
                      </button>

                      {item.isCustom && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onUpdateCustomPresets(
                              customPresets.filter((p) => p.id !== item.id)
                            );
                            if (activeCurrentPreset?.id === item.id) {
                              recordPresetSelection(character.id, item.category, null);
                            }
                          }}
                          aria-label={`删除 ${item.zhName}`}
                          className="absolute top-2.5 right-2 p-1 rounded-[6px] text-[#949AA8] hover:text-[#E85D75] hover:bg-[#FFF1F3] cursor-pointer"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
};
