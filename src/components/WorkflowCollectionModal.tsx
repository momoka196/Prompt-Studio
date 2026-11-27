import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CopyPlus,
  Dices,
  Download,
  Eye,
  EyeOff,
  FileJson,
  FolderCheck,
  FolderOpen,
  FolderSync,
  ImagePlus,
  Layers,
  Loader2,
  Lock,
  Minus,
  Play,
  Plus,
  RotateCcw,
  Save,
  Search,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Upload,
  X,
  ZoomIn,
} from 'lucide-react';
import { DEFAULT_COMFY_SEED } from '../data/presets';
import {
  ComfyProfile,
  WorkflowCollectionCard,
  WorkflowJsonFormat,
  WorkflowPromptNodeCandidate,
  WorkflowPromptTagItem,
} from '../types/studio';
import { sanitizeFilenamePrefix } from '../utils/promptBuilder';
import {
  buildCardExportPayload,
  buildWorkflowCardFromPngFile,
  dataUrlToBlob,
  ensureDirectoryWritePermission,
  extractComfyMetadataFromPngFile,
  isFileSystemAccessSupported,
  parseComfyWorkflowSource,
  parsePromptToTagItems,
  pickLocalWorkflowDirectory,
  readImageOriginalData,
  sendWorkflowCardToComfyUI,
  serializeTagItemsToPrompt,
  writeCardsBatchToLocalDirectory,
  writeCardToLocalDirectory,
} from '../utils/workflowLibrary';
import {
  loadBoundDirectoryHandle,
  mergeImportedWorkflowCards,
  normalizeWorkflowCards,
  saveBoundDirectoryHandle,
} from '../utils/storageCache';

interface WorkflowCollectionModalProps {
  open: boolean;
  onClose: () => void;
  cards: WorkflowCollectionCard[];
  onChangeCards: (next: WorkflowCollectionCard[]) => { ok: boolean; error?: string };
  comfyUrl: string;
  activeProfile: ComfyProfile;
  activeCharacterName: string;
  onOpenSettings: () => void;
}

interface DraftImportState {
  title: string;
  tagsInput: string;
  thumbnailDataUrl: string;
  originalImageDataUrl?: string;
  originalImageMime?: string;
  originalImageWidth?: number;
  originalImageHeight?: number;
  imageName: string;
  workflowFileName: string;
  workflowFormat: WorkflowJsonFormat;
  rawWorkflowJson: string;
  apiPromptJson?: string;
  extractedPositive: string;
  extractedNegative: string;
  positiveNodeId: string | null;
  negativeNodeId: string | null;
  nodeCandidates: WorkflowPromptNodeCandidate[];
  isPrivate: boolean;
}

interface WorkbenchRunStatus {
  state: 'idle' | 'sending' | 'success' | 'error';
  cardId?: string;
  cardTitle?: string;
  promptId?: string;
  usedSeed?: number;
  summary?: string;
  message?: string;
  canRetryWithProfile?: boolean;
  timestamp?: string;
}

const EMPTY_DRAFT: DraftImportState = {
  title: '',
  tagsInput: '',
  thumbnailDataUrl: '',
  originalImageDataUrl: undefined,
  originalImageMime: undefined,
  originalImageWidth: undefined,
  originalImageHeight: undefined,
  imageName: '',
  workflowFileName: '',
  workflowFormat: 'unknown',
  rawWorkflowJson: '',
  apiPromptJson: undefined,
  extractedPositive: '',
  extractedNegative: '',
  positiveNodeId: null,
  negativeNodeId: null,
  nodeCandidates: [],
  isPrivate: false,
};

function parseTagsInput(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(/[,，\s]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    )
  );
}

function stripFileExtension(filename: string): string {
  return filename.replace(/\.[^/.]+$/, '').trim();
}

function formatFormatLabel(fmt: WorkflowJsonFormat): string {
  if (fmt === 'api') return 'API 节点图';
  if (fmt === 'ui') return 'UI 工作流';
  if (fmt === 'png-embedded') return 'PNG 内嵌工作流';
  return '未知格式';
}

export const WorkflowCollectionModal: React.FC<WorkflowCollectionModalProps> = ({
  open,
  onClose,
  cards,
  onChangeCards,
  comfyUrl,
  activeProfile,
  activeCharacterName,
  onOpenSettings,
}) => {
  const [draft, setDraft] = useState<DraftImportState>(EMPTY_DRAFT);
  const [createPanelOpen, setCreatePanelOpen] = useState<boolean>(
    () => cards.filter((c) => !c.isPrivate).length === 0
  );
  const [isDragging, setIsDragging] = useState(false);
  const [isBatchDragging, setIsBatchDragging] = useState(false);
  const [isImportingBatch, setIsImportingBatch] = useState(false);
  const [importNotice, setImportNotice] = useState<{
    type: 'ok' | 'err' | 'warn';
    text: string;
  } | null>(null);
  const [storageWarning, setStorageWarning] = useState<string | null>(null);

  const [privateView, setPrivateView] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTagFilter, setActiveTagFilter] = useState<string>('ALL');

  const [runStatus, setRunStatus] = useState<WorkbenchRunStatus>({ state: 'idle' });
  const [preferStudioProfile, setPreferStudioProfile] = useState(false);
  const [workbenchSeedOverride, setWorkbenchSeedOverride] = useState<'card' | 'fixed' | 'random'>('card');
  const [workbenchFixedSeed, setWorkbenchFixedSeed] = useState<number>(DEFAULT_COMFY_SEED);

  // Local folder binding state (File System Access API + graceful fallback)
  const fsApiSupported = useMemo(() => isFileSystemAccessSupported(), []);
  const [boundDirHandle, setBoundDirHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [dirPermState, setDirPermState] = useState<'none' | 'granted' | 'prompt' | 'denied'>('none');
  const [folderNotice, setFolderNotice] = useState<{
    type: 'ok' | 'warn' | 'err';
    text: string;
  } | null>(null);
  const [isSyncingFolder, setIsSyncingFolder] = useState(false);

  // Lightbox state
  const [lightboxCardId, setLightboxCardId] = useState<string | null>(null);

  // Fine-tuning drawer state
  const [editingCardId, setEditingCardId] = useState<string | null>(null);
  const [editTab, setEditTab] = useState<'positive' | 'negative'>('positive');
  const [editTitle, setEditTitle] = useState('');
  const [editTagsInput, setEditTagsInput] = useState('');
  const [editPosNodeId, setEditPosNodeId] = useState<string | null>(null);
  const [editNegNodeId, setEditNegNodeId] = useState<string | null>(null);
  const [editPosText, setEditPosText] = useState('');
  const [editNegText, setEditNegText] = useState('');
  const [editPosTags, setEditPosTags] = useState<WorkflowPromptTagItem[]>([]);
  const [editNegTags, setEditNegTags] = useState<WorkflowPromptTagItem[]>([]);
  const [editApplyOnSend, setEditApplyOnSend] = useState(true);
  const [editIsPrivate, setEditIsPrivate] = useState(false);
  const [editSeedMode, setEditSeedMode] = useState<'workflow' | 'fixed' | 'random'>('workflow');
  const [editFixedSeed, setEditFixedSeed] = useState<number>(DEFAULT_COMFY_SEED);
  const [newTagInput, setNewTagInput] = useState('');
  const [saveFeedback, setSaveFeedback] = useState<string | null>(null);

  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const jsonInputRef = useRef<HTMLInputElement | null>(null);
  const collectionImportRef = useRef<HTMLInputElement | null>(null);

  const editingCard = useMemo(
    () => (editingCardId ? cards.find((c) => c.id === editingCardId) ?? null : null),
    [cards, editingCardId]
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const savedHandle = await loadBoundDirectoryHandle();
      if (cancelled || !savedHandle) return;
      const perm = await ensureDirectoryWritePermission(savedHandle, false);
      if (cancelled) return;
      setBoundDirHandle(savedHandle);
      setDirPermState(perm);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const publicCards = useMemo(() => cards.filter((c) => !c.isPrivate), [cards]);
  const privateCards = useMemo(() => cards.filter((c) => Boolean(c.isPrivate)), [cards]);
  const scopedCards = useMemo(
    () => (privateView ? privateCards : publicCards),
    [privateView, privateCards, publicCards]
  );

  const allCategoryTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const card of scopedCards) {
      for (const tag of card.tags) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [scopedCards]);

  const filteredCards = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return scopedCards.filter((card) => {
      if (activeTagFilter !== 'ALL' && !card.tags.includes(activeTagFilter)) {
        return false;
      }
      if (!q) return true;
      return (
        card.title.toLowerCase().includes(q) ||
        card.tags.some((t) => t.toLowerCase().includes(q)) ||
        card.fineTunedPositive.toLowerCase().includes(q) ||
        card.fineTunedNegative.toLowerCase().includes(q)
      );
    });
  }, [scopedCards, activeTagFilter, searchQuery]);

  const lightboxIndex = useMemo(() => {
    if (!lightboxCardId) return -1;
    return filteredCards.findIndex((c) => c.id === lightboxCardId);
  }, [filteredCards, lightboxCardId]);

  const lightboxCard = useMemo(() => {
    if (!lightboxCardId) return null;
    if (lightboxIndex >= 0) return filteredCards[lightboxIndex];
    return scopedCards.find((c) => c.id === lightboxCardId) ?? null;
  }, [filteredCards, lightboxCardId, lightboxIndex, scopedCards]);

  useEffect(() => {
    if (!open) {
      setPrivateView(false);
      setActiveTagFilter('ALL');
      setLightboxCardId(null);
      return;
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (lightboxCardId) {
        if (e.key === 'Escape') {
          e.preventDefault();
          setLightboxCardId(null);
          return;
        }
        if (e.key === 'ArrowLeft' && filteredCards.length > 1) {
          e.preventDefault();
          const curIdx = filteredCards.findIndex((c) => c.id === lightboxCardId);
          const prevIdx =
            curIdx <= 0 ? filteredCards.length - 1 : curIdx - 1;
          setLightboxCardId(filteredCards[prevIdx].id);
          return;
        }
        if (e.key === 'ArrowRight' && filteredCards.length > 1) {
          e.preventDefault();
          const curIdx = filteredCards.findIndex((c) => c.id === lightboxCardId);
          const nextIdx =
            curIdx < 0 || curIdx >= filteredCards.length - 1 ? 0 : curIdx + 1;
          setLightboxCardId(filteredCards[nextIdx].id);
          return;
        }
        return;
      }

      if (e.key === 'Escape') {
        if (editingCardId) {
          setEditingCardId(null);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, editingCardId, lightboxCardId, filteredCards, onClose]);

  const openFineTuner = useCallback((card: WorkflowCollectionCard, initialTab: 'positive' | 'negative' = 'positive') => {
    setEditingCardId(card.id);
    setEditTab(initialTab);
    setEditTitle(card.title);
    setEditTagsInput(card.tags.join(', '));
    setEditPosNodeId(card.positiveNodeId);
    setEditNegNodeId(card.negativeNodeId);
    setEditPosText(card.fineTunedPositive);
    setEditNegText(card.fineTunedNegative);
    setEditPosTags(parsePromptToTagItems(card.fineTunedPositive));
    setEditNegTags(parsePromptToTagItems(card.fineTunedNegative));
    setEditApplyOnSend(card.applyFineTuneOnSend);
    setEditIsPrivate(Boolean(card.isPrivate));
    setEditSeedMode(card.seedMode ?? 'workflow');
    setEditFixedSeed(card.fixedSeed ?? DEFAULT_COMFY_SEED);
    setNewTagInput('');
    setSaveFeedback(null);
  }, []);

  const commitCards = useCallback(
    (next: WorkflowCollectionCard[]) => {
      const res = onChangeCards(next);
      if (!res.ok && res.error) {
        setStorageWarning(res.error);
      } else {
        setStorageWarning(null);
      }
      return res;
    },
    [onChangeCards]
  );

  const handleSelectLocalFolder = async () => {
    const result = await pickLocalWorkflowDirectory();
    if (!result.ok) {
      if (result.cancelled) return;
      setFolderNotice({
        type: result.unsupported || result.iframeBlocked ? 'warn' : 'err',
        text: result.message,
      });
      return;
    }

    const perm = await ensureDirectoryWritePermission(result.handle, true);
    setBoundDirHandle(result.handle);
    setDirPermState(perm);
    await saveBoundDirectoryHandle(result.handle);

    if (perm === 'granted') {
      setFolderNotice({
        type: 'ok',
        text: `已绑定本地文件夹「${result.handle.name}」：后续建卡、微调保存与批量导入将自动把未压缩原图与工作流 JSON 落盘写入对应子文件夹`,
      });
    } else {
      setFolderNotice({
        type: 'warn',
        text: `已选择文件夹「${result.handle.name}」，但暂未获得写入权限；请点击「授权写入」或降级使用导出下载`,
      });
    }
  };

  const handleUnbindLocalFolder = async () => {
    setBoundDirHandle(null);
    setDirPermState('none');
    await saveBoundDirectoryHandle(null);
    setFolderNotice({
      type: 'ok',
      text: '已解绑本地文件夹（卡片仍完整保存在浏览器 IndexedDB 缓存中）',
    });
  };

  const handleReauthorizeLocalFolder = async () => {
    if (!boundDirHandle) return;
    const perm = await ensureDirectoryWritePermission(boundDirHandle, true);
    setDirPermState(perm);
    if (perm === 'granted') {
      setFolderNotice({
        type: 'ok',
        text: `已重新授权本地文件夹「${boundDirHandle.name}」写入权限`,
      });
    } else {
      setFolderNotice({
        type: 'warn',
        text: `未能获取「${boundDirHandle.name}」写入权限，可重新选择本地文件夹或使用导出下载`,
      });
    }
  };

  const tryAutoWriteCardToFolder = useCallback(
    async (card: WorkflowCollectionCard): Promise<{ written: boolean; path?: string; error?: string }> => {
      if (!boundDirHandle || dirPermState !== 'granted') {
        return { written: false };
      }
      const res = await writeCardToLocalDirectory(boundDirHandle, card);
      if (res.ok) {
        return { written: true, path: res.relativePath };
      }
      return { written: false, error: res.error };
    },
    [boundDirHandle, dirPermState]
  );

  const handleSyncScopedCardsToFolder = async () => {
    if (!boundDirHandle) {
      await handleSelectLocalFolder();
      return;
    }
    const perm = await ensureDirectoryWritePermission(boundDirHandle, true);
    setDirPermState(perm);
    if (perm !== 'granted') {
      setFolderNotice({
        type: 'warn',
        text: `未获得「${boundDirHandle.name}」写入权限，无法写入磁盘；已保留浏览器缓存并可使用「导出集」下载`,
      });
      return;
    }
    const targetCards = scopedCards;
    if (targetCards.length === 0) {
      setFolderNotice({
        type: 'warn',
        text: privateView ? '当前私密区暂无卡片可同步' : '当前公开区暂无卡片可同步',
      });
      return;
    }

    setIsSyncingFolder(true);
    try {
      const { succeededIds, failed } = await writeCardsBatchToLocalDirectory(
        boundDirHandle,
        targetCards
      );
      if (succeededIds.length > 0) {
        const now = Date.now();
        const okSet = new Set(succeededIds);
        commitCards(
          cards.map((c) => (okSet.has(c.id) ? { ...c, lastFolderSyncAt: now } : c))
        );
      }
      if (failed.length === 0) {
        setFolderNotice({
          type: 'ok',
          text: `已将 ${succeededIds.length} 张${privateView ? '私密' : '公开'}卡片（含未压缩原图 + workflow.json + card.json）同步写入本地文件夹「${boundDirHandle.name}」`,
        });
      } else {
        setFolderNotice({
          type: 'warn',
          text: `已同步 ${succeededIds.length} 张，${failed.length} 张写入失败（${failed[0]?.title}: ${failed[0]?.error}）`,
        });
      }
    } finally {
      setIsSyncingFolder(false);
    }
  };

  const handleFilesIngest = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    setImportNotice(null);

    let nextImageFile: File | null = null;
    let nextJsonFile: File | null = null;

    for (const file of list) {
      const lower = file.name.toLowerCase();
      if (
        file.type.startsWith('image/') ||
        /\.(png|jpe?g|webp)$/i.test(lower)
      ) {
        nextImageFile = file;
      } else if (
        file.type === 'application/json' ||
        lower.endsWith('.json')
      ) {
        nextJsonFile = file;
      }
    }

    if (!nextImageFile && !nextJsonFile) {
      setImportNotice({
        type: 'err',
        text: '请拖入 PNG/JPG/WebP 参考图或 ComfyUI 工作流 .json 文件',
      });
      return;
    }

    let originalImage: Awaited<ReturnType<typeof readImageOriginalData>> | null = null;
    let pngMeta: Awaited<ReturnType<typeof extractComfyMetadataFromPngFile>> | null = null;

    if (nextImageFile) {
      try {
        originalImage = await readImageOriginalData(nextImageFile);
        if (
          nextImageFile.type === 'image/png' ||
          nextImageFile.name.toLowerCase().endsWith('.png')
        ) {
          pngMeta = await extractComfyMetadataFromPngFile(nextImageFile);
        }
      } catch (err) {
        setImportNotice({
          type: 'err',
          text: err instanceof Error ? err.message : '读取参考图失败',
        });
        return;
      }
    }

    let rawJsonText = '';
    if (nextJsonFile) {
      try {
        rawJsonText = await nextJsonFile.text();
      } catch {
        setImportNotice({ type: 'err', text: '读取 JSON 文件失败' });
        return;
      }
    }

    setDraft((prev) => {
      const updated = { ...prev };
      if (nextImageFile && originalImage) {
        updated.thumbnailDataUrl = originalImage.dataUrl;
        updated.originalImageDataUrl = originalImage.dataUrl;
        updated.originalImageMime = originalImage.mimeType;
        updated.originalImageWidth = originalImage.width;
        updated.originalImageHeight = originalImage.height;
        updated.imageName = nextImageFile.name;
        if (!updated.title.trim()) {
          updated.title =
            pngMeta?.chibipromptMeta?.character ||
            stripFileExtension(nextImageFile.name);
        }
      }

      const effectiveRawJson = rawJsonText || pngMeta?.workflowJson || '';
      const effectiveApiJson = pngMeta?.apiPromptJson;

      if (effectiveRawJson || effectiveApiJson || pngMeta?.chibipromptMeta) {
        try {
          const parsed = parseComfyWorkflowSource({
            rawJsonText: effectiveRawJson || undefined,
            apiPromptJsonText: effectiveApiJson,
            chibipromptMeta: pngMeta?.chibipromptMeta,
          });
          updated.workflowFileName = nextJsonFile
            ? nextJsonFile.name
            : nextImageFile
            ? `${nextImageFile.name} (内嵌元数据)`
            : prev.workflowFileName;
          updated.workflowFormat = parsed.workflowFormat;
          updated.rawWorkflowJson = parsed.rawWorkflowJson;
          updated.apiPromptJson = parsed.apiPromptJson;
          updated.extractedPositive = parsed.extractedPositive;
          updated.extractedNegative = parsed.extractedNegative;
          updated.positiveNodeId = parsed.positiveNodeId;
          updated.negativeNodeId = parsed.negativeNodeId;
          updated.nodeCandidates = parsed.nodeCandidates;

          if (!updated.title.trim() && nextJsonFile) {
            updated.title = stripFileExtension(nextJsonFile.name);
          }

          setImportNotice({
            type: 'ok',
            text: nextJsonFile
              ? `已解析工作流「${nextJsonFile.name}」（${formatFormatLabel(parsed.workflowFormat)}，共扫描到 ${parsed.nodeCandidates.length} 个文本/CLIP节点）`
              : `已从 PNG 元数据自动提取工作流与提示词（${formatFormatLabel(parsed.workflowFormat)}）`,
          });
        } catch (err) {
          setImportNotice({
            type: 'err',
            text: err instanceof Error ? err.message : '解析 ComfyUI 工作流失败',
          });
        }
      } else if (nextImageFile) {
        setImportNotice({
          type: 'warn',
          text: '已载入原始参考图（未压缩；该图片未内嵌 ComfyUI 工作流，请再拖入对应的 .json 工作流文件）',
        });
      }

      return updated;
    });
  }, []);

  const handleSaveNewCard = async () => {
    if (!draft.rawWorkflowJson && !draft.apiPromptJson && !draft.extractedPositive) {
      setImportNotice({
        type: 'err',
        text: '请先导入 ComfyUI 工作流 .json 文件，或拖入内嵌工作流元数据的 PNG 图片',
      });
      return;
    }
    const now = Date.now();
    const title =
      draft.title.trim() ||
      stripFileExtension(draft.imageName) ||
      stripFileExtension(draft.workflowFileName) ||
      `工作流收藏 #${cards.length + 1}`;
    const tags = parseTagsInput(draft.tagsInput);

    let newCard: WorkflowCollectionCard = {
      id: `wf-card-${now}-${Math.random().toString(36).slice(2, 6)}`,
      title,
      tags,
      thumbnailDataUrl: draft.originalImageDataUrl || draft.thumbnailDataUrl,
      originalImageDataUrl: draft.originalImageDataUrl,
      originalImageMime: draft.originalImageMime,
      originalImageWidth: draft.originalImageWidth,
      originalImageHeight: draft.originalImageHeight,
      imageName: draft.imageName,
      workflowFileName: draft.workflowFileName || 'workflow.json',
      workflowFormat: draft.workflowFormat,
      rawWorkflowJson: draft.rawWorkflowJson || '{}',
      apiPromptJson: draft.apiPromptJson,
      extractedPositive: draft.extractedPositive,
      extractedNegative: draft.extractedNegative,
      fineTunedPositive: draft.extractedPositive,
      fineTunedNegative: draft.extractedNegative,
      positiveNodeId: draft.positiveNodeId,
      negativeNodeId: draft.negativeNodeId,
      nodeCandidates: draft.nodeCandidates,
      applyFineTuneOnSend: true,
      isPrivate: draft.isPrivate,
      seedMode: 'workflow',
      createdAt: now,
      updatedAt: now,
    };

    const folderRes = await tryAutoWriteCardToFolder(newCard);
    if (folderRes.written) {
      newCard = { ...newCard, lastFolderSyncAt: Date.now() };
    } else if (folderRes.error) {
      setFolderNotice({
        type: 'warn',
        text: `已保存到浏览器缓存，但写入本地文件夹失败：${folderRes.error}`,
      });
    }

    const saveRes = commitCards([newCard, ...cards]);
    if (saveRes.ok) {
      setDraft({ ...EMPTY_DRAFT, isPrivate: privateView });
      const folderSuffix = folderRes.written
        ? `，已同步写入本地文件夹 (${folderRes.path})`
        : '';
      setImportNotice({
        type: 'ok',
        text:
          newCard.isPrivate && !privateView
            ? `已保存私密卡片「${newCard.title}」（已收入私密区，点击顶部「私密」可查看${folderSuffix}）`
            : `已保存收藏卡片「${newCard.title}」${folderSuffix}`,
      });
      setCreatePanelOpen(false);
    }
  };

  const handleToggleCardPrivate = (cardId: string) => {
    const target = cards.find((c) => c.id === cardId);
    if (!target) return;
    const nextPrivate = !target.isPrivate;
    const res = commitCards(
      cards.map((c) =>
        c.id === cardId ? { ...c, isPrivate: nextPrivate, updatedAt: Date.now() } : c
      )
    );
    if (res.ok) {
      if (editingCardId === cardId) {
        setEditIsPrivate(nextPrivate);
      }
      setImportNotice({
        type: 'ok',
        text: nextPrivate
          ? `已将「${target.title}」设为私密（常规列表与默认导出已隐藏）`
          : `已将「${target.title}」取消私密并移回公开列表`,
      });
    }
  };

  const handleDeleteCard = (cardId: string) => {
    if (editingCardId === cardId) {
      setEditingCardId(null);
    }
    if (lightboxCardId === cardId) {
      setLightboxCardId(null);
    }
    commitCards(cards.filter((c) => c.id !== cardId));
  };

  const handleDownloadCardOriginalImage = (card: WorkflowCollectionCard) => {
    const src = card.originalImageDataUrl || card.thumbnailDataUrl;
    if (!src) return;
    try {
      const blob = dataUrlToBlob(src);
      const ext =
        card.imageName.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase() ||
        (blob.type.includes('jpeg')
          ? 'jpg'
          : blob.type.includes('webp')
          ? 'webp'
          : 'png');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${sanitizeFilenamePrefix(card.title)}.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      const a = document.createElement('a');
      a.href = src;
      a.download = card.imageName || `${sanitizeFilenamePrefix(card.title)}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  };

  const handleDownloadCardJson = (card: WorkflowCollectionCard) => {
    const content = card.rawWorkflowJson || card.apiPromptJson || '{}';
    const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${sanitizeFilenamePrefix(card.title)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleRunCard = async (
    card: WorkflowCollectionCard,
    forceStudioProfile = false
  ) => {
    setRunStatus({
      state: 'sending',
      cardId: card.id,
      cardTitle: card.title,
      message: `正在同步「${card.title}」工作流与提示词并推送到 ComfyUI...`,
    });

    try {
      const res = await sendWorkflowCardToComfyUI({
        comfyUrl,
        card,
        fallbackProfile: activeProfile,
        characterName: activeCharacterName,
        preferStudioProfile: forceStudioProfile || preferStudioProfile,
        seedModeOverride:
          workbenchSeedOverride === 'card' ? undefined : workbenchSeedOverride,
        fixedSeedOverride:
          workbenchSeedOverride === 'fixed' ? workbenchFixedSeed : undefined,
      });

      const nowTime = new Date().toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      });

      commitCards(
        cards.map((c) =>
          c.id === card.id
            ? { ...c, lastRunAt: Date.now(), lastPromptId: res.promptId }
            : c
        )
      );

      setRunStatus({
        state: 'success',
        cardId: card.id,
        cardTitle: card.title,
        promptId: res.promptId,
        usedSeed: res.usedSeed,
        summary: res.summary,
        timestamp: nowTime,
        message: `已进入本地 ComfyUI 队列 (${res.summary})`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : '推送失败';
      const isNetworkErr =
        /failed to fetch|networkerror|err_connection/i.test(msg);
      setRunStatus({
        state: 'error',
        cardId: card.id,
        cardTitle: card.title,
        canRetryWithProfile: !forceStudioProfile && !preferStudioProfile && Boolean(card.fineTunedPositive.trim()),
        message: isNetworkErr
          ? `${msg}（请确认已启动 ComfyUI 并开启 --enable-cors-header）`
          : msg,
      });
    }
  };

  // Tag Capsule & Textarea Bidirectional Handlers
  const activeTags = editTab === 'positive' ? editPosTags : editNegTags;
  const activeText = editTab === 'positive' ? editPosText : editNegText;

  const updateActiveFromTags = (nextTags: WorkflowPromptTagItem[]) => {
    const serialized = serializeTagItemsToPrompt(nextTags);
    if (editTab === 'positive') {
      setEditPosTags(nextTags);
      setEditPosText(serialized);
    } else {
      setEditNegTags(nextTags);
      setEditNegText(serialized);
    }
  };

  const handleFullTextChange = (val: string) => {
    if (editTab === 'positive') {
      setEditPosText(val);
      setEditPosTags(parsePromptToTagItems(val));
    } else {
      setEditNegText(val);
      setEditNegTags(parsePromptToTagItems(val));
    }
  };

  const handleToggleTagEnabled = (tagId: string) => {
    const next = activeTags.map((t) =>
      t.id === tagId ? { ...t, enabled: !t.enabled } : t
    );
    updateActiveFromTags(next);
  };

  const handleAdjustTagWeight = (tagId: string, delta: number) => {
    const next = activeTags.map((t) => {
      if (t.id !== tagId) return t;
      const updated = Math.min(2.0, Math.max(0.5, Math.round((t.weight + delta) * 10) / 10));
      return { ...t, weight: updated };
    });
    updateActiveFromTags(next);
  };

  const handleSetTagWeight = (tagId: string, weight: number) => {
    const next = activeTags.map((t) => (t.id === tagId ? { ...t, weight } : t));
    updateActiveFromTags(next);
  };

  const handleDeleteTag = (tagId: string) => {
    const next = activeTags.filter((t) => t.id !== tagId);
    updateActiveFromTags(next);
  };

  const handleAddTags = () => {
    const raw = newTagInput.trim();
    if (!raw) return;
    const parsed = parsePromptToTagItems(raw);
    if (parsed.length === 0) return;
    updateActiveFromTags([...activeTags, ...parsed]);
    setNewTagInput('');
  };

  const handleSwitchNodeSource = (role: 'positive' | 'negative', nodeId: string) => {
    if (!editingCard) return;
    const candidate = editingCard.nodeCandidates.find((c) => c.nodeId === nodeId);
    if (role === 'positive') {
      setEditPosNodeId(nodeId || null);
      if (candidate) {
        setEditPosText(candidate.text);
        setEditPosTags(parsePromptToTagItems(candidate.text));
      }
    } else {
      setEditNegNodeId(nodeId || null);
      if (candidate) {
        setEditNegText(candidate.text);
        setEditNegTags(parsePromptToTagItems(candidate.text));
      }
    }
  };

  const handleResetToExtracted = () => {
    if (!editingCard) return;
    const posCand = editPosNodeId
      ? editingCard.nodeCandidates.find((c) => c.nodeId === editPosNodeId)
      : undefined;
    const negCand = editNegNodeId
      ? editingCard.nodeCandidates.find((c) => c.nodeId === editNegNodeId)
      : undefined;

    const resetPos = posCand?.text ?? editingCard.extractedPositive;
    const resetNeg = negCand?.text ?? editingCard.extractedNegative;

    setEditPosText(resetPos);
    setEditNegText(resetNeg);
    setEditPosTags(parsePromptToTagItems(resetPos));
    setEditNegTags(parsePromptToTagItems(resetNeg));
    setSaveFeedback('已重置为 JSON 原始提取词');
    window.setTimeout(() => setSaveFeedback(null), 1800);
  };

  const buildUpdatedEditingCard = (): WorkflowCollectionCard | null => {
    if (!editingCard) return null;
    return {
      ...editingCard,
      title: editTitle.trim() || editingCard.title,
      tags: parseTagsInput(editTagsInput),
      positiveNodeId: editPosNodeId,
      negativeNodeId: editNegNodeId,
      fineTunedPositive: editPosText.trim(),
      fineTunedNegative: editNegText.trim(),
      applyFineTuneOnSend: editApplyOnSend,
      isPrivate: editIsPrivate,
      seedMode: editSeedMode,
      fixedSeed: editSeedMode === 'fixed' ? editFixedSeed : editingCard.fixedSeed,
      updatedAt: Date.now(),
    };
  };

  const handleSaveToCurrentCard = async () => {
    const updated = buildUpdatedEditingCard();
    if (!updated) return;
    const folderRes = await tryAutoWriteCardToFolder(updated);
    const finalCard = folderRes.written
      ? { ...updated, lastFolderSyncAt: Date.now() }
      : updated;
    const res = commitCards(cards.map((c) => (c.id === finalCard.id ? finalCard : c)));
    if (res.ok) {
      setSaveFeedback(
        folderRes.written
          ? '已保存到当前卡片并同步写入本地文件夹'
          : '已保存到当前卡片'
      );
      window.setTimeout(() => setSaveFeedback(null), 2200);
    }
  };

  const handleSaveAsNewCard = async () => {
    const updated = buildUpdatedEditingCard();
    if (!updated) return;
    const now = Date.now();
    const baseTitle = updated.title;
    const newTitle =
      baseTitle === editingCard?.title ? `${baseTitle} · 微调` : baseTitle;
    let cloned: WorkflowCollectionCard = {
      ...updated,
      id: `wf-card-${now}-${Math.random().toString(36).slice(2, 6)}`,
      title: newTitle,
      lastRunAt: undefined,
      lastPromptId: undefined,
      lastFolderSyncAt: undefined,
      createdAt: now,
      updatedAt: now,
    };
    const folderRes = await tryAutoWriteCardToFolder(cloned);
    if (folderRes.written) {
      cloned = { ...cloned, lastFolderSyncAt: Date.now() };
    }
    const res = commitCards([cloned, ...cards]);
    if (res.ok) {
      setEditingCardId(cloned.id);
      setEditTitle(cloned.title);
      setSaveFeedback(
        folderRes.written
          ? `已另存为新卡片「${cloned.title}」并写入本地文件夹`
          : `已另存为新卡片「${cloned.title}」`
      );
      window.setTimeout(() => setSaveFeedback(null), 2200);
    }
  };

  const handleRunFromDrawer = async () => {
    const updated = buildUpdatedEditingCard();
    if (!updated) return;
    commitCards(cards.map((c) => (c.id === updated.id ? updated : c)));
    await handleRunCard(updated);
  };

  const handleExportCollection = () => {
    const payload = buildCardExportPayload(cards);
    const blob = new Blob([payload], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `chibiprompt-workflow-cards-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleExportPrivateCollection = () => {
    const payload = buildCardExportPayload(cards, { onlyPrivate: true });
    const blob = new Blob([payload], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `chibiprompt-private-workflow-cards-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleImportCollection = async (input: FileList | File[]) => {
    const files = Array.from(input);
    if (files.length === 0) return;

    setIsImportingBatch(true);
    setImportNotice(null);

    const importedJsonCards: WorkflowCollectionCard[] = [];
    const importedPngCards: WorkflowCollectionCard[] = [];
    const skipped: { fileName: string; reason: string }[] = [];

    try {
      for (const file of files) {
        const lower = file.name.toLowerCase();
        if (file.type === 'application/json' || lower.endsWith('.json')) {
          try {
            const text = await file.text();
            const parsed = JSON.parse(text) as unknown;
            const rawArr = Array.isArray(parsed)
              ? parsed
              : parsed &&
                typeof parsed === 'object' &&
                Array.isArray((parsed as Record<string, unknown>).cards)
              ? (parsed as Record<string, unknown>).cards
              : parsed &&
                typeof parsed === 'object' &&
                Array.isArray((parsed as Record<string, unknown>).workflowCards)
              ? (parsed as Record<string, unknown>).workflowCards
              : null;

            if (!rawArr) {
              skipped.push({
                fileName: file.name,
                reason: '未找到有效的收藏卡片列表（需包含 cards 数组）',
              });
              continue;
            }

            const normalized = normalizeWorkflowCards(rawArr);
            if (normalized.length === 0) {
              skipped.push({
                fileName: file.name,
                reason: '卡片数据结构无效或为空',
              });
              continue;
            }
            importedJsonCards.push(...normalized);
          } catch {
            skipped.push({
              fileName: file.name,
              reason: '无法解析收藏集 JSON 文件',
            });
          }
        } else if (file.type === 'image/png' || lower.endsWith('.png')) {
          const pngResult = await buildWorkflowCardFromPngFile(file, {
            isPrivate: privateView,
          });
          if (pngResult.ok) {
            importedPngCards.push(pngResult.card);
          } else {
            skipped.push({
              fileName: pngResult.fileName,
              reason: pngResult.reason,
            });
          }
        } else {
          skipped.push({
            fileName: file.name,
            reason: '仅支持收藏集 .json 或内嵌 ComfyUI 参数的 .png 图片',
          });
        }
      }

      const allImported = [...importedPngCards, ...importedJsonCards];
      if (allImported.length > 0) {
        let cardsToMerge = allImported;
        let folderSyncedCount = 0;
        if (boundDirHandle && dirPermState === 'granted') {
          const { succeededIds } = await writeCardsBatchToLocalDirectory(
            boundDirHandle,
            allImported
          );
          if (succeededIds.length > 0) {
            folderSyncedCount = succeededIds.length;
            const okSet = new Set(succeededIds);
            const syncTime = Date.now();
            cardsToMerge = allImported.map((c) =>
              okSet.has(c.id) ? { ...c, lastFolderSyncAt: syncTime } : c
            );
          }
        }
        const merged = mergeImportedWorkflowCards(cards, cardsToMerge);
        const res = commitCards(merged);
        if (res.ok) {
          const parts: string[] = [];
          if (importedPngCards.length > 0 && importedJsonCards.length > 0) {
            parts.push(
              `已导入 ${allImported.length} 张卡片（PNG ${importedPngCards.length} 张 + JSON ${importedJsonCards.length} 张）`
            );
          } else if (importedPngCards.length > 0) {
            parts.push(
              `已从 ${importedPngCards.length} 张 PNG 自动提取工作流并生成收藏卡片（保留原图不压缩）`
            );
          } else {
            parts.push(`已导入 ${importedJsonCards.length} 张工作流收藏卡片`);
          }

          if (folderSyncedCount > 0 && boundDirHandle) {
            parts.push(`，已同步写入「${boundDirHandle.name}」`);
          }

          const importedPrivateCount = allImported.filter((c) =>
            Boolean(c.isPrivate)
          ).length;
          if (importedPrivateCount > 0 && !privateView) {
            parts.push(
              `（其中 ${importedPrivateCount} 张为私密卡片，已自动归入「私密」区）`
            );
          }

          if (skipped.length > 0) {
            const skipDetail = skipped
              .map((s) => `${s.fileName}（${s.reason}）`)
              .join('、');
            setImportNotice({
              type: 'warn',
              text: `${parts.join('')}；已跳过 ${skipped.length} 个文件：${skipDetail}`,
            });
          } else {
            setImportNotice({
              type: 'ok',
              text: parts.join(''),
            });
          }
        }
      } else {
        const errDetail = skipped
          .map((s) => `${s.fileName}（${s.reason}）`)
          .join('、');
        setImportNotice({
          type: 'err',
          text: errDetail
            ? `导入失败：${errDetail}`
            : '导入失败：未识别到有效的收藏集 JSON 或内嵌工作流的 PNG 图片',
        });
      }
    } finally {
      setIsImportingBatch(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E2028]/35 backdrop-blur-xs p-3 sm:p-5"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        onDragOver={(e) => {
          if (e.dataTransfer.types?.includes('Files')) {
            e.preventDefault();
            setIsBatchDragging(true);
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setIsBatchDragging(false);
          }
        }}
        onDrop={(e) => {
          if (e.dataTransfer.files?.length) {
            e.preventDefault();
            setIsBatchDragging(false);
            void handleImportCollection(e.dataTransfer.files);
          }
        }}
        className={`relative w-full max-w-[1280px] h-[90vh] flex flex-col rounded-[16px] bg-[#F4F4F7] border shadow-[0_24px_60px_rgba(18,22,33,0.18)] overflow-hidden transition-colors ${
          isBatchDragging ? 'border-[#7C5CFC] ring-2 ring-[#7C5CFC]/25' : 'border-[#E0E0E6]'
        }`}
      >
        {/* 顶栏 */}
        <header className="shrink-0 h-[56px] px-5 bg-white border-b border-[#E0E0E6] flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-8 h-8 rounded-[10px] bg-[#F4F2FF] border border-[#DDD8FA] flex items-center justify-center text-[#6B48F5] shrink-0">
              <Layers className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-[14.5px] font-bold text-[#1E2028] truncate">
                  参考图与工作流收藏工作台
                </h2>
                <span className="text-[11.5px] text-[#686E7E] tabular-nums whitespace-nowrap">
                  {privateView
                    ? `· 私密区 ${privateCards.length} 张卡片`
                    : `· ${publicCards.length} 张卡片`}
                </span>
              </div>
              <p className="text-[11px] text-[#8E94A4] truncate">
                独立工作流库 · 不影响角色槽位与可爱预设快填 · 目标 ComfyUI: {comfyUrl || '未配置'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => void handleSelectLocalFolder()}
              title={
                boundDirHandle
                  ? `当前已绑定本地文件夹：${boundDirHandle.name}（点击更换绑定文件夹）`
                  : '选择并绑定本地文件夹，将未压缩原图与工作流 JSON 直接落盘写入本地'
              }
              className={`h-8 px-2.5 inline-flex items-center gap-1.5 text-[11.5px] font-medium rounded-[10px] border transition-colors whitespace-nowrap cursor-pointer ${
                boundDirHandle && dirPermState === 'granted'
                  ? 'border-emerald-300 bg-emerald-50/90 text-emerald-800 hover:border-emerald-400'
                  : boundDirHandle
                  ? 'border-amber-300 bg-amber-50/90 text-amber-800 hover:border-amber-400'
                  : 'border-[#E0E0E6] bg-white text-[#4C5264] hover:border-[#7C5CFC]/50 hover:text-[#6B48F5]'
              }`}
            >
              {boundDirHandle && dirPermState === 'granted' ? (
                <FolderCheck className="w-3.5 h-3.5 shrink-0 text-emerald-600" />
              ) : (
                <FolderOpen className="w-3.5 h-3.5 shrink-0" />
              )}
              <span className="max-w-[130px] truncate">
                {boundDirHandle ? `文件夹: ${boundDirHandle.name}` : '选择本地文件夹'}
              </span>
            </button>

            <button
              type="button"
              onClick={() => {
                setPrivateView((prev) => !prev);
                setActiveTagFilter('ALL');
                setLightboxCardId(null);
              }}
              title={
                privateView
                  ? '退出个人私密视图，返回公开收藏卡片'
                  : '切换进入个人私密区（常规筛选与默认导出自动隐藏私密卡片）'
              }
              className={`h-8 px-2.5 inline-flex items-center gap-1.5 text-[11.5px] font-medium rounded-[10px] border transition-colors whitespace-nowrap cursor-pointer ${
                privateView
                  ? 'border-[#E85D75] bg-[#FFF1F3] text-[#C93B58]'
                  : 'border-[#E0E0E6] bg-white text-[#4C5264] hover:border-[#E85D75]/50 hover:text-[#C93B58]'
              }`}
            >
              {privateView ? (
                <Eye className="w-3.5 h-3.5" />
              ) : (
                <EyeOff className="w-3.5 h-3.5" />
              )}
              <span>{privateView ? '退出私密' : '私密'}</span>
              {privateCards.length > 0 && (
                <span className="font-mono text-[10.5px] tabular-nums opacity-85">
                  ({privateCards.length})
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => {
                setCreatePanelOpen((v) => {
                  const next = !v;
                  if (next && !draft.rawWorkflowJson && !draft.thumbnailDataUrl) {
                    setDraft((prev) => ({ ...prev, isPrivate: privateView }));
                  }
                  return next;
                });
              }}
              className={`h-8 px-3 inline-flex items-center gap-1.5 text-[12px] font-medium rounded-[10px] border transition-colors whitespace-nowrap cursor-pointer ${
                createPanelOpen
                  ? 'border-[#7C5CFC] bg-[#F4F2FF] text-[#6B48F5]'
                  : 'border-[#E0E0E6] bg-white text-[#4C5264] hover:border-[#7C5CFC]/50 hover:text-[#6B48F5]'
              }`}
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{createPanelOpen ? '收起导入建卡' : '导入图片 + JSON 建卡'}</span>
            </button>

            <input
              ref={collectionImportRef}
              type="file"
              accept=".json,application/json,.png,image/png"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) {
                  void handleImportCollection(e.target.files);
                }
                e.target.value = '';
              }}
            />
            <button
              type="button"
              disabled={isImportingBatch}
              onClick={() => collectionImportRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setIsBatchDragging(true);
              }}
              onDragLeave={() => setIsBatchDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setIsBatchDragging(false);
                if (e.dataTransfer.files?.length) {
                  void handleImportCollection(e.dataTransfer.files);
                }
              }}
              title="支持导入收藏集 .json，或单张/多张内嵌 ComfyUI prompt / workflow 元数据的 PNG 图片（支持多选与拖入）"
              className={`h-8 px-2.5 inline-flex items-center gap-1 text-[11.5px] font-medium rounded-[10px] border transition-colors whitespace-nowrap cursor-pointer disabled:opacity-50 ${
                isBatchDragging
                  ? 'border-[#7C5CFC] bg-[#F4F2FF] text-[#6B48F5]'
                  : 'border-[#E0E0E6] bg-white text-[#4C5264] hover:border-[#7C5CFC]/40 hover:text-[#7C5CFC]'
              }`}
            >
              {isImportingBatch ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Upload className="w-3.5 h-3.5" />
              )}
              <span>{isImportingBatch ? '导入中...' : '导入集'}</span>
            </button>

            <button
              type="button"
              onClick={handleExportCollection}
              disabled={publicCards.length === 0}
              title="导出公开收藏集（默认自动排除私密卡片）"
              className="h-8 px-2.5 inline-flex items-center gap-1 text-[11.5px] font-medium rounded-[10px] border border-[#E0E0E6] bg-white text-[#4C5264] hover:border-[#7C5CFC]/40 hover:text-[#7C5CFC] disabled:opacity-40 transition-colors whitespace-nowrap cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              <span>导出集</span>
            </button>

            <button
              type="button"
              onClick={onClose}
              aria-label="关闭收藏工作台"
              className="h-8 w-8 inline-flex items-center justify-center rounded-[10px] border border-[#E0E0E6] bg-white text-[#5A6072] hover:text-[#1E2028] transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </header>

        {/* 主体区 */}
        <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-5 space-y-4">
          {/* 本地文件夹绑定状态与同步条 */}
          {(boundDirHandle || folderNotice || !fsApiSupported) && (
            <div
              className={`rounded-[12px] border px-4 py-2.5 flex flex-wrap items-center justify-between gap-2.5 text-[12px] ${
                folderNotice?.type === 'err'
                  ? 'border-[#F8C8D2] bg-[#FFF1F3] text-[#B42343]'
                  : folderNotice?.type === 'warn' || (boundDirHandle && dirPermState !== 'granted')
                  ? 'border-amber-200 bg-amber-50/90 text-amber-900'
                  : boundDirHandle
                  ? 'border-emerald-200 bg-emerald-50/90 text-emerald-900'
                  : 'border-[#E0E0E6] bg-white text-[#4C5264]'
              }`}
            >
              <div className="flex items-center gap-2 min-w-0 flex-1">
                {boundDirHandle && dirPermState === 'granted' ? (
                  <FolderCheck className="w-4 h-4 shrink-0 text-emerald-600" />
                ) : (
                  <FolderOpen className="w-4 h-4 shrink-0 opacity-80" />
                )}
                <div className="min-w-0 flex-1">
                  {folderNotice ? (
                    <span className="break-words">{folderNotice.text}</span>
                  ) : boundDirHandle ? (
                    <span>
                      已绑定本地文件夹 <strong className="font-semibold">「{boundDirHandle.name}」</strong>
                      {dirPermState === 'granted'
                        ? '（读写已授权 · 建卡/微调保存自动落盘未压缩原图与 JSON）'
                        : '（页面刷新后需点击右侧「授权写入」恢复磁盘写入权限）'}
                    </span>
                  ) : (
                    <span>
                      当前浏览器环境暂不支持直接写入本地磁盘文件夹，已自动使用 IndexedDB 浏览器存储保留原图并支持「导出集 / 单卡下载」。
                    </span>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                {boundDirHandle && dirPermState !== 'granted' && (
                  <button
                    type="button"
                    onClick={() => void handleReauthorizeLocalFolder()}
                    className="h-7 px-2.5 rounded-[8px] border border-amber-300 bg-white text-[11.5px] font-medium text-amber-800 hover:bg-amber-50 cursor-pointer whitespace-nowrap"
                  >
                    授权写入
                  </button>
                )}
                {boundDirHandle && (
                  <button
                    type="button"
                    disabled={isSyncingFolder || scopedCards.length === 0}
                    onClick={() => void handleSyncScopedCardsToFolder()}
                    className="h-7 px-2.5 inline-flex items-center gap-1 rounded-[8px] border border-emerald-300 bg-white text-[11.5px] font-medium text-emerald-800 hover:bg-emerald-50 disabled:opacity-45 cursor-pointer whitespace-nowrap"
                  >
                    {isSyncingFolder ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <FolderSync className="w-3.5 h-3.5" />
                    )}
                    <span>
                      {isSyncingFolder
                        ? '写入中...'
                        : `同步${privateView ? '私密' : '公开'}卡片 (${scopedCards.length})`}
                    </span>
                  </button>
                )}
                {boundDirHandle && (
                  <button
                    type="button"
                    onClick={() => void handleUnbindLocalFolder()}
                    className="h-7 px-2 rounded-[8px] border border-[#E0E0E6] bg-white text-[11px] text-[#686E7E] hover:text-[#1E2028] cursor-pointer whitespace-nowrap"
                  >
                    解绑
                  </button>
                )}
                {folderNotice && (
                  <button
                    type="button"
                    onClick={() => setFolderNotice(null)}
                    aria-label="关闭文件夹提示"
                    className="p-0.5 opacity-70 hover:opacity-100 cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
          )}

          {/* 个人私密区提示与专属导出条 */}
          {privateView && (
            <div className="rounded-[12px] border border-[#F5B8C4] bg-[#FFF5F7] px-4 py-2.5 flex flex-wrap items-center justify-between gap-2.5">
              <div className="flex items-center gap-2 min-w-0 text-[12px] text-[#9E2440]">
                <EyeOff className="w-4 h-4 shrink-0 text-[#E85D75]" />
                <span className="font-semibold whitespace-nowrap">
                  个人私密区 ({privateCards.length})
                </span>
                <span className="text-[11.5px] text-[#B42343]/90 truncate">
                  仅在此视图展示；常规筛选与顶部「导出集 / 导出」均默认排除私密卡片
                </span>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={handleExportPrivateCollection}
                  disabled={privateCards.length === 0}
                  className="h-7 px-2.5 inline-flex items-center gap-1 rounded-[8px] border border-[#F5B8C4] bg-white text-[11.5px] font-medium text-[#C93B58] hover:border-[#E85D75] disabled:opacity-40 cursor-pointer whitespace-nowrap"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>导出私密卡片</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPrivateView(false);
                    setActiveTagFilter('ALL');
                    setLightboxCardId(null);
                  }}
                  className="h-7 px-2.5 rounded-[8px] border border-[#E0E0E6] bg-white text-[11.5px] font-medium text-[#4C5264] hover:text-[#1E2028] cursor-pointer whitespace-nowrap"
                >
                  返回公开列表
                </button>
              </div>
            </div>
          )}
          {/* 批量拖入提示条 */}
          {isBatchDragging && !isDragging && (
            <div className="rounded-[12px] border-2 border-dashed border-[#7C5CFC] bg-[#F4F2FF] px-4 py-3 text-center text-[12px] font-medium text-[#5B3DF5]">
              松开即可通过「导入集」批量导入含 ComfyUI 参数的 PNG 图片或收藏集 .json
            </div>
          )}

          {/* 导入反馈条（折叠建卡面板时依然可见） */}
          {!createPanelOpen && importNotice && (
            <div
              role="status"
              className={`rounded-[12px] border px-4 py-2.5 flex items-center justify-between gap-2 text-[12px] ${
                importNotice.type === 'err'
                  ? 'border-[#F8C8D2] bg-[#FFF1F3] text-[#B42343]'
                  : importNotice.type === 'warn'
                  ? 'border-amber-200 bg-amber-50/90 text-amber-800'
                  : 'border-emerald-200 bg-emerald-50/90 text-emerald-900'
              }`}
            >
              <div className="flex items-center gap-2 min-w-0">
                {importNotice.type === 'err' || importNotice.type === 'warn' ? (
                  <AlertCircle className="w-4 h-4 shrink-0" />
                ) : (
                  <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600" />
                )}
                <span className="break-words">{importNotice.text}</span>
              </div>
              <button
                type="button"
                onClick={() => setImportNotice(null)}
                aria-label="关闭导入提示"
                className="p-0.5 opacity-70 hover:opacity-100 cursor-pointer shrink-0"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* 存储容量警告 */}
          {storageWarning && (
            <div className="rounded-[12px] border border-[#F8C8D2] bg-[#FFF1F3] px-4 py-2.5 flex items-center justify-between gap-2 text-[12px] text-[#B42343]">
              <div className="flex items-center gap-2 min-w-0">
                <AlertCircle className="w-4 h-4 shrink-0 text-[#E85D75]" />
                <span className="truncate">{storageWarning}</span>
              </div>
              <button
                type="button"
                onClick={() => setStorageWarning(null)}
                className="text-[#B42343] hover:opacity-75 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* 全局运行反馈条 */}
          {runStatus.state !== 'idle' && (
            <div
              role="status"
              className={`rounded-[12px] border px-4 py-3 flex flex-wrap items-center justify-between gap-3 ${
                runStatus.state === 'success'
                  ? 'bg-emerald-50/90 border-emerald-200 text-emerald-900'
                  : runStatus.state === 'error'
                  ? 'bg-[#FFF1F3] border-[#F8C8D2] text-[#B42343]'
                  : 'bg-[#F4F2FF] border-[#DDD6FE] text-[#5B3DF5]'
              }`}
            >
              <div className="flex items-center gap-2.5 min-w-0">
                {runStatus.state === 'sending' && (
                  <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                )}
                {runStatus.state === 'success' && (
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                )}
                {runStatus.state === 'error' && (
                  <AlertCircle className="w-4 h-4 text-[#E85D75] shrink-0" />
                )}
                <div className="min-w-0 text-[12px]">
                  <span className="font-semibold">
                    {runStatus.cardTitle}：
                  </span>
                  <span className="break-words">{runStatus.message}</span>
                  {runStatus.promptId && (
                    <span className="ml-2 font-mono text-[11px] text-emerald-700 tabular-nums">
                      ID: {runStatus.promptId.slice(0, 10)}
                      {runStatus.usedSeed !== undefined ? ` · Seed: ${runStatus.usedSeed}` : ''}
                      {' · '}
                      {runStatus.timestamp}
                    </span>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {runStatus.state === 'error' && runStatus.canRetryWithProfile && runStatus.cardId && (
                  <button
                    type="button"
                    onClick={() => {
                      const target = cards.find((c) => c.id === runStatus.cardId);
                      if (target) void handleRunCard(target, true);
                    }}
                    className="h-7 px-2.5 rounded-[8px] border border-[#E85D75]/40 bg-white text-[11px] font-medium text-[#B42343] hover:bg-[#FFF5F7] cursor-pointer whitespace-nowrap"
                  >
                    改用当前 Studio 方案发送提示词
                  </button>
                )}
                {runStatus.state === 'error' && (
                  <button
                    type="button"
                    onClick={onOpenSettings}
                    className="h-7 px-2.5 rounded-[8px] border border-[#E0E0E6] bg-white text-[11px] font-medium text-[#4C5264] hover:text-[#7C5CFC] cursor-pointer whitespace-nowrap"
                  >
                    检查 ComfyUI 设置
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setRunStatus({ state: 'idle' })}
                  className="p-1 opacity-70 hover:opacity-100 cursor-pointer"
                  aria-label="关闭队列提示"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}

          {/* 导入建卡区 */}
          {createPanelOpen && (
            <section className="rounded-[14px] bg-white border border-[#E0E0E6] p-4 space-y-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-[13px] font-semibold text-[#1E2028]">
                    新建收藏卡片（参考图 + ComfyUI 工作流 JSON）
                  </h3>
                  <p className="text-[11.5px] text-[#686E7E]">
                    支持同时拖入 1 张参考图与 1 个 .json 工作流；若仅拖入含 ComfyUI 元数据的 PNG，将自动尝试提取内置工作流与提示词。
                  </p>
                </div>
                {(draft.thumbnailDataUrl || draft.rawWorkflowJson || draft.extractedPositive) && (
                  <button
                    type="button"
                    onClick={() => {
                      setDraft(EMPTY_DRAFT);
                      setImportNotice(null);
                    }}
                    className="h-7 px-2.5 text-[11px] font-medium rounded-[8px] border border-[#E0E0E6] text-[#686E7E] hover:text-[#1E2028] cursor-pointer whitespace-nowrap"
                  >
                    清空当前草稿
                  </button>
                )}
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
                {/* 拖拽/选择文件区 */}
                <div
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setIsDragging(true);
                    setIsBatchDragging(false);
                  }}
                  onDragLeave={() => setIsDragging(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setIsDragging(false);
                    setIsBatchDragging(false);
                    if (e.dataTransfer.files?.length) {
                      void handleFilesIngest(e.dataTransfer.files);
                    }
                  }}
                  className={`lg:col-span-5 rounded-[12px] border-2 border-dashed p-4 flex flex-col justify-between gap-3 transition-colors ${
                    isDragging
                      ? 'border-[#7C5CFC] bg-[#F4F2FF]'
                      : 'border-[#D7D7E2] bg-[#FAFAFC]'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    {draft.thumbnailDataUrl ? (
                      <img
                        src={draft.thumbnailDataUrl}
                        alt={draft.title || '参考图预览'}
                        referrerPolicy="no-referrer"
                        className="w-20 h-20 rounded-[10px] object-cover border border-[#E0E0E6] bg-white shrink-0"
                      />
                    ) : (
                      <div className="w-20 h-20 rounded-[10px] border border-[#E0E0E6] bg-white flex flex-col items-center justify-center text-[#949AA8] shrink-0">
                        <ImagePlus className="w-5 h-5 mb-1" />
                        <span className="text-[10px]">待选图</span>
                      </div>
                    )}

                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="text-[12px] font-medium text-[#1E2028]">
                        拖入 PNG / JPG / WebP 与 .json
                      </div>
                      <div className="text-[11px] text-[#686E7E] space-y-0.5">
                        <div className="truncate">
                          参考图：
                          {draft.imageName
                            ? `${draft.imageName}${
                                draft.originalImageWidth && draft.originalImageHeight
                                  ? ` (${draft.originalImageWidth}×${draft.originalImageHeight} 原图无损)`
                                  : ' (原图不压缩)'
                              }`
                            : '未选择（保留原图不压缩）'}
                        </div>
                        <div className="truncate">
                          工作流：{draft.workflowFileName || '未导入'}
                          {draft.workflowFormat !== 'unknown'
                            ? ` · ${formatFormatLabel(draft.workflowFormat)}`
                            : ''}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      ref={imageInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
                      className="hidden"
                      onChange={(e) => {
                        if (e.target.files?.length) void handleFilesIngest(e.target.files);
                        e.target.value = '';
                      }}
                    />
                    <input
                      ref={jsonInputRef}
                      type="file"
                      accept=".json,application/json"
                      className="hidden"
                      onChange={(e) => {
                        if (e.target.files?.length) void handleFilesIngest(e.target.files);
                        e.target.value = '';
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => imageInputRef.current?.click()}
                      className="h-8 px-3 inline-flex items-center gap-1.5 text-[11.5px] font-medium rounded-[9px] border border-[#E0E0E6] bg-white text-[#4C5264] hover:border-[#7C5CFC]/50 hover:text-[#7C5CFC] cursor-pointer whitespace-nowrap"
                    >
                      <ImagePlus className="w-3.5 h-3.5" />
                      <span>选择参考图</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => jsonInputRef.current?.click()}
                      className="h-8 px-3 inline-flex items-center gap-1.5 text-[11.5px] font-medium rounded-[9px] border border-[#E0E0E6] bg-white text-[#4C5264] hover:border-[#7C5CFC]/50 hover:text-[#7C5CFC] cursor-pointer whitespace-nowrap"
                    >
                      <FileJson className="w-3.5 h-3.5" />
                      <span>选择工作流 .json</span>
                    </button>
                  </div>
                </div>

                {/* 元数据与预览 */}
                <div className="lg:col-span-7 flex flex-col justify-between gap-3">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <label className="space-y-1">
                      <span className="block text-[11.5px] font-medium text-[#4C5264]">
                        卡片名称（title）
                      </span>
                      <input
                        type="text"
                        value={draft.title}
                        onChange={(e) =>
                          setDraft((prev) => ({ ...prev, title: e.target.value }))
                        }
                        placeholder="例：蓝 · 草莓洛丽塔街拍"
                        className="w-full h-9 px-3 rounded-[9px] border border-[#E0E0E6] bg-white text-[12.5px] text-[#1E2028] focus:outline-none focus:border-[#7C5CFC]"
                      />
                    </label>

                    <label className="space-y-1">
                      <span className="block text-[11.5px] font-medium text-[#4C5264]">
                        分类标签（tags，逗号或空格分隔）
                      </span>
                      <input
                        type="text"
                        value={draft.tagsInput}
                        onChange={(e) =>
                          setDraft((prev) => ({ ...prev, tagsInput: e.target.value }))
                        }
                        placeholder="例：蓝, 甜美, Anima"
                        className="w-full h-9 px-3 rounded-[9px] border border-[#E0E0E6] bg-white text-[12.5px] text-[#1E2028] focus:outline-none focus:border-[#7C5CFC]"
                      />
                    </label>
                  </div>

                  <div className="rounded-[10px] border border-[#EAEAEF] bg-[#FAFAFC] p-3 text-[11px] space-y-1">
                    <div className="flex items-center justify-between text-[#686E7E]">
                      <span className="font-medium">自动提取提示词摘要</span>
                      <span className="tabular-nums">
                        检测到 {draft.nodeCandidates.length} 个节点
                      </span>
                    </div>
                    <p className="font-mono text-[#373C4B] line-clamp-2 break-words">
                      <span className="text-[#6B48F5] font-sans font-medium mr-1">正向:</span>
                      {draft.extractedPositive || '（导入 JSON 或含元数据 PNG 后自动显示）'}
                    </p>
                    <p className="font-mono text-[#686E7E] line-clamp-1 break-words">
                      <span className="text-[#E85D75] font-sans font-medium mr-1">负向:</span>
                      {draft.extractedNegative || '（未检测到负向节点或为空）'}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-[11.5px] min-w-0 flex-1">
                      {importNotice && (
                        <span
                          className={
                            importNotice.type === 'err'
                              ? 'text-[#B42343]'
                              : importNotice.type === 'warn'
                              ? 'text-amber-700'
                              : 'text-emerald-700'
                          }
                        >
                          {importNotice.text}
                        </span>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-3 shrink-0">
                      <label
                        title="设为私密后，该卡片在常规列表中隐藏，且默认「导出集 / 导出」不会包含它"
                        className="inline-flex items-center gap-1.5 text-[12px] text-[#4C5264] cursor-pointer select-none whitespace-nowrap"
                      >
                        <input
                          type="checkbox"
                          checked={draft.isPrivate}
                          onChange={(e) =>
                            setDraft((prev) => ({ ...prev, isPrivate: e.target.checked }))
                          }
                          className="w-3.5 h-3.5 accent-[#E85D75]"
                        />
                        <span>设为私密</span>
                      </label>

                      <button
                        type="button"
                        onClick={() => void handleSaveNewCard()}
                        className="h-9 px-4 inline-flex items-center gap-1.5 text-[12.5px] font-medium rounded-[10px] bg-gradient-to-b from-[#8A6CFF] to-[#7C5CFC] text-white shadow-[0_2px_8px_rgba(124,92,252,0.24)] hover:brightness-105 cursor-pointer whitespace-nowrap shrink-0"
                      >
                        <Save className="w-3.5 h-3.5" />
                        <span>保存为收藏卡片</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          )}

          {/* 搜索与标签筛选栏 */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2 flex-1 min-w-[240px]">
              <div className="relative w-full sm:w-[260px]">
                <Search className="w-3.5 h-3.5 text-[#949AA8] absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="搜索卡片名称、标签或提示词..."
                  className="w-full h-8 pl-8 pr-3 rounded-[9px] border border-[#E0E0E6] bg-white text-[12px] text-[#1E2028] focus:outline-none focus:border-[#7C5CFC]"
                />
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setActiveTagFilter('ALL')}
                  className={`h-7 px-2.5 rounded-[8px] text-[11.5px] font-medium border transition-colors cursor-pointer whitespace-nowrap ${
                    activeTagFilter === 'ALL'
                      ? 'border-[#7C5CFC] bg-[#F4F2FF] text-[#6B48F5]'
                      : 'border-[#E0E0E6] bg-white text-[#686E7E] hover:text-[#1E2028]'
                  }`}
                >
                  全部 ({scopedCards.length})
                </button>
                {allCategoryTags.map(([tag, count]) => (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => setActiveTagFilter(tag)}
                    className={`h-7 px-2.5 rounded-[8px] text-[11.5px] font-medium border transition-colors cursor-pointer whitespace-nowrap tabular-nums ${
                      activeTagFilter === tag
                        ? 'border-[#7C5CFC] bg-[#F4F2FF] text-[#6B48F5]'
                        : 'border-[#E0E0E6] bg-white text-[#686E7E] hover:text-[#1E2028]'
                    }`}
                  >
                    {tag} ({count})
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-1.5 text-[11.5px]">
                <Lock className="w-3.5 h-3.5 text-[#6B48F5] shrink-0" />
                <span className="text-[#4C5264] whitespace-nowrap">Seed:</span>
                <select
                  aria-label="工作台 Seed 模式"
                  value={workbenchSeedOverride}
                  onChange={(e) =>
                    setWorkbenchSeedOverride(e.target.value as 'card' | 'fixed' | 'random')
                  }
                  className="h-7 px-2 rounded-[7px] border border-[#E0E0E6] bg-white text-[11.5px] text-[#1E2028] focus:outline-none focus:border-[#7C5CFC]"
                >
                  <option value="card">跟随卡片（默认固定不随机）</option>
                  <option value="fixed">统一固定 Seed</option>
                  <option value="random">每次运行随机 Seed</option>
                </select>
                {workbenchSeedOverride === 'fixed' && (
                  <>
                    <input
                      type="number"
                      min={0}
                      value={workbenchFixedSeed}
                      onChange={(e) => {
                        const v = parseInt(e.target.value, 10);
                        setWorkbenchFixedSeed(Number.isFinite(v) && v >= 0 ? v : 0);
                      }}
                      className="w-[130px] h-7 px-2 rounded-[7px] border border-[#E0E0E6] bg-white text-[11px] font-mono tabular-nums text-[#1E2028] focus:outline-none focus:border-[#7C5CFC]"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setWorkbenchFixedSeed(Math.floor(Math.random() * 2147483647))
                      }
                      title="随机换一个固定 Seed"
                      className="h-7 px-2 rounded-[7px] border border-[#E0E0E6] bg-white text-[#686E7E] hover:text-[#6B48F5] cursor-pointer"
                    >
                      <Dices className="w-3.5 h-3.5" />
                    </button>
                  </>
                )}
              </div>

              <label
                title="开启后直接将卡片内微调过的提示词注入当前 Studio 设置的 ComfyUI 模型方案发送"
                className="inline-flex items-center gap-1.5 text-[11.5px] text-[#4C5264] cursor-pointer select-none whitespace-nowrap"
              >
                <input
                  type="checkbox"
                  checked={preferStudioProfile}
                  onChange={(e) => setPreferStudioProfile(e.target.checked)}
                  className="w-3.5 h-3.5 accent-[#7C5CFC]"
                />
                <span>固定使用当前 Studio 模型方案</span>
              </label>
            </div>
          </div>

          {/* 收藏卡片网格 */}
          {filteredCards.length === 0 ? (
            <div className="rounded-[14px] bg-white border border-[#E0E0E6] py-12 px-6 text-center space-y-3">
              <div className="w-11 h-11 rounded-[12px] bg-[#F4F2FF] text-[#7C5CFC] mx-auto flex items-center justify-center">
                {privateView ? <EyeOff className="w-5 h-5 text-[#E85D75]" /> : <Sparkles className="w-5 h-5" />}
              </div>
              <div className="space-y-1">
                <h4 className="text-[14px] font-semibold text-[#1E2028]">
                  {scopedCards.length === 0
                    ? privateView
                      ? '私密区暂无工作流卡片'
                      : '暂无公开收藏的工作流卡片'
                    : '当前筛选条件下没有匹配的卡片'}
                </h4>
                <p className="text-[12px] text-[#686E7E] max-w-[460px] mx-auto">
                  {scopedCards.length === 0
                    ? privateView
                      ? '你可以在导入建卡时勾选「设为私密」，或在公开卡片右上角一键「设为私密」移入此处。'
                      : '点击上方「导入图片 + JSON 建卡」，拖入 1 张参考图和对应的 ComfyUI .json 文件，即可快速管理、可视化微调 Tag 并一键发送到 ComfyUI。'
                    : '尝试清空搜索关键词或切回「全部」分类标签。'}
                </p>
              </div>
              {scopedCards.length === 0 && !createPanelOpen && (
                <button
                  type="button"
                  onClick={() => {
                    setDraft((prev) => ({ ...prev, isPrivate: privateView }));
                    setCreatePanelOpen(true);
                  }}
                  className="h-8 px-4 inline-flex items-center gap-1.5 text-[12px] font-medium rounded-[9px] bg-[#7C5CFC] text-white cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>{privateView ? '新建私密卡片' : '导入第一张卡片'}</span>
                </button>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3.5">
              {filteredCards.map((card) => {
                const isSendingThis =
                  runStatus.state === 'sending' && runStatus.cardId === card.id;
                const posDisplay = card.applyFineTuneOnSend
                  ? card.fineTunedPositive
                  : card.extractedPositive;
                const negDisplay = card.applyFineTuneOnSend
                  ? card.fineTunedNegative
                  : card.extractedNegative;
                const hasModified =
                  card.fineTunedPositive.trim() !== card.extractedPositive.trim() ||
                  card.fineTunedNegative.trim() !== card.extractedNegative.trim();

                return (
                  <article
                    key={card.id}
                    className="rounded-[14px] bg-white border border-[#E0E0E6] overflow-hidden flex flex-col hover:border-[#7C5CFC]/45 transition-colors"
                  >
                    {/* 缩略图与头部 */}
                    <div className="flex gap-3 p-3.5 border-b border-[#EAEAEF]">
                      {card.originalImageDataUrl || card.thumbnailDataUrl ? (
                        <button
                          type="button"
                          onClick={() => setLightboxCardId(card.id)}
                          title="点击查看大图（保留原图画质）"
                          className="group relative w-[84px] h-[104px] rounded-[9px] overflow-hidden border border-[#E0E0E6] bg-[#FAFAFC] shrink-0 cursor-zoom-in focus:outline-none focus:ring-2 focus:ring-[#7C5CFC]/50"
                        >
                          <img
                            src={card.originalImageDataUrl || card.thumbnailDataUrl}
                            alt={card.title}
                            referrerPolicy="no-referrer"
                            className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-105"
                          />
                          <span className="absolute right-1 bottom-1 w-5 h-5 rounded-md bg-black/55 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                            <ZoomIn className="w-3 h-3" />
                          </span>
                        </button>
                      ) : (
                        <div className="w-[84px] h-[104px] rounded-[9px] border border-[#E0E0E6] bg-[#FAFAFC] flex flex-col items-center justify-center text-[#949AA8] shrink-0">
                          <FileJson className="w-5 h-5 mb-1" />
                          <span className="text-[10px]">纯 JSON</span>
                        </div>
                      )}

                      <div className="min-w-0 flex-1 flex flex-col justify-between">
                        <div className="space-y-1">
                          <div className="flex items-start justify-between gap-2">
                            <h4 className="text-[13.5px] font-semibold text-[#1E2028] leading-snug line-clamp-2">
                              {card.title}
                            </h4>
                            <div className="flex items-center gap-1 shrink-0">
                              <button
                                type="button"
                                onClick={() => handleToggleCardPrivate(card.id)}
                                title={card.isPrivate ? '取消私密并移回公开列表' : '设为私密（移入私密区）'}
                                className={`h-6 px-1.5 inline-flex items-center gap-1 rounded-[6px] border text-[10.5px] font-medium transition-colors cursor-pointer whitespace-nowrap ${
                                  card.isPrivate
                                    ? 'border-[#F5B8C4] bg-[#FFF1F3] text-[#C93B58] hover:border-[#E85D75]'
                                    : 'border-[#E0E0E6] bg-white text-[#686E7E] hover:border-[#E85D75]/50 hover:text-[#C93B58]'
                                }`}
                              >
                                {card.isPrivate ? (
                                  <Eye className="w-3 h-3" />
                                ) : (
                                  <EyeOff className="w-3 h-3" />
                                )}
                                <span>{card.isPrivate ? '取消私密' : '设为私密'}</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDownloadCardJson(card)}
                                title="下载卡片工作流 JSON"
                                className="p-1 text-[#949AA8] hover:text-[#7C5CFC] cursor-pointer"
                              >
                                <Download className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDeleteCard(card.id)}
                                title="删除此卡片"
                                className="p-1 text-[#949AA8] hover:text-[#E85D75] cursor-pointer"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>

                          <div className="text-[11px] text-[#686E7E] truncate">
                            {card.tags.length > 0 ? card.tags.join(' · ') : '未分类'}
                          </div>
                        </div>

                        <div className="text-[10.5px] text-[#8E94A4] font-mono tabular-nums flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          <span>{formatFormatLabel(card.workflowFormat)}</span>
                          {hasModified && (
                            <span className="text-[#6B48F5] font-sans font-medium">
                              · 已微调
                            </span>
                          )}
                          {card.lastPromptId && (
                            <span className="text-emerald-600">
                              · #{card.lastPromptId.slice(0, 6)}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* 可点击唤出微调的提示词摘要区 */}
                    <button
                      type="button"
                      onClick={() => openFineTuner(card, 'positive')}
                      title="点击唤出可视化 Tag 微调面板"
                      className="flex-1 px-3.5 py-2.5 text-left bg-[#FAFAFC] hover:bg-[#F5F3FF]/60 transition-colors cursor-pointer space-y-1.5"
                    >
                      <div className="text-[11px] text-[#373C4B] font-mono line-clamp-2 break-words leading-relaxed">
                        <span className="font-sans font-semibold text-[#6B48F5] mr-1">
                          Pos:
                        </span>
                        {posDisplay || '（空）'}
                      </div>
                      <div className="text-[11px] text-[#686E7E] font-mono line-clamp-1 break-words">
                        <span className="font-sans font-semibold text-[#E85D75] mr-1">
                          Neg:
                        </span>
                        {negDisplay || '（空）'}
                      </div>
                    </button>

                    {/* 卡片底部操作栏 */}
                    <div className="px-3.5 py-2.5 bg-white border-t border-[#EAEAEF] flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => openFineTuner(card, 'positive')}
                        className="flex-1 h-8 px-2.5 inline-flex items-center justify-center gap-1.5 text-[11.5px] font-medium rounded-[9px] border border-[#E0E0E6] bg-white text-[#4C5264] hover:border-[#7C5CFC]/50 hover:text-[#6B48F5] transition-colors whitespace-nowrap cursor-pointer"
                      >
                        <SlidersHorizontal className="w-3.5 h-3.5" />
                        <span>微调提示词</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => void handleRunCard(card)}
                        disabled={isSendingThis}
                        className="flex-1 h-8 px-2.5 inline-flex items-center justify-center gap-1.5 text-[11.5px] font-medium rounded-[9px] bg-gradient-to-b from-[#8A6CFF] to-[#7C5CFC] text-white shadow-[0_2px_6px_rgba(124,92,252,0.24)] hover:brightness-105 disabled:opacity-50 transition-all whitespace-nowrap cursor-pointer"
                      >
                        {isSendingThis ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Play className="w-3.5 h-3.5" />
                        )}
                        <span>{isSendingThis ? '发送中...' : '运行发送 UI'}</span>
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>

        {/* 右侧可视化微调抽屉 */}
        {editingCard && (
          <div
            className="absolute inset-0 z-20 flex justify-end bg-[#1E2028]/25 backdrop-blur-[1px]"
            onClick={(e) => {
              if (e.target === e.currentTarget) setEditingCardId(null);
            }}
          >
            <aside className="w-full max-w-[760px] h-full bg-white border-l border-[#E0E0E6] shadow-[-16px_0_40px_rgba(18,22,33,0.14)] flex flex-col">
              {/* 抽屉头 */}
              <div className="shrink-0 px-5 py-3.5 border-b border-[#EAEAEF] flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  {editingCard.originalImageDataUrl || editingCard.thumbnailDataUrl ? (
                    <button
                      type="button"
                      onClick={() => setLightboxCardId(editingCard.id)}
                      title="点击查看大图"
                      className="shrink-0 rounded-[8px] overflow-hidden border border-[#E0E0E6] cursor-zoom-in"
                    >
                      <img
                        src={editingCard.originalImageDataUrl || editingCard.thumbnailDataUrl}
                        alt={editTitle}
                        referrerPolicy="no-referrer"
                        className="w-10 h-10 object-cover"
                      />
                    </button>
                  ) : (
                    <div className="w-10 h-10 rounded-[8px] border border-[#E0E0E6] bg-[#FAFAFC] flex items-center justify-center text-[#949AA8] shrink-0">
                      <FileJson className="w-4 h-4" />
                    </div>
                  )}
                  <div className="min-w-0">
                    <h3 className="text-[13.5px] font-bold text-[#1E2028] truncate">
                      提示词可视化微调 · {editingCard.title}
                    </h3>
                    <div className="text-[11px] text-[#8E94A4] tabular-nums truncate">
                      {editingCard.workflowFileName} · {formatFormatLabel(editingCard.workflowFormat)}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={handleResetToExtracted}
                    className="h-8 px-2.5 inline-flex items-center gap-1 text-[11.5px] font-medium rounded-[8px] border border-[#E0E0E6] bg-white text-[#4C5264] hover:border-[#7C5CFC]/50 hover:text-[#6B48F5] whitespace-nowrap cursor-pointer"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>重置为 JSON 原词</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingCardId(null)}
                    aria-label="关闭微调抽屉"
                    className="h-8 w-8 inline-flex items-center justify-center rounded-[8px] border border-[#E0E0E6] text-[#5A6072] hover:text-[#1E2028] cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* 抽屉内容区 */}
              <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
                {/* 卡片名称/分类标签 & 节点来源手动切换 */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <label className="space-y-1">
                    <span className="block text-[11px] font-medium text-[#686E7E]">
                      卡片名称
                    </span>
                    <input
                      type="text"
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      className="w-full h-8 px-2.5 rounded-[8px] border border-[#E0E0E6] text-[12px] text-[#1E2028] focus:outline-none focus:border-[#7C5CFC]"
                    />
                  </label>

                  <label className="space-y-1">
                    <span className="block text-[11px] font-medium text-[#686E7E]">
                      分类标签（逗号或空格分隔）
                    </span>
                    <input
                      type="text"
                      value={editTagsInput}
                      onChange={(e) => setEditTagsInput(e.target.value)}
                      className="w-full h-8 px-2.5 rounded-[8px] border border-[#E0E0E6] text-[12px] text-[#1E2028] focus:outline-none focus:border-[#7C5CFC]"
                    />
                  </label>
                </div>

                {editingCard.nodeCandidates.length > 0 && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 rounded-[11px] border border-[#EAEAEF] bg-[#FAFAFC] p-3">
                    <label className="space-y-1">
                      <span className="block text-[11px] font-medium text-[#4C5264]">
                        正向节点来源（自动识别 / 手动切换兜底）
                      </span>
                      <select
                        value={editPosNodeId ?? ''}
                        onChange={(e) => handleSwitchNodeSource('positive', e.target.value)}
                        className="w-full h-8 px-2 rounded-[8px] border border-[#E0E0E6] bg-white text-[11.5px] text-[#1E2028] focus:outline-none focus:border-[#7C5CFC]"
                      >
                        <option value="">（未绑定节点，仅用当前文本）</option>
                        {editingCard.nodeCandidates.map((cand) => (
                          <option key={`pos-src-${cand.nodeId}`} value={cand.nodeId}>
                            #{cand.nodeId} · {cand.title} ({cand.nodeType})
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="space-y-1">
                      <span className="block text-[11px] font-medium text-[#4C5264]">
                        负向节点来源（自动识别 / 手动切换兜底）
                      </span>
                      <select
                        value={editNegNodeId ?? ''}
                        onChange={(e) => handleSwitchNodeSource('negative', e.target.value)}
                        className="w-full h-8 px-2 rounded-[8px] border border-[#E0E0E6] bg-white text-[11.5px] text-[#1E2028] focus:outline-none focus:border-[#7C5CFC]"
                      >
                        <option value="">（未绑定节点，仅用当前文本）</option>
                        {editingCard.nodeCandidates.map((cand) => (
                          <option key={`neg-src-${cand.nodeId}`} value={cand.nodeId}>
                            #{cand.nodeId} · {cand.title} ({cand.nodeType})
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                )}

                {/* 正/负向切换 Tab */}
                <div className="flex items-center justify-between gap-2 border-b border-[#EAEAEF] pb-2">
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setEditTab('positive')}
                      className={`h-8 px-3 rounded-[9px] text-[12px] font-semibold transition-colors cursor-pointer whitespace-nowrap tabular-nums ${
                        editTab === 'positive'
                          ? 'bg-[#F4F2FF] text-[#6B48F5] border border-[#DDD8FA]'
                          : 'bg-white text-[#686E7E] border border-[#E0E0E6] hover:text-[#1E2028]'
                      }`}
                    >
                      正向提示词 ({editPosTags.filter((t) => t.enabled).length}/{editPosTags.length})
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditTab('negative')}
                      className={`h-8 px-3 rounded-[9px] text-[12px] font-semibold transition-colors cursor-pointer whitespace-nowrap tabular-nums ${
                        editTab === 'negative'
                          ? 'bg-[#FFF1F3] text-[#C93B58] border border-[#F5B8C4]'
                          : 'bg-white text-[#686E7E] border border-[#E0E0E6] hover:text-[#1E2028]'
                      }`}
                    >
                      负向提示词 ({editNegTags.filter((t) => t.enabled).length}/{editNegTags.length})
                    </button>
                  </div>

                  <span className="text-[11px] text-[#8E94A4]">
                    点击词条切换启用/禁用 · +/- 调整权重
                  </span>
                </div>

                {/* Tag 胶囊微调区 */}
                <div className="space-y-2.5">
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={newTagInput}
                      onChange={(e) => setNewTagInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleAddTags();
                        }
                      }}
                      placeholder={`快捷添加${editTab === 'positive' ? '正向' : '负向'}词条（支持逗号分隔批量添加）...`}
                      className="flex-1 h-8 px-3 rounded-[8px] border border-[#E0E0E6] text-[12px] text-[#1E2028] focus:outline-none focus:border-[#7C5CFC]"
                    />
                    <button
                      type="button"
                      onClick={handleAddTags}
                      className="h-8 px-3 inline-flex items-center gap-1 rounded-[8px] border border-[#E0E0E6] bg-[#FAFAFC] text-[11.5px] font-medium text-[#4C5264] hover:border-[#7C5CFC]/50 hover:text-[#6B48F5] cursor-pointer whitespace-nowrap"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>添加</span>
                    </button>
                  </div>

                  <div className="rounded-[11px] border border-[#EAEAEF] bg-[#FAFAFC] p-3 min-h-[110px] max-h-[240px] overflow-y-auto flex flex-wrap content-start gap-1.5">
                    {activeTags.length === 0 ? (
                      <span className="text-[11.5px] text-[#949AA8] m-auto">
                        当前提示词为空，可通过上方输入框或下方全文文本框添加词条
                      </span>
                    ) : (
                      activeTags.map((tag) => (
                        <div
                          key={tag.id}
                          className={`inline-flex items-center gap-1 rounded-[8px] border px-2 py-1 text-[11.5px] transition-colors ${
                            tag.enabled
                              ? editTab === 'positive'
                                ? 'bg-white border-[#D6CEFB] text-[#1E2028]'
                                : 'bg-white border-[#F5B8C4] text-[#1E2028]'
                              : 'bg-[#F2F3F7] border-[#E0E0E6] text-[#949AA8] opacity-65'
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => handleToggleTagEnabled(tag.id)}
                            title={tag.enabled ? '点击禁用此词条' : '点击重新启用此词条'}
                            className={`text-left cursor-pointer max-w-[220px] truncate font-mono ${
                              !tag.enabled ? 'line-through' : ''
                            }`}
                          >
                            {tag.text}
                          </button>

                          <div className="flex items-center gap-0.5 pl-1 border-l border-[#EAEAEF] shrink-0">
                            <button
                              type="button"
                              onClick={() => handleAdjustTagWeight(tag.id, -0.1)}
                              aria-label="降低权重"
                              className="w-4 h-4 rounded hover:bg-[#F2F3F7] flex items-center justify-center text-[#686E7E] cursor-pointer"
                            >
                              <Minus className="w-2.5 h-2.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleSetTagWeight(tag.id, 1.0)}
                              title="点击重置权重为 1.0"
                              className={`px-1 text-[10.5px] font-mono tabular-nums cursor-pointer ${
                                Math.abs(tag.weight - 1.0) > 0.01
                                  ? 'font-semibold text-[#6B48F5]'
                                  : 'text-[#8E94A4]'
                              }`}
                            >
                              {tag.weight.toFixed(1)}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleAdjustTagWeight(tag.id, 0.1)}
                              aria-label="提高权重"
                              className="w-4 h-4 rounded hover:bg-[#F2F3F7] flex items-center justify-center text-[#686E7E] cursor-pointer"
                            >
                              <Plus className="w-2.5 h-2.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteTag(tag.id)}
                              aria-label="删除此词条"
                              className="w-4 h-4 rounded hover:bg-[#FFF1F3] flex items-center justify-center text-[#949AA8] hover:text-[#E85D75] cursor-pointer"
                            >
                              <X className="w-2.5 h-2.5" />
                            </button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                {/* 全文直改文本框 */}
                <label className="block space-y-1.5">
                  <div className="flex items-center justify-between text-[11.5px]">
                    <span className="font-medium text-[#4C5264]">
                      {editTab === 'positive' ? '正向提示词全文直改' : '负向提示词全文直改'}
                    </span>
                    <span className="text-[#8E94A4] font-mono tabular-nums">
                      {activeText.length} chars
                    </span>
                  </div>
                  <textarea
                    rows={5}
                    value={activeText}
                    onChange={(e) => handleFullTextChange(e.target.value)}
                    placeholder="直接输入或修改英文提示词，将与上方 Tag 胶囊双向同步..."
                    className="w-full rounded-[10px] border border-[#E0E0E6] bg-white p-3 text-[12px] font-mono text-[#1E2028] leading-relaxed focus:outline-none focus:border-[#7C5CFC] resize-y"
                  />
                </label>
              </div>

              {/* 抽屉底部保存与运行栏 */}
              <div className="shrink-0 px-5 py-3.5 border-t border-[#EAEAEF] bg-[#FAFAFC] space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-3">
                    <label className="inline-flex items-center gap-2 text-[12px] text-[#373C4B] cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={editApplyOnSend}
                        onChange={(e) => setEditApplyOnSend(e.target.checked)}
                        className="w-3.5 h-3.5 accent-[#7C5CFC]"
                      />
                      <span>回填微调提示词到工作流</span>
                    </label>

                    <label className="inline-flex items-center gap-1.5 text-[12px] text-[#4C5264] cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={editIsPrivate}
                        onChange={(e) => setEditIsPrivate(e.target.checked)}
                        className="w-3.5 h-3.5 accent-[#E85D75]"
                      />
                      <span>私密卡片</span>
                    </label>

                    <div className="flex items-center gap-1.5 text-[11.5px]">
                      <span className="text-[#686E7E]">卡片 Seed:</span>
                      <select
                        value={editSeedMode}
                        onChange={(e) =>
                          setEditSeedMode(e.target.value as 'workflow' | 'fixed' | 'random')
                        }
                        className="h-7 px-2 rounded-[7px] border border-[#E0E0E6] bg-white text-[11.5px] text-[#1E2028] focus:outline-none focus:border-[#7C5CFC]"
                      >
                        <option value="workflow">保持工作流原 Seed（固定）</option>
                        <option value="fixed">指定固定 Seed</option>
                        <option value="random">每次随机 Seed</option>
                      </select>
                      {editSeedMode === 'fixed' && (
                        <input
                          type="number"
                          min={0}
                          value={editFixedSeed}
                          onChange={(e) => {
                            const v = parseInt(e.target.value, 10);
                            setEditFixedSeed(Number.isFinite(v) && v >= 0 ? v : 0);
                          }}
                          className="w-[125px] h-7 px-2 rounded-[7px] border border-[#E0E0E6] bg-white text-[11px] font-mono tabular-nums text-[#1E2028] focus:outline-none focus:border-[#7C5CFC]"
                        />
                      )}
                    </div>
                  </div>

                  {saveFeedback && (
                    <span className="inline-flex items-center gap-1 text-[11.5px] font-medium text-emerald-700">
                      <Check className="w-3.5 h-3.5" />
                      <span>{saveFeedback}</span>
                    </span>
                  )}
                </div>

                <div className="flex flex-wrap items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => void handleSaveToCurrentCard()}
                    className="h-9 px-3.5 inline-flex items-center gap-1.5 text-[12px] font-medium rounded-[10px] border border-[#E0E0E6] bg-white text-[#1E2028] hover:border-[#7C5CFC]/50 hover:text-[#6B48F5] cursor-pointer whitespace-nowrap"
                  >
                    <Save className="w-3.5 h-3.5" />
                    <span>保存到当前卡片</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => void handleSaveAsNewCard()}
                    className="h-9 px-3.5 inline-flex items-center gap-1.5 text-[12px] font-medium rounded-[10px] border border-[#DDD8FA] bg-[#F4F2FF] text-[#6B48F5] hover:bg-[#EBE6FF] cursor-pointer whitespace-nowrap"
                  >
                    <CopyPlus className="w-3.5 h-3.5" />
                    <span>另存为新标签卡片</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => void handleRunFromDrawer()}
                    disabled={runStatus.state === 'sending' && runStatus.cardId === editingCard.id}
                    className="h-9 px-4 inline-flex items-center gap-1.5 text-[12px] font-medium rounded-[10px] bg-gradient-to-b from-[#8A6CFF] to-[#7C5CFC] text-white shadow-[0_2px_8px_rgba(124,92,252,0.24)] hover:brightness-105 disabled:opacity-50 cursor-pointer whitespace-nowrap"
                  >
                    {runStatus.state === 'sending' && runStatus.cardId === editingCard.id ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Play className="w-3.5 h-3.5" />
                    )}
                    <span>运行发送 UI</span>
                  </button>
                </div>
              </div>
            </aside>
          </div>
        )}

        {/* 参考图大图预览灯箱（支持 Esc 关闭、左右切换、原图无损展示与旧缩略图降级标注） */}
        {lightboxCard && (
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`参考图大图预览：${lightboxCard.title}`}
            className="fixed inset-0 z-[70] flex flex-col bg-[#0E1016]/88 backdrop-blur-sm p-3 sm:p-6"
            onClick={(e) => {
              if (e.target === e.currentTarget) setLightboxCardId(null);
            }}
          >
            {/* 顶部信息栏 */}
            <div className="shrink-0 max-w-[1200px] w-full mx-auto flex flex-wrap items-center justify-between gap-3 pb-3 text-white">
              <div className="flex flex-wrap items-center gap-2 min-w-0">
                <h3 className="text-[14.5px] font-semibold truncate max-w-[360px]">
                  {lightboxCard.title}
                </h3>

                {lightboxCard.isPrivate && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[6px] bg-[#E85D75]/25 border border-[#E85D75]/60 text-[11px] font-medium text-[#FFD3DC] whitespace-nowrap">
                    <EyeOff className="w-3 h-3" />
                    <span>私密</span>
                  </span>
                )}

                {lightboxCard.originalImageDataUrl ? (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-[6px] bg-emerald-500/20 border border-emerald-400/50 text-[11px] font-medium text-emerald-200 whitespace-nowrap tabular-nums">
                    原图无损
                    {lightboxCard.originalImageWidth && lightboxCard.originalImageHeight
                      ? ` · ${lightboxCard.originalImageWidth}×${lightboxCard.originalImageHeight}`
                      : ''}
                  </span>
                ) : (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-[6px] bg-amber-500/20 border border-amber-400/50 text-[11px] font-medium text-amber-200 whitespace-nowrap">
                    仅历史缩略图（无原始高清图）
                  </span>
                )}

                {lightboxCard.tags.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1">
                    {lightboxCard.tags.map((tag) => (
                      <span
                        key={tag}
                        className="px-2 py-0.5 rounded-[6px] bg-white/10 border border-white/15 text-[11px] text-white/85 whitespace-nowrap"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {filteredCards.length > 1 && lightboxIndex >= 0 && (
                  <span className="text-[11.5px] text-white/70 font-mono tabular-nums mr-1">
                    {lightboxIndex + 1} / {filteredCards.length}
                  </span>
                )}

                <button
                  type="button"
                  onClick={() => handleDownloadCardOriginalImage(lightboxCard)}
                  className="h-8 px-2.5 inline-flex items-center gap-1.5 rounded-[8px] bg-white/10 hover:bg-white/20 border border-white/15 text-[11.5px] text-white cursor-pointer whitespace-nowrap"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>下载图片</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    const target = lightboxCard;
                    setLightboxCardId(null);
                    openFineTuner(target, 'positive');
                  }}
                  className="h-8 px-2.5 inline-flex items-center gap-1.5 rounded-[8px] bg-white/10 hover:bg-white/20 border border-white/15 text-[11.5px] text-white cursor-pointer whitespace-nowrap"
                >
                  <SlidersHorizontal className="w-3.5 h-3.5" />
                  <span>微调提示词</span>
                </button>

                <button
                  type="button"
                  onClick={() => setLightboxCardId(null)}
                  aria-label="关闭大图预览"
                  className="h-8 w-8 inline-flex items-center justify-center rounded-[8px] bg-white/10 hover:bg-white/20 border border-white/15 text-white cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* 中心大图展示舞台 + 左右导航 */}
            <div
              className="relative flex-1 min-h-0 flex items-center justify-center max-w-[1360px] w-full mx-auto"
              onClick={(e) => {
                if (e.target === e.currentTarget) setLightboxCardId(null);
              }}
            >
              {filteredCards.length > 1 && (
                <button
                  type="button"
                  aria-label="上一张参考图"
                  onClick={() => {
                    const prevIdx =
                      lightboxIndex <= 0 ? filteredCards.length - 1 : lightboxIndex - 1;
                    setLightboxCardId(filteredCards[prevIdx].id);
                  }}
                  className="absolute left-1 sm:left-3 z-10 w-10 h-10 rounded-full bg-black/50 hover:bg-black/75 border border-white/20 text-white flex items-center justify-center cursor-pointer transition-colors"
                >
                  <ChevronLeft className="w-5 h-5" />
                </button>
              )}

              <img
                src={lightboxCard.originalImageDataUrl || lightboxCard.thumbnailDataUrl}
                alt={lightboxCard.title}
                referrerPolicy="no-referrer"
                className="max-w-full max-h-[82vh] object-contain rounded-[10px] shadow-[0_24px_64px_rgba(0,0,0,0.55)] bg-black/25 select-none"
              />

              {filteredCards.length > 1 && (
                <button
                  type="button"
                  aria-label="下一张参考图"
                  onClick={() => {
                    const nextIdx =
                      lightboxIndex < 0 || lightboxIndex >= filteredCards.length - 1
                        ? 0
                        : lightboxIndex + 1;
                    setLightboxCardId(filteredCards[nextIdx].id);
                  }}
                  className="absolute right-1 sm:right-3 z-10 w-10 h-10 rounded-full bg-black/50 hover:bg-black/75 border border-white/20 text-white flex items-center justify-center cursor-pointer transition-colors"
                >
                  <ChevronRight className="w-5 h-5" />
                </button>
              )}
            </div>

            <div className="shrink-0 pt-2 text-center text-[11px] text-white/55">
              点击空白处或按 Esc 关闭预览 · 左右方向键切换卡片
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

