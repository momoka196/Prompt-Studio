import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronRight,
  Download,
  Plus,
  RotateCcw,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import {
  DEFAULT_STUDIO_CONFIG,
  MINIMAL_BACKGROUNDS,
  SHARED_BODY_TYPE_STRING,
} from '../data/presets';
import {
  CharacterConfig,
  MinimalBackgroundPreset,
  NegativeGroupId,
  SharedConfig,
  WeightedSlot,
} from '../types/studio';
import {
  buildSharedNegativePrompt,
  clampWeight,
  getPromptStats,
  normalizeSlotTagsText,
  recommendAntiOutfitTags,
} from '../utils/promptBuilder';
import { parseBackgroundPresetsImport } from '../utils/presetImporter';
import { loadUiCache, patchUiCache } from '../utils/storageCache';
import { CompactSlotRow } from './CompactSlotRow';

interface SharedLayerPanelProps {
  shared: SharedConfig;
  characters: CharacterConfig[];
  onUpdateShared: (updated: SharedConfig) => void;
  customBackgrounds: MinimalBackgroundPreset[];
  onUpdateCustomBackgrounds: (items: MinimalBackgroundPreset[]) => void;
}

export const SharedLayerPanel: React.FC<SharedLayerPanelProps> = ({
  shared,
  characters,
  onUpdateShared,
  customBackgrounds,
  onUpdateCustomBackgrounds,
}) => {
  const [barExpanded, setBarExpandedState] = useState<boolean>(
    () => loadUiCache().sharedBarExpanded
  );
  const [openSlot, setOpenSlotState] = useState<string | null>(
    () => loadUiCache().sharedOpenSlot
  );
  const [showNegGroups, setShowNegGroupsState] = useState<boolean>(
    () => loadUiCache().showNegGroups
  );

  const setBarExpanded = (updater: boolean | ((prev: boolean) => boolean)) => {
    setBarExpandedState((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      patchUiCache({ sharedBarExpanded: next });
      return next;
    });
  };

  const setOpenSlot = (
    updater: string | null | ((prev: string | null) => string | null)
  ) => {
    setOpenSlotState((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      patchUiCache({ sharedOpenSlot: next });
      return next;
    });
  };

  const setShowNegGroups = (updater: boolean | ((prev: boolean) => boolean)) => {
    setShowNegGroupsState((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      patchUiCache({ showNegGroups: next });
      return next;
    });
  };

  const [cachedBgSelection, setCachedBgSelection] = useState<{
    id: string | null;
    name: string | null;
  }>(() => {
    const cache = loadUiCache();
    return {
      id: shared.selectedBackgroundId ?? cache.selectedBackgroundId,
      name: shared.selectedBackgroundName ?? cache.selectedBackgroundName,
    };
  });

  const [newTagInputs, setNewTagInputs] = useState<Record<string, string>>({});
  const [newTagWeights, setNewTagWeights] = useState<Record<string, number>>({});
  const [showBgSave, setShowBgSave] = useState(false);
  const [bgSaveName, setBgSaveName] = useState('');
  const [showBgImport, setShowBgImport] = useState(false);
  const [bgImportText, setBgImportText] = useState('');
  const [bgImportError, setBgImportError] = useState<string | null>(null);
  const [bgImportNotice, setBgImportNotice] = useState<string | null>(null);
  const bgFileRef = useRef<HTMLInputElement | null>(null);

  const compiledNegative = buildSharedNegativePrompt(shared);
  const negStats = getPromptStats(compiledNegative);
  const bgStats = getPromptStats(shared.background.text, 4);
  const styleStats = getPromptStats(shared.styleAnchor.text);
  const compStats = getPromptStats(shared.composition.text);

  const allBackgrounds = useMemo(
    () => [...customBackgrounds, ...MINIMAL_BACKGROUNDS],
    [customBackgrounds]
  );

  const currentBgTrimmed = shared.background.text.trim();
  const defaultBgTrimmed = DEFAULT_STUDIO_CONFIG.shared.background.text.trim();

  const activeBgPreset = useMemo(() => {
    if (!currentBgTrimmed) return null;
    const preferredId = shared.selectedBackgroundId ?? cachedBgSelection.id;
    if (preferredId) {
      const byId = allBackgrounds.find(
        (bg) => bg.id === preferredId && bg.tags.trim() === currentBgTrimmed
      );
      if (byId) return byId;
    }
    return (
      allBackgrounds.find((bg) => bg.tags.trim() === currentBgTrimmed) ?? null
    );
  }, [allBackgrounds, currentBgTrimmed, shared.selectedBackgroundId, cachedBgSelection.id]);

  const activeBgLabel = activeBgPreset
    ? activeBgPreset.zhName
    : !currentBgTrimmed
    ? '未设置场景'
    : currentBgTrimmed === defaultBgTrimmed
    ? '默认午后窗边教室'
    : '自定义场景';

  const persistBgSelection = (id: string | null, name: string | null) => {
    setCachedBgSelection({ id, name });
    patchUiCache({ selectedBackgroundId: id, selectedBackgroundName: name });
  };

  useEffect(() => {
    const trimmed = shared.background.text.trim();
    if (!trimmed) {
      if (cachedBgSelection.id !== null || cachedBgSelection.name !== null) {
        persistBgSelection(null, null);
      }
      return;
    }
    if (shared.selectedBackgroundId !== undefined) {
      const nextId = shared.selectedBackgroundId ?? null;
      const nextName = shared.selectedBackgroundName ?? null;
      if (cachedBgSelection.id !== nextId || cachedBgSelection.name !== nextName) {
        setCachedBgSelection({ id: nextId, name: nextName });
      }
    }
  }, [
    shared.background.text,
    shared.selectedBackgroundId,
    shared.selectedBackgroundName,
    cachedBgSelection.id,
    cachedBgSelection.name,
  ]);

  const updatePositiveSlot = (
    key: 'styleAnchor' | 'background' | 'composition' | 'bodyType',
    patch: Partial<WeightedSlot>
  ) => {
    const existing = shared[key] ?? { text: '', weight: 1.0 };
    if (key === 'background' && patch.text !== undefined) {
      const nextTrimmed = patch.text.trim();
      const matched = nextTrimmed
        ? allBackgrounds.find((bg) => bg.tags.trim() === nextTrimmed) ?? null
        : null;
      const nextId = matched?.id ?? null;
      const nextName = matched?.zhName ?? null;
      persistBgSelection(nextId, nextName);
      onUpdateShared({
        ...shared,
        selectedBackgroundId: nextId,
        selectedBackgroundName: nextName,
        background: {
          ...existing,
          ...patch,
        },
      });
      return;
    }

    onUpdateShared({
      ...shared,
      [key]: {
        ...existing,
        ...patch,
      },
    });
  };

  const handleSelectBackgroundPreset = (bg: MinimalBackgroundPreset) => {
    const cleanTags = normalizeSlotTagsText(bg.tags) || bg.tags.trim();
    persistBgSelection(bg.id, bg.zhName);
    onUpdateShared({
      ...shared,
      selectedBackgroundId: bg.id,
      selectedBackgroundName: bg.zhName,
      background: {
        ...shared.background,
        text: cleanTags,
      },
    });
  };

  const handleClearBackground = () => {
    persistBgSelection(null, null);
    onUpdateShared({
      ...shared,
      selectedBackgroundId: null,
      selectedBackgroundName: null,
      background: {
        ...shared.background,
        text: '',
      },
    });
  };

  const handleRestoreDefaultBackground = () => {
    persistBgSelection(null, null);
    onUpdateShared({
      ...shared,
      selectedBackgroundId: null,
      selectedBackgroundName: null,
      background: {
        ...DEFAULT_STUDIO_CONFIG.shared.background,
      },
    });
  };

  const toggleGroup = (groupId: NegativeGroupId) => {
    onUpdateShared({
      ...shared,
      manualNegativeOverride: null,
      negativeGroups: shared.negativeGroups.map((g) =>
        g.id === groupId ? { ...g, enabled: !g.enabled } : g
      ),
    });
  };

  const updateNegativeTag = (
    groupId: NegativeGroupId,
    tagId: string,
    patch: { text?: string; weight?: number }
  ) => {
    onUpdateShared({
      ...shared,
      manualNegativeOverride: null,
      negativeGroups: shared.negativeGroups.map((g) =>
        g.id === groupId
          ? {
              ...g,
              tags: g.tags.map((t) =>
                t.id === tagId
                  ? {
                      ...t,
                      text: patch.text !== undefined ? patch.text : t.text,
                      weight:
                        patch.weight !== undefined
                          ? clampWeight(patch.weight)
                          : t.weight,
                    }
                  : t
              ),
            }
          : g
      ),
    });
  };

  const deleteNegativeTag = (groupId: NegativeGroupId, tagId: string) => {
    onUpdateShared({
      ...shared,
      manualNegativeOverride: null,
      negativeGroups: shared.negativeGroups.map((g) =>
        g.id === groupId
          ? { ...g, tags: g.tags.filter((t) => t.id !== tagId) }
          : g
      ),
    });
  };

  const addNegativeTag = (groupId: NegativeGroupId) => {
    const raw = (newTagInputs[groupId] || '').trim();
    if (!raw) return;
    const w = clampWeight(newTagWeights[groupId] ?? 1.4);

    onUpdateShared({
      ...shared,
      manualNegativeOverride: null,
      negativeGroups: shared.negativeGroups.map((g) =>
        g.id === groupId
          ? {
              ...g,
              enabled: true,
              tags: [
                ...g.tags,
                {
                  id: `nt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                  text: raw,
                  weight: w,
                },
              ],
            }
          : g
      ),
    });
    setNewTagInputs((prev) => ({ ...prev, [groupId]: '' }));
  };

  const handleRecommendOutfits = () => {
    const recommended = recommendAntiOutfitTags(characters);
    onUpdateShared({
      ...shared,
      manualNegativeOverride: null,
      negativeGroups: shared.negativeGroups.map((g) => {
        if (g.id !== 'anti-outfit-bleed') return g;
        return {
          ...g,
          enabled: true,
          tags: recommended.map((tag, idx) => ({
            id: `no-auto-${Date.now()}-${idx}`,
            text: tag,
            weight: 1.4,
          })),
        };
      }),
    });
  };

  const handleSaveCurrentBackground = () => {
    const tags = shared.background.text.trim();
    if (!tags) return;
    const zhName = bgSaveName.trim() || `自定义背景 #${customBackgrounds.length + 1}`;
    const newItem: MinimalBackgroundPreset = {
      id: `custom-bg-${Date.now()}`,
      zhName,
      note: '由当前背景保存',
      tags,
      isCustom: true,
    };
    onUpdateCustomBackgrounds([newItem, ...customBackgrounds]);
    persistBgSelection(newItem.id, newItem.zhName);
    onUpdateShared({
      ...shared,
      selectedBackgroundId: newItem.id,
      selectedBackgroundName: newItem.zhName,
    });
    setBgSaveName('');
    setShowBgSave(false);
  };

  const handleImportBackgrounds = (raw: string) => {
    setBgImportError(null);
    setBgImportNotice(null);
    const { items, error } = parseBackgroundPresetsImport(raw);
    if (error || items.length === 0) {
      setBgImportError(error || '未解析到有效背景');
      return;
    }
    onUpdateCustomBackgrounds([...items, ...customBackgrounds]);
    setBgImportText('');
    setBgImportNotice(`成功导入 ${items.length} 条背景预设`);
  };

  const handleExportCustomBackgrounds = () => {
    const blob = new Blob([JSON.stringify(customBackgrounds, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'chibiprompt-backgrounds.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const toggleSlot = (key: string) => {
    setOpenSlot((prev) => (prev === key ? null : key));
  };

  return (
    <section className="shrink-0 rounded-[14px] studio-card overflow-hidden">
      <button
        type="button"
        onClick={() => setBarExpanded((v) => !v)}
        aria-expanded={barExpanded}
        className="w-full h-11 px-5 flex items-center justify-between gap-3 text-left hover:bg-[#FAFAFC] transition-colors duration-150 cursor-pointer"
      >
        <div className="flex items-center gap-3 min-w-0">
          <ChevronRight
            className={`w-4 h-4 text-[#949AA8] shrink-0 transition-transform duration-150 ${
              barExpanded ? 'rotate-90 text-[#7C5CFC]' : ''
            }`}
          />
          <span className="text-[12.5px] font-semibold text-[#1E2028] whitespace-nowrap shrink-0">
            全局共享层
          </span>

          <div className="hidden sm:flex items-center gap-1.5 overflow-hidden min-w-0">
            <span
              title={`当前场景：${activeBgLabel} · 含 ${bgStats.tagCount} 词${
                currentBgTrimmed ? `\n${currentBgTrimmed}` : ''
              }`}
              className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-medium whitespace-nowrap max-w-[260px] truncate border ${
                currentBgTrimmed
                  ? 'bg-[#F4F2FF] border-[#7C5CFC]/25 text-[#6B48F5]'
                  : 'bg-[#F2F3F7] border-transparent text-[#8E94A4]'
              }`}
            >
              <span className="truncate">
                场景：{activeBgLabel}
                {bgStats.tagCount > 0 ? ` · ${bgStats.tagCount} 词` : ''}
              </span>
            </span>
            <span className="inline-flex items-center px-2 py-0.5 rounded-[6px] bg-[#F2F3F7] text-[#5A6072] text-[11px] tabular-nums whitespace-nowrap">
              负向 {negStats.tagCount}
            </span>
            <span className="inline-flex items-center px-2 py-0.5 rounded-[6px] bg-[#F2F3F7] text-[#5A6072] text-[11px] tabular-nums whitespace-nowrap">
              画风 {styleStats.tagCount}
            </span>
            <span className="inline-flex items-center px-2 py-0.5 rounded-[6px] bg-[#F2F3F7] text-[#5A6072] text-[11px] tabular-nums whitespace-nowrap">
              构图 {compStats.tagCount}
            </span>
          </div>
        </div>

        <span className="text-[11.5px] font-medium text-[#7C5CFC] whitespace-nowrap shrink-0">
          {barExpanded ? '收起配置' : '展开配置'}
        </span>
      </button>

      {barExpanded && (
        <div className="border-t border-[#EAEAEF] py-2 space-y-1 divide-y divide-[#EAEAEF]/70 max-h-[55vh] overflow-y-auto">
          <CompactSlotRow
            label="画风"
            text={shared.styleAnchor.text}
            weight={shared.styleAnchor.weight}
            expanded={openSlot === 'styleAnchor'}
            onToggleExpand={() => toggleSlot('styleAnchor')}
            onTextChange={(text) => updatePositiveSlot('styleAnchor', { text })}
            onWeightChange={(weight) => updatePositiveSlot('styleAnchor', { weight })}
            placeholder="@4x0style"
          />
          <CompactSlotRow
            label="构图"
            text={shared.composition.text}
            weight={shared.composition.weight}
            expanded={openSlot === 'composition'}
            onToggleExpand={() => toggleSlot('composition')}
            onTextChange={(text) => updatePositiveSlot('composition', { text })}
            onWeightChange={(weight) => updatePositiveSlot('composition', { weight })}
            placeholder="full body, entire body visible, head to toe, ample margin"
          />
          <CompactSlotRow
            label="场景"
            text={shared.background.text}
            weight={shared.background.weight}
            expanded={openSlot === 'background'}
            onToggleExpand={() => toggleSlot('background')}
            onTextChange={(text) => updatePositiveSlot('background', { text })}
            onWeightChange={(weight) => updatePositiveSlot('background', { weight })}
            placeholder="detailed background, indoor, school classroom, afternoon sunlight..."
            belowRowContent={
              <div className="px-5 py-2 bg-[#FAFAFC]/90 border-t border-[#EAEAEF]/70 flex flex-wrap items-center justify-between gap-2 text-[11.5px]">
                <div className="flex flex-wrap items-center gap-2 min-w-0">
                  <span className="text-[#686E7E] shrink-0">当前场景：</span>
                  <span
                    className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold border ${
                      activeBgPreset
                        ? activeBgPreset.isCustom
                          ? 'border-[#E85D75]/35 bg-[#FFF1F3] text-[#C93B58]'
                          : 'border-[#7C5CFC]/30 bg-[#F4F2FF] text-[#6B48F5]'
                        : currentBgTrimmed
                        ? 'border-[#E0E0E6] bg-white text-[#1E2028]'
                        : 'border-[#EAEAEF] bg-[#F2F3F7] text-[#8E94A4]'
                    }`}
                  >
                    {activeBgPreset && <Check className="w-3 h-3 shrink-0" />}
                    <span>{activeBgLabel}</span>
                    {bgStats.tagCount > 0 && (
                      <span className="font-normal opacity-80">
                        · 含 {bgStats.tagCount} 词
                      </span>
                    )}
                  </span>
                  {currentBgTrimmed && (
                    <span
                      title={currentBgTrimmed}
                      className="text-[11px] font-mono text-[#686E7E] truncate max-w-[360px]"
                    >
                      {bgStats.preview}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  {openSlot !== 'background' && (
                    <button
                      type="button"
                      onClick={() => setOpenSlot('background')}
                      className="px-2 py-0.5 text-[11px] font-medium rounded-[8px] bg-[#F4F2FF] text-[#6B48F5] hover:bg-[#EBE6FF] cursor-pointer transition-colors"
                    >
                      选择预设
                    </button>
                  )}
                  {currentBgTrimmed !== defaultBgTrimmed && (
                    <button
                      type="button"
                      onClick={handleRestoreDefaultBackground}
                      className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded-[8px] border border-[#E2E3EA] bg-white text-[#5A6072] hover:border-[#7C5CFC]/40 hover:text-[#7C5CFC] cursor-pointer transition-colors"
                    >
                      <RotateCcw className="w-3 h-3" />
                      <span>还原默认</span>
                    </button>
                  )}
                  {currentBgTrimmed && (
                    <button
                      type="button"
                      onClick={handleClearBackground}
                      className="px-2 py-0.5 text-[11px] rounded-[8px] border border-[#E2E3EA] bg-white text-[#686E7E] hover:border-[#F8C8D2] hover:bg-[#FFF1F3] hover:text-[#C93B58] cursor-pointer transition-colors"
                    >
                      清除
                    </button>
                  )}
                </div>
              </div>
            }
            extraExpandedContent={
              <div className="pt-2.5 border-t border-[#EAEAEF] space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[11px] font-medium text-[#686E7E]">
                    背景预设（{allBackgrounds.length} 条 · 点击即选中并回显）
                  </span>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        setShowBgSave((v) => !v);
                        setShowBgImport(false);
                      }}
                      disabled={!shared.background.text.trim()}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded-[10px] bg-[#F4F2FF] text-[#6B48F5] hover:bg-[#EBE6FF] cursor-pointer disabled:opacity-40 transition-colors"
                    >
                      <Plus className="w-3 h-3" />
                      <span>存当前</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowBgImport((v) => !v);
                        setShowBgSave(false);
                        setBgImportError(null);
                        setBgImportNotice(null);
                      }}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded-[10px] border border-[#EAEAEF] bg-white text-[#5A6072] hover:border-[#7C5CFC]/40 hover:text-[#7C5CFC] cursor-pointer transition-colors"
                    >
                      <Upload className="w-3 h-3" />
                      <span>导入背景</span>
                    </button>
                    {customBackgrounds.length > 0 && (
                      <button
                        type="button"
                        onClick={handleExportCustomBackgrounds}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded-[10px] border border-[#EAEAEF] bg-white text-[#5A6072] hover:border-[#7C5CFC]/40 hover:text-[#7C5CFC] cursor-pointer transition-colors"
                      >
                        <Download className="w-3 h-3" />
                        <span>导出</span>
                      </button>
                    )}
                  </div>
                </div>

                {showBgSave && (
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={bgSaveName}
                      onChange={(e) => setBgSaveName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleSaveCurrentBackground();
                      }}
                      placeholder="输入背景预设名称..."
                      className="flex-1 rounded-[8px] border border-[#E2E3EA] bg-white px-2.5 py-1 text-[12px] text-[#1E2028] focus:border-[#7C5CFC] focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={handleSaveCurrentBackground}
                      className="px-3 py-1 text-[11px] font-medium rounded-[10px] bg-gradient-to-b from-[#8A6CFF] to-[#7C5CFC] text-white cursor-pointer"
                    >
                      保存
                    </button>
                  </div>
                )}

                {showBgImport && (
                  <div className="rounded-[10px] border border-[#EAEAEF] bg-white p-2.5 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                      <span className="text-[#686E7E]">
                        支持 JSON / ComfyUI 工作流 / 按行「名称 | 英文词」
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            setBgImportText(
                              '雨后樱花石板街 | sunny cobblestone street after rain, cherry blossom petals, sky reflection in puddles'
                            )
                          }
                          className="text-[#7C5CFC] hover:underline cursor-pointer"
                        >
                          示例
                        </button>
                        <input
                          ref={bgFileRef}
                          type="file"
                          accept=".json,.txt,application/json,text/plain"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (!file) return;
                            const reader = new FileReader();
                            reader.onload = () =>
                              handleImportBackgrounds(String(reader.result || ''));
                            reader.readAsText(file);
                            if (bgFileRef.current) bgFileRef.current.value = '';
                          }}
                          className="hidden"
                        />
                        <button
                          type="button"
                          onClick={() => bgFileRef.current?.click()}
                          className="px-2 py-0.5 rounded-[8px] border border-[#E2E3EA] bg-[#FAFAFC] text-[#4C5264] hover:border-[#7C5CFC]/40 cursor-pointer"
                        >
                          选文件
                        </button>
                      </div>
                    </div>
                    <textarea
                      value={bgImportText}
                      onChange={(e) => setBgImportText(e.target.value)}
                      rows={2}
                      spellCheck={false}
                      placeholder="粘贴 JSON 或每行一条：名称 | english background..."
                      className="w-full rounded-[8px] border border-[#E2E3EA] bg-[#FAFAFC] px-2.5 py-1.5 text-[11px] font-mono text-[#1E2028] focus:border-[#7C5CFC] focus:outline-none"
                    />
                    <div className="flex items-center justify-between gap-2 text-[11px]">
                      <span>
                        {bgImportError && (
                          <span className="text-[#E85D75]">{bgImportError}</span>
                        )}
                        {bgImportNotice && (
                          <span className="text-emerald-600">{bgImportNotice}</span>
                        )}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleImportBackgrounds(bgImportText)}
                        className="px-3 py-1 rounded-[10px] bg-gradient-to-b from-[#8A6CFF] to-[#7C5CFC] text-white font-medium cursor-pointer"
                      >
                        导入
                      </button>
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                  {allBackgrounds.map((bg) => {
                    const active =
                      activeBgPreset?.id === bg.id ||
                      currentBgTrimmed === bg.tags.trim();
                    const bgTagPreview = getPromptStats(bg.tags, 3).preview;
                    return (
                      <div
                        key={bg.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => handleSelectBackgroundPreset(bg)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            handleSelectBackgroundPreset(bg);
                          }
                        }}
                        title={`${bg.note}\n${bg.tags}`}
                        className={`group/bg relative rounded-[10px] border px-3 py-2 text-left transition-all cursor-pointer select-none ${
                          active
                            ? bg.isCustom
                              ? 'border-[#E85D75] bg-[#FFF1F3]/85 shadow-[0_2px_8px_rgba(232,93,117,0.12)]'
                              : 'border-[#7C5CFC] bg-[#F4F2FF]/90 shadow-[0_2px_8px_rgba(124,92,252,0.12)]'
                            : 'border-[#EAEAEF] bg-white hover:border-[#D0D3DF] hover:bg-[#FAFAFC]'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-1.5">
                          <div className="flex items-center gap-1.5 min-w-0">
                            {bg.isCustom && (
                              <span className="w-1.5 h-1.5 rounded-full bg-[#E85D75] shrink-0" />
                            )}
                            <span
                              className={`text-[12px] font-semibold truncate ${
                                active
                                  ? bg.isCustom
                                    ? 'text-[#B42343]'
                                    : 'text-[#5B3DF5]'
                                  : 'text-[#1E2028]'
                              }`}
                            >
                              {bg.zhName}
                            </span>
                          </div>

                          <div className="flex items-center gap-1 shrink-0">
                            {active && (
                              <span
                                className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${
                                  bg.isCustom
                                    ? 'bg-[#E85D75] text-white'
                                    : 'bg-[#7C5CFC] text-white'
                                }`}
                              >
                                <Check className="w-2.5 h-2.5" />
                                <span>已选</span>
                              </span>
                            )}
                            {bg.isCustom && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onUpdateCustomBackgrounds(
                                    customBackgrounds.filter((i) => i.id !== bg.id)
                                  );
                                  if (active) {
                                    persistBgSelection(null, null);
                                    onUpdateShared({
                                      ...shared,
                                      selectedBackgroundId: null,
                                      selectedBackgroundName: null,
                                    });
                                  }
                                }}
                                aria-label={`删除 ${bg.zhName}`}
                                className="p-0.5 text-[#949AA8] hover:text-[#E85D75] cursor-pointer"
                              >
                                <X className="w-3 h-3" />
                              </button>
                            )}
                          </div>
                        </div>

                        <p className="mt-0.5 text-[10.5px] text-[#8E94A4] truncate">
                          {bg.note}
                        </p>
                        <p className="mt-1 text-[10.5px] font-mono text-[#5A6072] truncate">
                          {bgTagPreview}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </div>
            }
          />

          <CompactSlotRow
            label="体型"
            text={shared.bodyType?.text ?? ''}
            weight={shared.bodyType?.weight ?? 1.0}
            expanded={openSlot === 'bodyType'}
            onToggleExpand={() => toggleSlot('bodyType')}
            onTextChange={(text) => updatePositiveSlot('bodyType', { text })}
            onWeightChange={(weight) => updatePositiveSlot('bodyType', { weight })}
            emptyHint="已留空（仅当外部工作流已内置体型时清空，避免双重堆叠）"
            placeholder="留空或填入共用体型串..."
            extraExpandedContent={
              <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-[11px]">
                <span className="text-[#8E94A4]">
                  铁律 3：如外部工作流已内置体型，请清空本槽避免双重堆叠
                </span>
                <div className="flex items-center gap-1.5">
                  {(shared.bodyType?.text ?? '').trim() && (
                    <button
                      type="button"
                      onClick={() =>
                        updatePositiveSlot('bodyType', {
                          text: '',
                          weight: 1.0,
                        })
                      }
                      className="px-2.5 py-1 rounded-[10px] border border-[#EAEAEF] bg-white text-[#8E94A4] hover:border-[#E85D75]/40 hover:text-[#E85D75] cursor-pointer whitespace-nowrap transition-colors"
                    >
                      清空
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      updatePositiveSlot('bodyType', {
                        text: SHARED_BODY_TYPE_STRING,
                        weight: 1.0,
                      })
                    }
                    className="px-2.5 py-1 rounded-[10px] border border-[#EAEAEF] bg-white text-[#4C5264] hover:border-[#7C5CFC]/40 hover:text-[#7C5CFC] cursor-pointer whitespace-nowrap transition-colors"
                  >
                    填入文档标准体型串
                  </button>
                </div>
              </div>
            }
          />

          <CompactSlotRow
            label="负向"
            text={compiledNegative}
            hideWeight
            expanded={openSlot === 'negative'}
            onToggleExpand={() => toggleSlot('negative')}
            onTextChange={(text) =>
              onUpdateShared({ ...shared, manualNegativeOverride: text })
            }
            placeholder="共用负向提示词..."
            extraExpandedContent={
              <div className="pt-2 border-t border-[#EAEAEF] space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2 text-[11.5px]">
                  <button
                    type="button"
                    onClick={() => setShowNegGroups((v) => !v)}
                    className="font-medium text-[#7C5CFC] hover:underline cursor-pointer"
                  >
                    {showNegGroups
                      ? '▾ 收起负向分组编辑器'
                      : `▸ 展开 ${shared.negativeGroups.length} 组负向开关与权重管理`}
                  </button>

                  {shared.manualNegativeOverride !== null && (
                    <button
                      type="button"
                      onClick={() =>
                        onUpdateShared({ ...shared, manualNegativeOverride: null })
                      }
                      className="inline-flex items-center gap-1 text-[#E85D75] hover:underline cursor-pointer"
                    >
                      <RotateCcw className="w-3 h-3" />
                      <span>同步分组结果</span>
                    </button>
                  )}
                </div>

                {showNegGroups && (
                  <div className="space-y-2 max-h-[250px] overflow-y-auto pr-1">
                    {shared.negativeGroups.map((group) => (
                      <div
                        key={group.id}
                        className="rounded-[10px] border border-[#EAEAEF] bg-white p-2.5 space-y-2"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <label className="inline-flex items-center gap-2 cursor-pointer text-[12px] font-medium text-[#1E2028]">
                            <input
                              type="checkbox"
                              checked={group.enabled}
                              onChange={() => toggleGroup(group.id)}
                              className="w-3.5 h-3.5 accent-[#7C5CFC] rounded"
                            />
                            <span>{group.name}</span>
                          </label>
                          {group.id === 'anti-outfit-bleed' && (
                            <button
                              type="button"
                              onClick={handleRecommendOutfits}
                              className="inline-flex items-center gap-1 px-2.5 py-0.5 text-[11px] font-medium rounded-[8px] bg-[#F4F2FF] text-[#6B48F5] hover:bg-[#EBE6FF] cursor-pointer"
                            >
                              <Sparkles className="w-3 h-3" />
                              <span>按服装推荐</span>
                            </button>
                          )}
                        </div>

                        <div className="flex flex-wrap gap-1.5">
                          {group.tags.map((tag) => (
                            <div
                              key={tag.id}
                              className="inline-flex items-center gap-1 rounded-[8px] bg-[#F2F3F7] px-2 py-0.5 text-[11px]"
                            >
                              <input
                                type="text"
                                value={tag.text}
                                onChange={(e) =>
                                  updateNegativeTag(group.id, tag.id, {
                                    text: e.target.value,
                                  })
                                }
                                style={{ width: `${Math.max(6, tag.text.length)}ch` }}
                                className="bg-transparent font-mono text-[#373C4B] focus:outline-none min-w-[48px] max-w-[160px]"
                              />
                              <input
                                type="number"
                                min={0.5}
                                max={2.0}
                                step={0.1}
                                value={tag.weight}
                                onChange={(e) => {
                                  const v = parseFloat(e.target.value);
                                  updateNegativeTag(group.id, tag.id, {
                                    weight: Number.isNaN(v) ? 1.0 : v,
                                  });
                                }}
                                className="w-11 bg-white rounded-[6px] border border-[#E2E3EA] px-1 font-mono text-right text-[#6B48F5] tabular-nums focus:outline-none"
                              />
                              <button
                                type="button"
                                onClick={() => deleteNegativeTag(group.id, tag.id)}
                                className="text-[#949AA8] hover:text-[#E85D75] cursor-pointer"
                                aria-label={`删除 ${tag.text}`}
                              >
                                <X className="w-3 h-3" />
                              </button>
                            </div>
                          ))}

                          <div className="inline-flex items-center gap-1">
                            <input
                              type="text"
                              value={newTagInputs[group.id] || ''}
                              onChange={(e) =>
                                setNewTagInputs((prev) => ({
                                  ...prev,
                                  [group.id]: e.target.value,
                                }))
                              }
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  addNegativeTag(group.id);
                                }
                              }}
                              placeholder="+ 标签..."
                              className="w-24 rounded-[8px] border border-dashed border-[#D6D8E2] bg-white px-2 py-0.5 text-[11px] font-mono text-[#1E2028] focus:border-[#7C5CFC] focus:outline-none"
                            />
                            <input
                              type="number"
                              min={0.5}
                              max={2.0}
                              step={0.1}
                              value={newTagWeights[group.id] ?? 1.4}
                              onChange={(e) => {
                                const v = parseFloat(e.target.value);
                                setNewTagWeights((prev) => ({
                                  ...prev,
                                  [group.id]: Number.isNaN(v) ? 1.4 : clampWeight(v),
                                }));
                              }}
                              className="w-11 rounded-[8px] border border-[#E2E3EA] bg-white px-1 py-0.5 text-[11px] font-mono text-right text-[#373C4B] tabular-nums"
                            />
                            <button
                              type="button"
                              onClick={() => addNegativeTag(group.id)}
                              className="px-2 py-0.5 text-[11px] font-medium rounded-[8px] bg-[#F4F2FF] text-[#6B48F5] hover:bg-[#EBE6FF] cursor-pointer"
                            >
                              加
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            }
          />
        </div>
      )}
    </section>
  );
};
