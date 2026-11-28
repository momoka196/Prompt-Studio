import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Copy,
  Download,
  Info,
  Layers,
  Settings,
  ShieldCheck,
  Wrench,
  X,
} from 'lucide-react';
import {
  CHARACTER_FORBIDDEN_FEATURES,
  COMFY_ARCH_DEFAULTS,
  DEFAULT_ANIMA_LORAS,
  DEFAULT_COMFY_PROFILES,
  DEFAULT_COMFY_SEED,
  DEFAULT_STUDIO_CONFIG,
  HAIRSTYLE_PRESETS,
  SHARED_BODY_TYPE_STRING,
} from './data/presets';
import {
  CardApplyToCharacterPayload,
  CharacterConfig,
  ComfyLoaderKey,
  ComfyLoadersConfig,
  ComfyProfile,
  ComfySamplingParams,
  ComfyValidationMap,
  ConflictItem,
  HistorySnapshot,
  SharedConfig,
  StudioConfig,
  WorkflowCollectionCard,
} from './types/studio';
import {
  applyHairstyleToAppearanceText,
  buildCopyAllOutput,
  buildNegativePromptWithMeta,
  buildWorkflowSnippet,
  clampLoraWeight,
  detectConflicts,
  exportComfyProfilePayload,
  fetchComfyNodeOptions,
  getActiveLoaderKeys,
  getCanonicalCharacterId,
  inferYiHairstyleFromAppearance,
  LOADER_NODE_META,
  MAX_COMFY_LORAS,
  parseComfyProfileImport,
  sanitizeFilenamePrefix,
  splitPromptTags,
  stripForbiddenAntiTextureFullText,
  stripLegacyExpressionTokensFromAppearance,
  stripTagFromSlotText,
} from './utils/promptBuilder';
import {
  mergePromptSlotTexts,
  sanitizeSlotTextForTargetCharacter,
} from './utils/workflowLibrary';
import { CharacterSidebar } from './components/CharacterSidebar';
import { CharacterEditorPanel } from './components/CharacterEditorPanel';
import { SharedLayerPanel } from './components/SharedLayerPanel';
import { OutputSidebar } from './components/OutputSidebar';
import { SettingsModal } from './components/SettingsModal';
import { WorkflowCollectionModal } from './components/WorkflowCollectionModal';
import {
  loadUiCache,
  loadWorkflowCards,
  loadWorkflowCardsFromIndexedDbWithState,
  migrateCardInlineImagesToIdb,
  normalizeWorkflowCards,
  patchUiCache,
  saveConfigSafely,
  saveWorkflowCardsSafely,
  saveWorkflowCardsToIndexedDb,
  STUDIO_CONFIG_KEY,
  STUDIO_HISTORY_KEY,
} from './utils/storageCache';

const MAX_HISTORY_ITEMS = 20;

const EMPTY_VALIDATION: ComfyValidationMap = {
  checkpoint: { status: 'unchecked', available: [] },
  unet: { status: 'unchecked', available: [] },
  clip: { status: 'unchecked', available: [] },
  vae: { status: 'unchecked', available: [] },
  loraAvailable: [],
};

function recomputeValidationForLoaders(
  loaders: ComfyLoadersConfig,
  prev: ComfyValidationMap
): ComfyValidationMap {
  const next: ComfyValidationMap = { ...prev };
  const keys: ComfyLoaderKey[] = ['checkpoint', 'unet', 'clip', 'vae'];
  for (const k of keys) {
    const val = (loaders[k] ?? '').trim();
    const cur = prev[k];
    const meta = LOADER_NODE_META[k];
    if (!val) {
      next[k] = {
        ...cur,
        status: cur.available.length > 0 || cur.status === 'invalid' ? 'invalid' : 'unchecked',
        message: `${meta.shortLabel} 未填写`,
      };
    } else if (cur.available.length > 0) {
      if (cur.available.includes(val)) {
        next[k] = { ...cur, status: 'valid', message: undefined };
      } else {
        next[k] = {
          ...cur,
          status: 'invalid',
          message: `${meta.shortLabel} 不存在：${val}`,
        };
      }
    } else if (cur.status === 'valid' || cur.status === 'invalid') {
      next[k] = { ...cur, status: 'unchecked', message: undefined };
    }
  }
  return next;
}

function cloneConfig(cfg: StudioConfig): StudioConfig {
  return JSON.parse(JSON.stringify(cfg)) as StudioConfig;
}

function stripSoloFromText(text: string): string {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && !/^solo$/i.test(s))
    .join(', ');
}

function normalizeProfile(raw: Partial<ComfyProfile>, fallbackIndex = 0): ComfyProfile {
  const arch =
    raw.architecture && COMFY_ARCH_DEFAULTS[raw.architecture]
      ? raw.architecture
      : 'anima';
  const preset = COMFY_ARCH_DEFAULTS[arch];
  return {
    id: raw.id || `profile-${Date.now()}-${fallbackIndex}`,
    name: raw.name?.trim() || `${preset.label} 方案`,
    architecture: arch,
    loaders: {
      ...preset.defaultLoaders,
      ...(raw.loaders ?? {}),
    },
    loras: Array.isArray(raw.loras)
      ? raw.loras.slice(0, MAX_COMFY_LORAS).map((l, idx) => ({
          id: l.id || `lora-${idx}-${Date.now()}`,
          name: l.name ?? '',
          model: clampLoraWeight(typeof l.model === 'number' ? l.model : 1.0, 1.0),
          clip: clampLoraWeight(typeof l.clip === 'number' ? l.clip : 1.0, 1.0),
          condition: l.condition === 'ibuki_only' ? 'ibuki_only' : null,
          enabled: l.enabled !== false,
          triggerWords: typeof l.triggerWords === 'string' ? l.triggerWords : '',
          note: typeof l.note === 'string' ? l.note : '',
        }))
      : DEFAULT_ANIMA_LORAS.map((l) => ({ ...l })),
    sampling: {
      ...preset.defaultSampling,
      ...(raw.sampling ?? {}),
      seedMode: raw.sampling?.seedMode === 'random' ? 'random' : 'fixed',
      seed:
        typeof raw.sampling?.seed === 'number' &&
        Number.isFinite(raw.sampling.seed) &&
        raw.sampling.seed >= 0
          ? Math.floor(raw.sampling.seed)
          : preset.defaultSampling.seed ?? DEFAULT_COMFY_SEED,
    },
    manualSamplingFields: Array.isArray(raw.manualSamplingFields)
      ? raw.manualSamplingFields
      : [],
  };
}

function normalizeStudioConfig(raw: Partial<StudioConfig>): StudioConfig {
  const defaults = cloneConfig(DEFAULT_STUDIO_CONFIG);
  const rawShared = raw.shared ?? defaults.shared;
  const legacySampler = {
    ...defaults.comfySampler!,
    ...(raw.comfySampler ?? {}),
  };

  let comfyProfiles: ComfyProfile[];
  if (Array.isArray(raw.comfyProfiles) && raw.comfyProfiles.length > 0) {
    comfyProfiles = raw.comfyProfiles.map((p, idx) => normalizeProfile(p, idx));
  } else {
    const baseDefault = normalizeProfile(DEFAULT_COMFY_PROFILES[0], 0);
    comfyProfiles = [
      {
        ...baseDefault,
        loaders: {
          ...baseDefault.loaders,
          unet: raw.comfyUnetName || defaults.comfyUnetName,
          clip: raw.comfyClipName || defaults.comfyClipName,
          vae: raw.comfyVaeName || defaults.comfyVaeName,
        },
        loras:
          legacySampler.enableLoraChain === false
            ? []
            : DEFAULT_ANIMA_LORAS.map((l) => ({ ...l })),
        sampling: {
          width: legacySampler.width,
          height: legacySampler.height,
          steps: legacySampler.steps,
          cfg: legacySampler.cfg,
          sampler: legacySampler.samplerName,
          scheduler: legacySampler.scheduler,
          denoise: legacySampler.denoise,
          seedMode: legacySampler.seedMode ?? 'fixed',
          seed: legacySampler.seed ?? DEFAULT_COMFY_SEED,
        },
      },
    ];
  }

  const activeComfyProfileId = comfyProfiles.some(
    (p) => p.id === raw.activeComfyProfileId
  )
    ? raw.activeComfyProfileId!
    : comfyProfiles[0].id;

  let negativeGroups = Array.isArray(rawShared.negativeGroups)
    ? rawShared.negativeGroups.map((g) => ({
        ...g,
        tags: Array.isArray(g.tags) ? [...g.tags] : [],
      }))
    : defaults.shared.negativeGroups;

  if (!negativeGroups.some((g) => g.id === 'anti-blank-bg')) {
    const blankBgGroup = defaults.shared.negativeGroups.find(
      (g) => g.id === 'anti-blank-bg'
    );
    if (blankBgGroup) {
      const colorCastIdx = negativeGroups.findIndex(
        (g) => g.id === 'anti-color-cast'
      );
      if (colorCastIdx >= 0) {
        negativeGroups.splice(colorCastIdx, 0, cloneConfig({ ...defaults, shared: { ...defaults.shared, negativeGroups: [blankBgGroup] } }).shared.negativeGroups[0]);
      } else {
        negativeGroups = [...negativeGroups, blankBgGroup];
      }
    }

    const defaultAntiStiff = defaults.shared.negativeGroups.find(
      (g) => g.id === 'anti-stiff'
    );
    if (defaultAntiStiff) {
      negativeGroups = negativeGroups.map((g) => {
        if (g.id !== 'anti-stiff') return g;
        const existingTexts = new Set(
          g.tags.map((t) => t.text.trim().toLowerCase())
        );
        const missingTags = defaultAntiStiff.tags.filter(
          (t) => !existingTexts.has(t.text.trim().toLowerCase())
        );
        return missingTags.length > 0
          ? { ...g, tags: [...g.tags, ...missingTags] }
          : g;
      });
    }
  }

  const legacyDefaultBg =
    'simple background, pale cool sky blue background, clean studio backdrop, subtle floor shadow';
  const normalizedBackground =
    rawShared.background?.text?.trim() === legacyDefaultBg
      ? { ...defaults.shared.background }
      : rawShared.background ?? defaults.shared.background;

  const needsAppearanceClean = (raw.appearanceCleanedVersion ?? 0) < 1;
  const needsYiSideBowMigration = (raw.appearanceCleanedVersion ?? 0) < 2;
  const needsBodyTypeInit = (raw.bodyTypeInitializedVersion ?? 0) < 1;
  const rawBodyTypeText = rawShared.bodyType?.text ?? '';
  const normalizedBodyType =
    needsBodyTypeInit && !rawBodyTypeText.trim()
      ? { text: SHARED_BODY_TYPE_STRING, weight: rawShared.bodyType?.weight ?? 1.0 }
      : rawShared.bodyType ?? { text: SHARED_BODY_TYPE_STRING, weight: 1.0 };

  return {
    appearanceCleanedVersion: 2,
    bodyTypeInitializedVersion: 1,
    comfyUrl: raw.comfyUrl || defaults.comfyUrl,
    comfyUnetName: raw.comfyUnetName || defaults.comfyUnetName,
    comfyClipName: raw.comfyClipName || defaults.comfyClipName,
    comfyVaeName: raw.comfyVaeName || defaults.comfyVaeName,
    comfySampler: legacySampler,
    comfyProfiles,
    activeComfyProfileId,
    shared: {
      ...defaults.shared,
      ...rawShared,
      background: normalizedBackground,
      negativeGroups,
      bodyType: normalizedBodyType,
    },
    characters:
      Array.isArray(raw.characters) && raw.characters.length > 0
        ? raw.characters.map((c) => {
            const canonicalId = c.templateId?.trim() || c.id;
            const defaultChar = defaults.characters.find((dc) => dc.id === canonicalId);
            const rawAppearanceText = c.appearance?.text ?? '';
            let cleanedAppearanceText = needsAppearanceClean
              ? stripLegacyExpressionTokensFromAppearance(canonicalId, rawAppearanceText)
              : rawAppearanceText;
            const inferredHairId =
              canonicalId === 'char-yi'
                ? inferYiHairstyleFromAppearance(cleanedAppearanceText)?.id ??
                  defaultChar?.hairstyleId ??
                  'hair-side-ponytail'
                : defaultChar?.hairstyleId ?? null;
            const resolvedHairstyleId =
              c.hairstyleId !== undefined ? c.hairstyleId : inferredHairId;
            const resolvedAccessoryId =
              c.hairAccessoryId !== undefined
                ? c.hairAccessoryId
                : defaultChar?.hairAccessoryId ?? null;
            if (
              needsYiSideBowMigration &&
              canonicalId === 'char-yi' &&
              resolvedHairstyleId === 'hair-side-ponytail' &&
              (!resolvedAccessoryId || resolvedAccessoryId === 'acc-preset-bow') &&
              /\bblack(?:\s+hair)?\s+bow\b/i.test(cleanedAppearanceText)
            ) {
              cleanedAppearanceText = applyHairstyleToAppearanceText(
                cleanedAppearanceText,
                HAIRSTYLE_PRESETS[0].tags,
                { accessoryId: resolvedAccessoryId ?? 'acc-preset-bow' }
              );
            }
            return {
              ...c,
              templateId: c.templateId,
              appearance: {
                text: cleanedAppearanceText,
                weight: c.appearance?.weight ?? 1.0,
              },
              hairstyleId: resolvedHairstyleId,
              hairBangsId:
                c.hairBangsId !== undefined
                  ? c.hairBangsId
                  : defaultChar?.hairBangsId ?? null,
              hairAccessoryId: resolvedAccessoryId,
              enableFourthLora: Boolean(c.enableFourthLora),
              forbiddenTags: c.forbiddenTags ?? '',
            };
          })
        : defaults.characters,
    customBackgrounds: Array.isArray(raw.customBackgrounds)
      ? raw.customBackgrounds
          .filter(
            (bg) =>
              bg &&
              typeof bg === 'object' &&
              typeof bg.zhName === 'string' &&
              typeof bg.tags === 'string' &&
              bg.zhName.trim().length > 0 &&
              bg.tags.trim().length > 0
          )
          .map((bg, idx) => ({
            id: bg.id || `custom-bg-${Date.now()}-${idx}`,
            zhName: bg.zhName.trim(),
            note: typeof bg.note === 'string' ? bg.note.trim() : '',
            tags: bg.tags.trim(),
            isCustom: true,
          }))
      : [],
    customPresets: Array.isArray(raw.customPresets) ? raw.customPresets : [],
    customLoras: Array.isArray(raw.customLoras)
      ? raw.customLoras
          .filter(
            (l) =>
              l &&
              typeof l === 'object' &&
              typeof l.name === 'string' &&
              l.name.trim().length > 0
          )
          .slice(0, MAX_COMFY_LORAS * 2)
          .map((l, idx) => ({
            id: l.id || `custom-lora-${idx}-${Date.now()}`,
            name: l.name.trim(),
            model: clampLoraWeight(typeof l.model === 'number' ? l.model : 1.0, 1.0),
            clip: clampLoraWeight(typeof l.clip === 'number' ? l.clip : 1.0, 1.0),
            condition: null,
            enabled: l.enabled !== false,
            triggerWords: typeof l.triggerWords === 'string' ? l.triggerWords : '',
            note: typeof l.note === 'string' ? l.note : '',
          }))
      : [],
  };
}

export default function App() {
  const [config, setConfig] = useState<StudioConfig>(() => {
    try {
      const raw = localStorage.getItem(STUDIO_CONFIG_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<StudioConfig>;
        if (
          parsed &&
          parsed.shared &&
          Array.isArray(parsed.characters) &&
          parsed.characters.length > 0
        ) {
          return normalizeStudioConfig(parsed);
        }
      }
    } catch {
      // 忽略存储读取失败
    }
    return cloneConfig(DEFAULT_STUDIO_CONFIG);
  });

  const [selectedCharId, setSelectedCharIdState] = useState<string>(() => {
    const cached = loadUiCache().selectedCharId;
    if (config.characters.some((c) => c.id === cached)) return cached;
    return config.characters[0]?.id ?? 'char-lan';
  });

  const setSelectedCharId = useCallback((id: string) => {
    setSelectedCharIdState(id);
    patchUiCache({ selectedCharId: id });
  }, []);

  const [history, setHistory] = useState<HistorySnapshot[]>(() => {
    try {
      const raw = localStorage.getItem(STUDIO_HISTORY_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as HistorySnapshot[];
        if (Array.isArray(parsed)) return parsed.slice(0, MAX_HISTORY_ITEMS);
      }
    } catch {
      // 忽略存储读取失败
    }
    return [];
  });

  const [includeAppearance, setIncludeAppearanceState] = useState<boolean>(
    () => loadUiCache().includeAppearance
  );
  const [copiedAll, setCopiedAll] = useState(false);
  const [copiedSnippet, setCopiedSnippet] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [workbenchOpen, setWorkbenchOpen] = useState(false);
  const [workflowCards, setWorkflowCards] = useState<WorkflowCollectionCard[]>(() =>
    loadWorkflowCards()
  );
  const [conflictsExpanded, setConflictsExpanded] = useState(false);
  const [guardHelpOpen, setGuardHelpOpen] = useState(false);
  const [validation, setValidation] = useState<ComfyValidationMap>(EMPTY_VALIDATION);
  const [probingLoaders, setProbingLoaders] = useState(false);
  const [applyCardToast, setApplyCardToast] = useState<string | null>(null);
  const applyCardToastTimerRef = useRef<number | null>(null);
  const lastAutoSnapshotRef = useRef<string>(JSON.stringify(config));
  const cardsMutatedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const idbState = await loadWorkflowCardsFromIndexedDbWithState();
      if (cancelled || cardsMutatedRef.current) return;
      if (idbState.exists) {
        setWorkflowCards(idbState.cards);
      } else {
        const legacyLocal = loadWorkflowCards();
        if (legacyLocal.length > 0) {
          const { cards: migratedCards, migrated } =
            await migrateCardInlineImagesToIdb(legacyLocal);
          if (cancelled || cardsMutatedRef.current) return;
          if (migrated) {
            setWorkflowCards(migratedCards);
          }
          void saveWorkflowCardsToIndexedDb(migratedCards);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleChangeWorkflowCards = useCallback(
    (next: WorkflowCollectionCard[]): { ok: boolean; error?: string } => {
      cardsMutatedRef.current = true;
      const saveRes = saveWorkflowCardsSafely(next);
      if (saveRes.ok) {
        setWorkflowCards(next);
      }
      return saveRes;
    },
    []
  );

  const handleCloseWorkbench = useCallback(() => {
    setWorkbenchOpen(false);
  }, []);

  const handleOpenSettingsFromWorkbench = useCallback(() => {
    setWorkbenchOpen(false);
    setSettingsOpen(true);
  }, []);

  const knownCharacterHints = useMemo(
    () => config.characters.map((c) => c.name),
    [config.characters]
  );

  const comfyProfiles = useMemo(
    () =>
      config.comfyProfiles && config.comfyProfiles.length > 0
        ? config.comfyProfiles
        : DEFAULT_COMFY_PROFILES,
    [config.comfyProfiles]
  );

  const activeProfile = useMemo(
    () =>
      comfyProfiles.find((p) => p.id === config.activeComfyProfileId) ??
      comfyProfiles[0],
    [comfyProfiles, config.activeComfyProfileId]
  );

  const updateConfig = useCallback(
    (updater: StudioConfig | ((prev: StudioConfig) => StudioConfig)) => {
      setConfig((prev) => {
        const next =
          typeof updater === 'function'
            ? (updater as (p: StudioConfig) => StudioConfig)(prev)
            : updater;
        saveConfigSafely(next);
        return next;
      });
    },
    []
  );

  useEffect(() => {
    saveConfigSafely(config);
  }, [config]);

  useEffect(() => {
    setValidation((prev) => recomputeValidationForLoaders(activeProfile.loaders, prev));
  }, [activeProfile.id, activeProfile.loaders]);

  const probeComfyLoaders = useCallback(
    async (keysOverride?: ComfyLoaderKey[], urlOverride?: string) => {
      const targetUrl = (urlOverride ?? config.comfyUrl).trim();
      const targetKeys =
        keysOverride && keysOverride.length > 0
          ? keysOverride
          : getActiveLoaderKeys(activeProfile);

      if (!targetUrl || targetKeys.length === 0) return;

      setProbingLoaders(true);
      setValidation((prev) => {
        const next = { ...prev };
        targetKeys.forEach((k) => {
          next[k] = { ...prev[k], status: 'checking', message: undefined };
        });
        return next;
      });

      const results = await Promise.allSettled(
        targetKeys.map(async (key) => {
          const meta = LOADER_NODE_META[key];
          const options = await fetchComfyNodeOptions(
            targetUrl,
            meta.nodeType,
            meta.inputKey
          );
          return { key, options };
        })
      );

      let fetchedLoras: string[] | null = null;
      try {
        fetchedLoras = await fetchComfyNodeOptions(targetUrl, 'LoraLoader', 'lora_name');
      } catch {
        fetchedLoras = null;
      }

      setValidation((prev) => {
        const next: ComfyValidationMap = {
          ...prev,
          loraAvailable: fetchedLoras ?? prev.loraAvailable,
        };
        results.forEach((res, idx) => {
          const key = targetKeys[idx];
          const meta = LOADER_NODE_META[key];
          const currentVal = (activeProfile.loaders[key] ?? '').trim();
          if (res.status === 'fulfilled') {
            const avail = res.value.options;
            if (!currentVal) {
              next[key] = {
                status: 'invalid',
                available: avail,
                message: `${meta.shortLabel} 未填写`,
              };
            } else if (avail.length > 0 && avail.includes(currentVal)) {
              next[key] = {
                status: 'valid',
                available: avail,
                message: undefined,
              };
            } else {
              next[key] = {
                status: 'invalid',
                available: avail,
                message:
                  avail.length === 0
                    ? `${meta.shortLabel} 列表为空，未找到 ${currentVal}`
                    : `${meta.shortLabel} 不存在：${currentVal}`,
              };
            }
          } else {
            next[key] = {
              ...prev[key],
              status: 'error',
              message:
                res.reason instanceof Error
                  ? res.reason.message
                  : `无法读取 ${meta.nodeType}`,
            };
          }
        });
        return next;
      });

      setProbingLoaders(false);
    },
    [config.comfyUrl, activeProfile]
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void probeComfyLoaders();
    }, 350);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.comfyUrl, activeProfile.id, activeProfile.architecture]);

  useEffect(() => {
    try {
      localStorage.setItem(STUDIO_HISTORY_KEY, JSON.stringify(history));
    } catch {
      // 忽略存储写入失败
    }
  }, [history]);

  const pushHistory = useCallback((label: string, targetConfig: StudioConfig) => {
    const serialized = JSON.stringify(targetConfig);
    if (serialized === lastAutoSnapshotRef.current && !label.startsWith('手动')) {
      return;
    }
    lastAutoSnapshotRef.current = serialized;
    const snap: HistorySnapshot = {
      id: `hist-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      createdAt: Date.now(),
      label,
      config: cloneConfig(targetConfig),
    };
    setHistory((prev) => [snap, ...prev].slice(0, MAX_HISTORY_ITEMS));
  }, []);

  const handleApplyWorkflowCardToCharacter = useCallback(
    (payload: CardApplyToCharacterPayload): { ok: boolean; error?: string } => {
      const targetChar = config.characters.find(
        (c) => c.id === payload.targetCharacterId
      );
      if (!targetChar) {
        return { ok: false, error: '未找到目标角色，请重新选择' };
      }

      const shouldCreateNew =
        payload.createNewCharacter !== false && !payload.runDirectly;
      const shouldProtectOriginalInRun =
        Boolean(payload.runDirectly) &&
        payload.createNewCharacter !== false &&
        !payload.persistToCharacter;

      pushHistory(
        shouldCreateNew
          ? `基于「${targetChar.name}」新建复刻角色「${payload.cardTitle}」前`
          : `${payload.persistToCharacter ? '永久' : ''}套用卡片「${payload.cardTitle}」到「${targetChar.name}」前`,
        config
      );

      const cleanPosSlot = (raw: string): string =>
        sanitizeSlotTextForTargetCharacter(raw, targetChar, {
          knownCharacterHints,
        });

      const cleanSafeNegative = (raw: string): string => {
        const strippedAntiTex = stripForbiddenAntiTextureFullText(raw).cleanedText;
        const forbiddenMatchers = CHARACTER_FORBIDDEN_FEATURES.map((feat) => {
          const escaped = feat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          return new RegExp(`\\b${escaped}\\b`, 'i');
        });
        return splitPromptTags(strippedAntiTex)
          .filter((token) => !forbiddenMatchers.some((re) => re.test(token)))
          .join(', ');
      };

      let nextCharacters = config.characters;
      let resultCharId = payload.targetCharacterId;
      let resultCharName = targetChar.name;

      if (shouldCreateNew) {
        const newCharId = `char-replica-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
        const shortBaseName = targetChar.name.replace(/\s*\([^)]*\)\s*/g, '').trim() || targetChar.name;
        const shortCardTitle = (payload.cardTitle || '复刻图').trim().slice(0, 18);
        const baseReplicaName = `${shortBaseName} · ${shortCardTitle}`;
        const existingNames = new Set(config.characters.map((c) => c.name));
        let uniqueName = baseReplicaName;
        let suffix = 2;
        while (existingNames.has(uniqueName)) {
          uniqueName = `${baseReplicaName} #${suffix}`;
          suffix += 1;
        }

        // 全新角色严格锁定所选角色卡的身份外貌/发型/第4层LoRA/禁用词，
        // 绝不填回原角色的可爱预设服装/动作/表情，避免覆盖或污染原图提示词
        const newChar: CharacterConfig = {
          id: newCharId,
          templateId: getCanonicalCharacterId(targetChar),
          name: uniqueName,
          hairstyleId: targetChar.hairstyleId ?? null,
          hairBangsId: targetChar.hairBangsId ?? null,
          hairAccessoryId: targetChar.hairAccessoryId ?? null,
          appearance: { ...targetChar.appearance },
          outfit: {
            text:
              payload.applyOutfit && payload.outfitText.trim()
                ? cleanPosSlot(payload.outfitText)
                : '',
            weight: 1.0,
          },
          pose: {
            text:
              payload.applyPose && payload.poseText.trim()
                ? cleanPosSlot(payload.poseText)
                : '',
            weight: 1.0,
          },
          expression: {
            text:
              payload.applyExpression && payload.expressionText.trim()
                ? cleanPosSlot(payload.expressionText)
                : '',
            weight: 1.0,
          },
          enableFourthLora: Boolean(targetChar.enableFourthLora),
          forbiddenTags: targetChar.forbiddenTags ?? '',
        };

        nextCharacters = [...config.characters, newChar];
        resultCharId = newCharId;
        resultCharName = uniqueName;

        const cache = loadUiCache();
        const nextPresetMap = { ...cache.selectedPresetByChar, [newCharId]: {} };
        patchUiCache({ selectedPresetByChar: nextPresetMap });
      } else if (!shouldProtectOriginalInRun) {
        nextCharacters = config.characters.map((ch) => {
          if (ch.id !== payload.targetCharacterId) return ch;
          const nextOutfitText =
            payload.applyOutfit && payload.outfitText.trim()
              ? mergePromptSlotTexts(
                  ch.outfit.text,
                  cleanPosSlot(payload.outfitText),
                  payload.outfitMode
                )
              : ch.outfit.text;
          const nextPoseText =
            payload.applyPose && payload.poseText.trim()
              ? mergePromptSlotTexts(
                  ch.pose.text,
                  cleanPosSlot(payload.poseText),
                  payload.poseMode
                )
              : ch.pose.text;
          const nextExprText = payload.applyExpression
            ? payload.expressionMode === 'replace'
              ? cleanPosSlot(payload.expressionText)
              : payload.expressionText.trim()
              ? mergePromptSlotTexts(
                  ch.expression.text,
                  cleanPosSlot(payload.expressionText),
                  'append'
                )
              : ch.expression.text
            : ch.expression.text;

          // 严格锁定目标角色的身份外貌、发型、发饰与第4层LoRA开关，不被收藏卡覆盖
          return {
            ...ch,
            outfit: { ...ch.outfit, text: nextOutfitText },
            pose: { ...ch.pose, text: nextPoseText },
            expression: { ...ch.expression, text: nextExprText },
          };
        });
      }

      if (!payload.runDirectly) {
        setSelectedCharId(resultCharId);
      }

      let nextShared = config.shared;
      if (payload.applyBackground && payload.backgroundText.trim()) {
        const nextBgText = mergePromptSlotTexts(
          nextShared.background.text,
          cleanPosSlot(payload.backgroundText),
          payload.backgroundMode
        );
        const nextBgName =
          payload.backgroundMode === 'append' && nextShared.selectedBackgroundName?.trim()
            ? `${nextShared.selectedBackgroundName.trim()} + 来自收藏卡 · ${payload.cardTitle}`
            : `来自收藏卡 · ${payload.cardTitle}`;
        nextShared = {
          ...nextShared,
          background: { ...nextShared.background, text: nextBgText },
          selectedBackgroundId: null,
          selectedBackgroundName: nextBgName,
        };
        patchUiCache({
          selectedBackgroundId: null,
          selectedBackgroundName: nextBgName,
        });
      }

      if (payload.applyNegative && payload.negativeText.trim()) {
        const safeNeg = cleanSafeNegative(payload.negativeText);
        if (safeNeg) {
          if (payload.negativeMode === 'replace-override') {
            nextShared = {
              ...nextShared,
              manualNegativeOverride: safeNeg,
            };
          } else if (nextShared.manualNegativeOverride !== null) {
            nextShared = {
              ...nextShared,
              manualNegativeOverride: mergePromptSlotTexts(
                nextShared.manualNegativeOverride,
                safeNeg,
                'append'
              ),
            };
          } else {
            const incomingTags = splitPromptTags(safeNeg);
            const existingAll = new Set(
              nextShared.negativeGroups.flatMap((g) =>
                g.tags.map((t) => t.text.trim().toLowerCase())
              )
            );
            const toAppend = incomingTags.filter(
              (tag) => !existingAll.has(tag.trim().toLowerCase())
            );
            if (toAppend.length > 0) {
              const targetGroupExists = nextShared.negativeGroups.some(
                (g) => g.id === 'general-quality'
              );
              nextShared = {
                ...nextShared,
                negativeGroups: nextShared.negativeGroups.map((g, idx) => {
                  const isTarget = targetGroupExists
                    ? g.id === 'general-quality'
                    : idx === nextShared.negativeGroups.length - 1;
                  if (!isTarget) return g;
                  return {
                    ...g,
                    enabled: true,
                    tags: [
                      ...g.tags,
                      ...toAppend.map((text, tIdx) => ({
                        id: `card-neg-${Date.now()}-${tIdx}`,
                        text,
                        weight: 1.0,
                      })),
                    ],
                  };
                }),
              };
            }
          }
        }
      }

      let nextProfiles = config.comfyProfiles;
      if (payload.applySamplingParams && payload.samplingParams) {
        const sp = payload.samplingParams;
        const baseList =
          config.comfyProfiles && config.comfyProfiles.length > 0
            ? config.comfyProfiles
            : DEFAULT_COMFY_PROFILES;
        const activeId = config.activeComfyProfileId ?? baseList[0].id;
        nextProfiles = baseList.map((profile) => {
          if (profile.id !== activeId) return profile;
          const manualSet = new Set<keyof ComfySamplingParams>(
            profile.manualSamplingFields ?? []
          );
          const nextSampling: ComfySamplingParams = { ...profile.sampling };
          if (typeof sp.width === 'number' && sp.width >= 64) {
            nextSampling.width = sp.width;
            manualSet.add('width');
          }
          if (typeof sp.height === 'number' && sp.height >= 64) {
            nextSampling.height = sp.height;
            manualSet.add('height');
          }
          if (typeof sp.steps === 'number' && sp.steps >= 1) {
            nextSampling.steps = sp.steps;
            manualSet.add('steps');
          }
          if (typeof sp.cfg === 'number' && sp.cfg > 0) {
            nextSampling.cfg = sp.cfg;
            manualSet.add('cfg');
          }
          if (typeof sp.sampler === 'string' && sp.sampler.trim()) {
            nextSampling.sampler = sp.sampler.trim();
            manualSet.add('sampler');
          }
          if (typeof sp.scheduler === 'string' && sp.scheduler.trim()) {
            nextSampling.scheduler = sp.scheduler.trim();
            manualSet.add('scheduler');
          }
          if (typeof sp.denoise === 'number' && sp.denoise > 0 && sp.denoise <= 1) {
            nextSampling.denoise = sp.denoise;
            manualSet.add('denoise');
          }
          // 若当前模型方案开启了「每次随机 Seed」，保留随机策略不被覆盖
          if (
            (profile.sampling.seedMode ?? 'fixed') !== 'random' &&
            typeof sp.seed === 'number' &&
            sp.seed >= 0
          ) {
            nextSampling.seedMode = 'fixed';
            nextSampling.seed = sp.seed;
            manualSet.add('seedMode');
            manualSet.add('seed');
          }
          return {
            ...profile,
            sampling: nextSampling,
            manualSamplingFields: Array.from(manualSet),
          };
        });
      }

      if (payload.syncLorasToProfile && Array.isArray(payload.lorasOverride)) {
        const baseList =
          nextProfiles && nextProfiles.length > 0
            ? nextProfiles
            : config.comfyProfiles && config.comfyProfiles.length > 0
            ? config.comfyProfiles
            : DEFAULT_COMFY_PROFILES;
        const activeId = config.activeComfyProfileId ?? baseList[0].id;
        nextProfiles = baseList.map((profile) => {
          if (profile.id !== activeId) return profile;
          return {
            ...profile,
            loras: payload.lorasOverride!.slice(0, MAX_COMFY_LORAS).map((l, idx) => ({
              id: l.id || `lora-sync-${Date.now()}-${idx}`,
              name: l.name.trim(),
              model: clampLoraWeight(l.model, 1.0),
              clip: clampLoraWeight(l.clip, 1.0),
              condition: l.condition === 'ibuki_only' ? 'ibuki_only' : null,
              enabled: l.enabled !== false,
              triggerWords: typeof l.triggerWords === 'string' ? l.triggerWords : '',
              note: typeof l.note === 'string' ? l.note : '',
            })),
          };
        });
      }

      updateConfig((prev) => ({
        ...prev,
        shared: nextShared,
        characters: nextCharacters,
        comfyProfiles: nextProfiles,
      }));

      // 拉取返回后立即执行提示词冲突判断
      const detectedAfterApply = detectConflicts(nextShared, nextCharacters, {
        includeAppearance: true,
        customPresets: config.customPresets ?? [],
        customBackgrounds: config.customBackgrounds ?? [],
      });
      const relevantConflicts = detectedAfterApply.filter(
        (c) => !c.characterId || c.characterId === resultCharId
      );

      if (payload.switchAndClose && !payload.runDirectly) {
        setWorkbenchOpen(false);
        if (relevantConflicts.length > 0) {
          setConflictsExpanded(true);
        }
        if (applyCardToastTimerRef.current !== null) {
          window.clearTimeout(applyCardToastTimerRef.current);
        }
        const prefixText = shouldCreateNew
          ? `已创建全新角色「${resultCharName}」并带入收藏图「${payload.cardTitle}」`
          : `已切换至「${resultCharName}」并同步收藏图「${payload.cardTitle}」`;
        const conflictSuffix =
          relevantConflicts.length > 0
            ? `；检测到 ${relevantConflicts.length} 处提示词冲突，已在上方展开`
            : '（未填充可爱预设，提示词冲突检查通过）';
        setApplyCardToast(`${prefixText}${conflictSuffix}`);
        applyCardToastTimerRef.current = window.setTimeout(() => {
          setApplyCardToast(null);
          applyCardToastTimerRef.current = null;
        }, 5000);
      }

      return { ok: true };
    },
    [config, knownCharacterHints, pushHistory, setSelectedCharId, updateConfig]
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const serialized = JSON.stringify(config);
      if (serialized !== lastAutoSnapshotRef.current) {
        pushHistory('自动保存编辑状态', config);
      }
    }, 2500);
    return () => window.clearTimeout(timer);
  }, [config, pushHistory]);

  const activeCharacter = useMemo(
    () =>
      config.characters.find((c) => c.id === selectedCharId) ??
      config.characters[0],
    [config.characters, selectedCharId]
  );

  const conflicts = useMemo(
    () =>
      detectConflicts(config.shared, config.characters, {
        includeAppearance: true,
        customPresets: config.customPresets ?? [],
        customBackgrounds: config.customBackgrounds ?? [],
      }),
    [config.shared, config.characters, config.customPresets, config.customBackgrounds]
  );

  const activeGuardAnalysis = useMemo(
    () =>
      activeCharacter
        ? buildNegativePromptWithMeta(config.shared, activeCharacter, {
            includeAppearance,
            customPresets: config.customPresets ?? [],
            customBackgrounds: config.customBackgrounds ?? [],
          }).guardMeta
        : null,
    [
      config.shared,
      activeCharacter,
      includeAppearance,
      config.customPresets,
      config.customBackgrounds,
    ]
  );

  const handleAddCharacter = () => {
    pushHistory('新增角色前', config);
    const nextIndex = config.characters.length + 1;
    const newChar: CharacterConfig = {
      id: `char-${Date.now()}`,
      name: `角色 ${nextIndex}`,
      hairstyleId: null,
      hairBangsId: null,
      hairAccessoryId: null,
      appearance: { text: '', weight: 1.0 },
      outfit: { text: '', weight: 1.4 },
      pose: { text: '', weight: 1.4 },
      expression: { text: '', weight: 1.4 },
      enableFourthLora: false,
      forbiddenTags: '',
    };
    updateConfig((prev) => ({
      ...prev,
      characters: [...prev.characters, newChar],
    }));
    setSelectedCharId(newChar.id);
  };

  const handleDeleteCharacter = (id: string) => {
    if (config.characters.length <= 1) return;
    const target = config.characters.find((c) => c.id === id);
    pushHistory(`删除「${target?.name ?? '角色'}」前`, config);
    const remaining = config.characters.filter((c) => c.id !== id);
    updateConfig((prev) => ({
      ...prev,
      characters: remaining,
    }));
    if (selectedCharId === id && remaining[0]) {
      setSelectedCharId(remaining[0].id);
    }
  };

  const handleRenameCharacter = (id: string, newName: string) => {
    updateConfig((prev) => ({
      ...prev,
      characters: prev.characters.map((c) =>
        c.id === id ? { ...c, name: newName } : c
      ),
    }));
  };

  const handleMoveCharacter = (id: string, direction: 'up' | 'down') => {
    const idx = config.characters.findIndex((c) => c.id === id);
    if (idx < 0) return;
    const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= config.characters.length) return;
    const nextChars = [...config.characters];
    const [moved] = nextChars.splice(idx, 1);
    nextChars.splice(targetIdx, 0, moved);
    updateConfig((prev) => ({ ...prev, characters: nextChars }));
  };

  const handleUpdateCharacter = (updated: CharacterConfig) => {
    updateConfig((prev) => ({
      ...prev,
      characters: prev.characters.map((c) =>
        c.id === updated.id ? updated : c
      ),
    }));
  };

  const handleUpdateShared = (updatedShared: SharedConfig) => {
    updateConfig((prev) => ({
      ...prev,
      shared: updatedShared,
    }));
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
  };

  const handleCopyAll = async () => {
    const text = buildCopyAllOutput(config.shared, config.characters, {
      includeAppearance,
      customPresets: config.customPresets ?? [],
      customBackgrounds: config.customBackgrounds ?? [],
      activeProfile,
    });
    await copyToClipboard(text);
    setCopiedAll(true);
    window.setTimeout(() => setCopiedAll(false), 1800);
  };

  const handleCopyWorkflowSnippet = async () => {
    const targetChar = activeCharacter ?? config.characters[0];
    if (!targetChar) return;
    const text = buildWorkflowSnippet(config.shared, targetChar, {
      includeAppearance,
      customPresets: config.customPresets ?? [],
      customBackgrounds: config.customBackgrounds ?? [],
      activeProfile,
    });
    await copyToClipboard(text);
    setCopiedSnippet(true);
    window.setTimeout(() => setCopiedSnippet(false), 1800);
  };

  const handleFixConflict = (conflict: ConflictItem) => {
    pushHistory('一键修复冲突前', config);

    if (conflict.fixType === 'remove-solo') {
      updateConfig((prev) => ({
        ...prev,
        shared: {
          ...prev.shared,
          styleAnchor: {
            ...prev.shared.styleAnchor,
            text: stripSoloFromText(prev.shared.styleAnchor.text),
          },
          background: {
            ...prev.shared.background,
            text: stripSoloFromText(prev.shared.background.text),
          },
          composition: {
            ...prev.shared.composition,
            text: stripSoloFromText(prev.shared.composition.text),
          },
        },
        characters: prev.characters.map((c) => ({
          ...c,
          appearance: { ...c.appearance, text: stripSoloFromText(c.appearance.text) },
          outfit: { ...c.outfit, text: stripSoloFromText(c.outfit.text) },
          pose: { ...c.pose, text: stripSoloFromText(c.pose.text) },
          expression: { ...c.expression, text: stripSoloFromText(c.expression.text) },
        })),
      }));
      return;
    }

    if (conflict.fixType === 'remove-negative-tag' && conflict.targetTag) {
      const targetLower = conflict.targetTag.toLowerCase();
      updateConfig((prev) => ({
        ...prev,
        shared: {
          ...prev.shared,
          manualNegativeOverride:
            prev.shared.manualNegativeOverride !== null
              ? prev.shared.manualNegativeOverride
                  .split(',')
                  .map((s) => s.trim())
                  .filter((s) => !s.toLowerCase().includes(targetLower))
                  .join(', ')
              : null,
          negativeGroups: prev.shared.negativeGroups.map((g) => ({
            ...g,
            tags: g.tags.filter(
              (t) => t.text.trim().toLowerCase() !== targetLower
            ),
          })),
        },
      }));
      return;
    }

    if (
      conflict.fixType === 'remove-forbidden-tag' &&
      conflict.targetTag &&
      conflict.characterId
    ) {
      const targetLower = conflict.targetTag.toLowerCase();
      updateConfig((prev) => ({
        ...prev,
        characters: prev.characters.map((c) =>
          c.id === conflict.characterId
            ? {
                ...c,
                forbiddenTags: (c.forbiddenTags ?? '')
                  .split(/[,，]+/)
                  .map((s) => s.trim())
                  .filter((s) => s && s.toLowerCase() !== targetLower)
                  .join(', '),
              }
            : c
        ),
      }));
      return;
    }

    if (
      conflict.fixType === 'remove-character-tag' &&
      conflict.targetTag &&
      conflict.characterId
    ) {
      const targetTag = conflict.targetTag;
      const targetSlot = conflict.slot;
      updateConfig((prev) => ({
        ...prev,
        characters: prev.characters.map((c) => {
          if (c.id !== conflict.characterId) return c;
          const patchSlot = (
            slotKey: 'outfit' | 'pose' | 'expression'
          ) =>
            !targetSlot || targetSlot === slotKey
              ? { ...c[slotKey], text: stripTagFromSlotText(c[slotKey].text, targetTag) }
              : c[slotKey];
          return {
            ...c,
            outfit: patchSlot('outfit'),
            pose: patchSlot('pose'),
            expression: patchSlot('expression'),
          };
        }),
      }));
      return;
    }

    if (conflict.fixType === 'remove-shared-tag' && conflict.targetTag) {
      const targetTag = conflict.targetTag;
      const targetSlot = conflict.slot;
      updateConfig((prev) => ({
        ...prev,
        shared: {
          ...prev.shared,
          styleAnchor:
            !targetSlot || targetSlot === 'styleAnchor'
              ? {
                  ...prev.shared.styleAnchor,
                  text: stripTagFromSlotText(prev.shared.styleAnchor.text, targetTag),
                }
              : prev.shared.styleAnchor,
          background:
            !targetSlot || targetSlot === 'background'
              ? {
                  ...prev.shared.background,
                  text: stripTagFromSlotText(prev.shared.background.text, targetTag),
                }
              : prev.shared.background,
          composition:
            !targetSlot || targetSlot === 'composition'
              ? {
                  ...prev.shared.composition,
                  text: stripTagFromSlotText(prev.shared.composition.text, targetTag),
                }
              : prev.shared.composition,
        },
      }));
    }
  };

  const handleExportConfig = () => {
    const publicWorkflowCards = workflowCards.filter((c) => !c.isPrivate);
    const exportPayload =
      publicWorkflowCards.length > 0
        ? { ...config, workflowCards: publicWorkflowCards }
        : config;
    const blob = new Blob([JSON.stringify(exportPayload, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'chibiprompt-config.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleImportConfig = (file: File) => {
    setImportError(null);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as StudioConfig & {
          workflowCards?: unknown;
        };
        if (
          !parsed ||
          !parsed.shared ||
          !Array.isArray(parsed.characters) ||
          parsed.characters.length === 0
        ) {
          setImportError('导入失败：JSON 格式不符合 chibiprompt-config.json 结构');
          return;
        }
        pushHistory('导入配置前', config);
        const normalized = normalizeStudioConfig(parsed);
        if (Array.isArray(parsed.workflowCards)) {
          const importedCards = normalizeWorkflowCards(parsed.workflowCards);
          const importedIds = new Set(importedCards.map((c) => c.id));
          const preservedPrivate = workflowCards.filter(
            (c) => Boolean(c.isPrivate) && !importedIds.has(c.id)
          );
          handleChangeWorkflowCards([...importedCards, ...preservedPrivate]);
          void migrateCardInlineImagesToIdb(importedCards).then(
            ({ cards: lightImported, migrated }) => {
              if (migrated) {
                const lightById = new Map(lightImported.map((c) => [c.id, c]));
                setWorkflowCards((prev) => {
                  const next = prev.map((c) => lightById.get(c.id) ?? c);
                  void saveWorkflowCardsToIndexedDb(next);
                  return next;
                });
              }
            }
          );
        }
        patchUiCache({
          selectedPresetByChar: {},
          selectedBackgroundId: normalized.shared.selectedBackgroundId ?? null,
          selectedBackgroundName: normalized.shared.selectedBackgroundName ?? null,
        });
        updateConfig(normalized);
        setSelectedCharId(normalized.characters[0].id);
      } catch {
        setImportError('导入失败：无法解析 JSON 文件');
      }
    };
    reader.readAsText(file);
  };

  const handleResetDefaults = () => {
    pushHistory('恢复默认 4 角色前', config);
    const fresh = cloneConfig(DEFAULT_STUDIO_CONFIG);
    patchUiCache({
      selectedPresetByChar: {},
      selectedBackgroundId: null,
      selectedBackgroundName: null,
    });
    updateConfig(fresh);
    setSelectedCharId(fresh.characters[0].id);
    setImportError(null);
  };

  const handleRollbackHistory = (snapshotId: string) => {
    const target = history.find((h) => h.id === snapshotId);
    if (!target) return;
    pushHistory('回滚前状态', config);
    const restored = normalizeStudioConfig(cloneConfig(target.config));
    patchUiCache({
      selectedPresetByChar: {},
      selectedBackgroundId: restored.shared.selectedBackgroundId ?? null,
      selectedBackgroundName: restored.shared.selectedBackgroundName ?? null,
    });
    updateConfig(restored);
    if (!restored.characters.some((c) => c.id === selectedCharId)) {
      setSelectedCharId(restored.characters[0]?.id ?? '');
    }
  };

  const handleUpdateActiveProfile = useCallback(
    (updater: (prev: ComfyProfile) => ComfyProfile) => {
      updateConfig((prev) => {
        const list =
          prev.comfyProfiles && prev.comfyProfiles.length > 0
            ? prev.comfyProfiles
            : DEFAULT_COMFY_PROFILES;
        const targetId = prev.activeComfyProfileId ?? list[0].id;
        const nextList = list.map((p) => (p.id === targetId ? updater(p) : p));
        const updated = nextList.find((p) => p.id === targetId) ?? nextList[0];
        return {
          ...prev,
          comfyProfiles: nextList,
          activeComfyProfileId: updated.id,
          comfyUnetName: updated.loaders.unet ?? prev.comfyUnetName,
          comfyClipName: updated.loaders.clip ?? prev.comfyClipName,
          comfyVaeName: updated.loaders.vae ?? prev.comfyVaeName,
        };
      });
    },
    [updateConfig]
  );

  const handleSelectProfile = (profileId: string) => {
    updateConfig((prev) => ({
      ...prev,
      activeComfyProfileId: profileId,
    }));
  };

  const handleCreateProfile = (name?: string) => {
    const base = activeProfile;
    const newProfile: ComfyProfile = {
      ...JSON.parse(JSON.stringify(base)),
      id: `profile-${Date.now()}`,
      name: name?.trim() || `${base.name} 副本`,
    };
    updateConfig((prev) => ({
      ...prev,
      comfyProfiles: [...(prev.comfyProfiles ?? DEFAULT_COMFY_PROFILES), newProfile],
      activeComfyProfileId: newProfile.id,
    }));
  };

  const handleRenameProfile = (profileId: string, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    updateConfig((prev) => ({
      ...prev,
      comfyProfiles: (prev.comfyProfiles ?? DEFAULT_COMFY_PROFILES).map((p) =>
        p.id === profileId ? { ...p, name: trimmed } : p
      ),
    }));
  };

  const handleDeleteProfile = (profileId: string) => {
    updateConfig((prev) => {
      const list = prev.comfyProfiles ?? DEFAULT_COMFY_PROFILES;
      if (list.length <= 1) return prev;
      const remaining = list.filter((p) => p.id !== profileId);
      const nextActive =
        prev.activeComfyProfileId === profileId
          ? remaining[0].id
          : prev.activeComfyProfileId;
      return {
        ...prev,
        comfyProfiles: remaining,
        activeComfyProfileId: nextActive,
      };
    });
  };

  const handleExportProfile = (profile: ComfyProfile) => {
    const payload = exportComfyProfilePayload(profile);
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${sanitizeFilenamePrefix(profile.name)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleImportProfile = async (file: File): Promise<string> => {
    const text = await file.text();
    const parsed = JSON.parse(text) as unknown;
    const imported = parseComfyProfileImport(parsed);
    updateConfig((prev) => ({
      ...prev,
      comfyProfiles: [...(prev.comfyProfiles ?? DEFAULT_COMFY_PROFILES), imported],
      activeComfyProfileId: imported.id,
    }));
    return imported.name;
  };

  const hasErrors = conflicts.some((c) => c.severity === 'error');

  return (
    <div className="min-h-screen lg:h-screen lg:flex lg:flex-col bg-[#F4F4F7] text-[#1E2028]">
      {/* 顶栏（支持半屏/窄屏自动换行，避免右侧按钮裁切） */}
      <header className="sticky top-0 z-20 min-h-[56px] shrink-0 bg-white/90 backdrop-blur-md border-b border-[#E0E0E6]">
        <div className="max-w-[1600px] mx-auto px-3.5 sm:px-5 min-h-[56px] py-1.5 flex flex-wrap items-center justify-between gap-2.5 sm:gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <span className="text-[15px] font-bold tracking-tight text-[#1E2028] whitespace-nowrap">
              ChibiPrompt Studio
            </span>
            <span className="text-[11.5px] text-[#686E7E] tabular-nums whitespace-nowrap hidden sm:inline px-2 py-0.5 rounded-[6px] bg-[#F2F3F7]">
              {config.characters.length} 位角色
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 sm:gap-2.5">
            <button
              type="button"
              onClick={() => setWorkbenchOpen(true)}
              title="打开参考图 + 工作流 JSON 收藏与微调工作台（与角色/预设快填完全隔离）"
              className="h-8 px-3 inline-flex items-center gap-1.5 text-[12px] font-medium rounded-[10px] border border-[#DDD8FA] bg-[#F4F2FF] text-[#6B48F5] hover:bg-[#EBE6FF] transition-colors whitespace-nowrap cursor-pointer"
            >
              <Layers className="w-3.5 h-3.5" />
              <span>收藏工作台</span>
              {workflowCards.some((c) => !c.isPrivate) && (
                <span className="text-[11px] font-mono tabular-nums opacity-85">
                  ({workflowCards.filter((c) => !c.isPrivate).length})
                </span>
              )}
            </button>

            <label
              title="关闭后适合粘到已内置角色外貌的工作流"
              className="h-8 px-3 inline-flex items-center gap-1.5 rounded-[10px] border border-[#E0E0E6] bg-white text-[12px] font-medium text-[#4C5264] hover:border-[#7C5CFC]/40 hover:text-[#1E2028] cursor-pointer select-none transition-colors whitespace-nowrap"
            >
              <input
                type="checkbox"
                checked={includeAppearance}
                onChange={() =>
                  setIncludeAppearanceState((prev) => {
                    const next = !prev;
                    patchUiCache({ includeAppearance: next });
                    return next;
                  })
                }
                className="w-3.5 h-3.5 accent-[#7C5CFC] rounded"
              />
              <span>包含外貌</span>
            </label>

            <button
              type="button"
              onClick={handleExportConfig}
              className="h-8 px-3 inline-flex items-center gap-1.5 text-[12px] font-medium rounded-[10px] border border-[#E0E0E6] bg-white text-[#4C5264] hover:border-[#7C5CFC]/40 hover:text-[#7C5CFC] transition-colors whitespace-nowrap cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              <span>导出</span>
            </button>

            <button
              type="button"
              onClick={handleCopyAll}
              className="h-8 px-4 inline-flex items-center gap-1.5 text-[12px] font-medium rounded-[10px] bg-gradient-to-b from-[#F07187] to-[#E85D75] text-white shadow-[0_2px_8px_rgba(232,93,117,0.24)] hover:brightness-105 transition-all whitespace-nowrap cursor-pointer"
            >
              {copiedAll ? (
                <>
                  <Check className="w-3.5 h-3.5" />
                  <span>已复制全部</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>复制全部</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              title="ComfyUI 服务与模型配置 / 导入配置 / 历史回滚"
              aria-label="打开设置"
              className="h-8 w-8 inline-flex items-center justify-center rounded-[10px] border border-[#E0E0E6] bg-white text-[#5A6072] hover:border-[#7C5CFC]/40 hover:text-[#7C5CFC] transition-colors cursor-pointer"
            >
              <Settings className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      {/* 主工作区：撑满视口高度 */}
      <main className="flex-1 min-h-0 flex flex-col max-w-[1600px] w-full mx-auto px-4 py-3 gap-3">
        {applyCardToast && (
          <div
            role="status"
            aria-live="polite"
            className="shrink-0 rounded-[12px] border border-emerald-200 bg-emerald-50/95 px-4 py-2 flex items-center justify-between gap-2 text-[12px] text-emerald-800 shadow-[0_2px_10px_rgba(16,185,129,0.08)]"
          >
            <div className="flex items-center gap-2 min-w-0">
              <Check className="w-4 h-4 text-emerald-600 shrink-0" />
              <span className="font-medium truncate">{applyCardToast}</span>
            </div>
            <button
              type="button"
              onClick={() => setApplyCardToast(null)}
              aria-label="关闭提示"
              className="p-0.5 text-emerald-600 hover:text-emerald-900 cursor-pointer shrink-0"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
        {/* 冲突提醒条（浅色柔和提示） */}
        {conflicts.length > 0 && (
          <div
            className={`shrink-0 rounded-[12px] border overflow-hidden ${
              hasErrors
                ? 'border-[#F8C8D2] bg-[#FFF1F3]'
                : 'border-amber-200 bg-amber-50/90'
            }`}
          >
            <button
              type="button"
              onClick={() => setConflictsExpanded((v) => !v)}
              className="w-full h-9 px-4 flex items-center justify-between gap-2 text-left cursor-pointer"
            >
              <div
                className={`flex items-center gap-2 min-w-0 ${
                  hasErrors ? 'text-[#B42343]' : 'text-amber-800'
                }`}
              >
                <AlertTriangle
                  className={`w-3.5 h-3.5 shrink-0 ${
                    hasErrors ? 'text-[#E85D75]' : 'text-amber-500'
                  }`}
                />
                <span className="text-[12px] font-medium truncate">
                  检测到 {conflicts.length} 处提示词冲突（{conflicts[0]?.title}）
                </span>
              </div>
              <div
                className={`flex items-center gap-1 text-[11.5px] font-medium shrink-0 ${
                  hasErrors ? 'text-[#C93B58]' : 'text-amber-700'
                }`}
              >
                <span>{conflictsExpanded ? '收起' : '查看 / 处理'}</span>
                <ChevronRight
                  className={`w-3.5 h-3.5 transition-transform duration-150 ${
                    conflictsExpanded ? 'rotate-90' : ''
                  }`}
                />
              </div>
            </button>

            {conflictsExpanded && (
              <div className="px-4 pb-3 pt-2 border-t border-black/[0.06] space-y-2">
                {conflicts.map((conflict) => (
                  <div
                    key={conflict.id}
                    className="flex flex-wrap items-center justify-between gap-2 text-[11.5px] text-[#4C5264]"
                  >
                    <span>
                      <strong className="text-[#1E2028]">{conflict.title}：</strong>
                      {conflict.detail}
                    </span>
                    {conflict.fixType && (
                      <button
                        type="button"
                        onClick={() => handleFixConflict(conflict)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-[8px] border border-[#EAEAEF] bg-white text-[#1E2028] hover:border-[#7C5CFC]/50 hover:text-[#7C5CFC] cursor-pointer shrink-0 transition-colors"
                      >
                        <Wrench className="w-3 h-3" />
                        <span>
                          {conflict.fixType === 'remove-solo'
                            ? '移除 solo'
                            : conflict.fixType === 'remove-forbidden-tag'
                            ? `忽略禁用词 "${conflict.targetTag}"`
                            : conflict.fixType === 'remove-character-tag'
                            ? `从角色移除 "${conflict.targetTag}"`
                            : conflict.fixType === 'remove-shared-tag'
                            ? `从共享层移除 "${conflict.targetTag}"`
                            : `从负向移除 "${conflict.targetTag}"`}
                        </span>
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 顶部可折叠共享层横条 */}
        <SharedLayerPanel
          shared={config.shared}
          characters={config.characters}
          onUpdateShared={handleUpdateShared}
          customBackgrounds={config.customBackgrounds ?? []}
          onUpdateCustomBackgrounds={(items) =>
            updateConfig((prev) => ({ ...prev, customBackgrounds: items }))
          }
        />

        {/* 三栏主体：撑满剩余高度 */}
        <div className="flex-1 min-h-0 flex flex-col lg:flex-row items-stretch gap-3">
          <CharacterSidebar
            shared={config.shared}
            characters={config.characters}
            selectedCharId={activeCharacter?.id ?? ''}
            includeAppearance={includeAppearance}
            activeProfile={activeProfile}
            customPresets={config.customPresets ?? []}
            customBackgrounds={config.customBackgrounds ?? []}
            onSelectCharacter={setSelectedCharId}
            onAddCharacter={handleAddCharacter}
            onDeleteCharacter={handleDeleteCharacter}
            onRenameCharacter={handleRenameCharacter}
            onMoveCharacter={handleMoveCharacter}
          />

          {activeCharacter && (
            <CharacterEditorPanel
              character={activeCharacter}
              onUpdateCharacter={handleUpdateCharacter}
              customPresets={config.customPresets ?? []}
              onUpdateCustomPresets={(items) =>
                updateConfig((prev) => ({ ...prev, customPresets: items }))
              }
            />
          )}

          {activeCharacter && (
            <OutputSidebar
              shared={config.shared}
              activeCharacter={activeCharacter}
              includeAppearance={includeAppearance}
              customPresets={config.customPresets ?? []}
              customBackgrounds={config.customBackgrounds ?? []}
              onCopyWorkflowSnippet={handleCopyWorkflowSnippet}
              copiedSnippet={copiedSnippet}
              comfyUrl={config.comfyUrl}
              activeProfile={activeProfile}
              validation={validation}
              probingLoaders={probingLoaders}
              onProbeLoaders={() => void probeComfyLoaders()}
              onOpenSettings={() => setSettingsOpen(true)}
              onUpdateActiveProfile={handleUpdateActiveProfile}
            />
          )}
        </div>
      </main>

      {/* 界面底部状态栏：动态防护规则说明徽章与实时状态 */}
      <footer className="relative shrink-0 bg-white/90 backdrop-blur-md border-t border-[#E0E0E6]">
        {guardHelpOpen && activeGuardAnalysis && (
          <div className="max-w-[1600px] mx-auto px-4">
            <div className="absolute bottom-[36px] left-4 right-4 sm:right-auto sm:w-[540px] z-30 rounded-[12px] border border-[#E0E0E6] bg-white shadow-[0_10px_30px_rgba(18,22,33,0.12)] p-3.5 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-[12px] font-semibold text-[#1E2028]">
                  <ShieldCheck className="w-4 h-4 text-[#7C5CFC]" />
                  <span>动态防护规则说明 · {activeCharacter?.name}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setGuardHelpOpen(false)}
                  aria-label="关闭动态防护规则说明"
                  className="p-0.5 text-[#949AA8] hover:text-[#1E2028] cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="space-y-1 text-[11px] text-[#4C5264]">
                {activeGuardAnalysis.rules.map((r) => (
                  <div key={r.id} className="flex items-start gap-1.5">
                    <span className="font-semibold text-[#1E2028] shrink-0">
                      • {r.label}：
                    </span>
                    <span>{r.detail}</span>
                  </div>
                ))}
              </div>
              {activeGuardAnalysis.resolvedAdjustments.length > 0 && (
                <div className="pt-1.5 border-t border-[#EAEAEF] space-y-1 text-[10.5px] text-[#0369A1]">
                  <div className="font-semibold">四维自动调和明细：</div>
                  {activeGuardAnalysis.resolvedAdjustments.map((adj, idx) => (
                    <div key={idx}>• {adj}</div>
                  ))}
                </div>
              )}
              {activeGuardAnalysis.appendedTags.length > 0 && (
                <div className="pt-1.5 border-t border-[#EAEAEF] text-[10.5px] font-mono text-[#686E7E] break-words">
                  当前追加负向词：{activeGuardAnalysis.appendedTags.join(', ')}
                </div>
              )}
            </div>
          </div>
        )}

        <div className="max-w-[1600px] mx-auto px-4 min-h-[32px] py-1 flex flex-wrap items-center justify-between gap-2 text-[11px]">
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <button
              type="button"
              onClick={() => setGuardHelpOpen((v) => !v)}
              title="点击查看当前自动防冲突与防同化处理明细"
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border font-medium transition-colors cursor-pointer whitespace-nowrap ${
                guardHelpOpen
                  ? 'border-[#7C5CFC]/50 bg-[#F3F0FF] text-[#6B48F5]'
                  : 'border-[#E0E0E6] bg-[#FAFAFC] text-[#4C5264] hover:border-[#7C5CFC]/40 hover:text-[#6B48F5]'
              }`}
            >
              <ShieldCheck className="w-3 h-3 text-[#7C5CFC]" />
              <span>动态防护规则说明</span>
              <Info className="w-3 h-3 opacity-70" />
            </button>

            {activeGuardAnalysis && (
              <div className="flex flex-wrap items-center gap-1.5">
                {activeGuardAnalysis.rules.map((rule) => (
                  <span
                    key={rule.id}
                    title={rule.detail}
                    className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10.5px] font-medium border whitespace-nowrap ${
                      rule.tone === 'plush'
                        ? 'border-emerald-200 bg-emerald-50/90 text-emerald-700'
                        : rule.tone === 'pajama'
                        ? 'border-[#F5B8C4] bg-[#FFF1F3] text-[#C93B58]'
                        : rule.tone === 'guard'
                        ? 'border-sky-200 bg-sky-50/90 text-sky-700'
                        : 'border-[#DDD8FA] bg-[#F4F2FF] text-[#6B48F5]'
                    }`}
                  >
                    {rule.label}
                  </span>
                ))}
                {activeGuardAnalysis.appendedTags.length > 0 && (
                  <span className="text-[10.5px] text-[#8E94A4] tabular-nums whitespace-nowrap">
                    自动防冲突 +{activeGuardAnalysis.appendedTags.length} 词
                  </span>
                )}
              </div>
            )}
          </div>

          <div className="hidden sm:flex items-center gap-2 text-[#8E94A4] whitespace-nowrap">
            <span>当前：{activeCharacter?.name}</span>
            <span>·</span>
            <span>{COMFY_ARCH_DEFAULTS[activeProfile.architecture].label}</span>
          </div>
        </div>
      </footer>

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        comfyUrl={config.comfyUrl}
        onComfyUrlChange={(url) => updateConfig((prev) => ({ ...prev, comfyUrl: url }))}
        profiles={comfyProfiles}
        activeProfile={activeProfile}
        validation={validation}
        probingLoaders={probingLoaders}
        onProbeLoaders={(keys) => void probeComfyLoaders(keys)}
        onSelectProfile={handleSelectProfile}
        onUpdateActiveProfile={handleUpdateActiveProfile}
        onCreateProfile={handleCreateProfile}
        onRenameProfile={handleRenameProfile}
        onDeleteProfile={handleDeleteProfile}
        onExportProfile={handleExportProfile}
        onImportProfile={handleImportProfile}
        onExportConfig={handleExportConfig}
        onImportConfig={handleImportConfig}
        importError={importError}
        onResetDefaults={handleResetDefaults}
        history={history}
        onSaveSnapshot={() => pushHistory('手动保存快照', config)}
        onRollbackHistory={handleRollbackHistory}
      />

      <WorkflowCollectionModal
        open={workbenchOpen}
        onClose={handleCloseWorkbench}
        cards={workflowCards}
        onChangeCards={handleChangeWorkflowCards}
        comfyUrl={config.comfyUrl}
        activeProfile={activeProfile}
        activeCharacterName={activeCharacter?.name ?? '角色'}
        characters={config.characters}
        selectedCharId={activeCharacter?.id ?? ''}
        knownCharacterHints={knownCharacterHints}
        shared={config.shared}
        customPresets={config.customPresets ?? []}
        customBackgrounds={config.customBackgrounds ?? []}
        onUpdateCustomBackgrounds={(items) =>
          updateConfig((prev) => ({ ...prev, customBackgrounds: items }))
        }
        availableLoras={validation.loraAvailable}
        customLoras={config.customLoras ?? []}
        onUpdateCustomLoras={(items) =>
          updateConfig((prev) => ({ ...prev, customLoras: items }))
        }
        onRefreshAvailableLoras={() => probeComfyLoaders()}
        onOpenSettings={handleOpenSettingsFromWorkbench}
        onApplyCardToCharacter={handleApplyWorkflowCardToCharacter}
      />
    </div>
  );
}
