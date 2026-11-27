import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  CheckSquare,
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
  ImageDown,
  ImagePlus,
  Layers,
  Loader2,
  Lock,
  Minus,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  SlidersHorizontal,
  Sparkles,
  Square,
  Tag,
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
  buildCardExportPayloadAsync,
  buildCardFolderPathSegments,
  buildWorkflowCardFromPngFile,
  computeBlobContentHash,
  computeCardContentFingerprint,
  dedupeAndMergeIncomingCards,
  deleteCardsFromLocalDirectory,
  ensureDirectoryWritePermission,
  extractComfyMetadataFromPngFile,
  findDuplicateCardForSingleDraft,
  FolderSyncIndexEntry,
  IncomingCardWithBlob,
  isFileSystemAccessSupported,
  isInRestrictedIframe,
  loadFolderSyncStateSnapshot,
  parseComfyWorkflowSource,
  parsePromptToTagItems,
  pickLocalWorkflowDirectory,
  readImageDimensions,
  resolveCardImageBlob,
  scanLocalDirectoryAndMerge,
  sendWorkflowCardToComfyUI,
  serializeTagItemsToPrompt,
  syncCardsIncrementalToLocalDirectory,
} from '../utils/workflowLibrary';
import {
  clearCardImageCache,
  formatBytesCompact,
  invalidateCardImageCache,
  useCardImageSrc,
} from '../utils/cardImageCache';
import {
  copyCardImageBlob,
  deleteCardImageBlobsBatch,
  DeletedCardTombstone,
  encodeBlobToDataUrl,
  isIndexedDbSupported,
  loadBoundDirectoryHandle,
  loadDeletedCardTombstones,
  loadDeletedCardTombstonesFromIndexedDb,
  mergeDeletedTombstonesMaps,
  normalizeWorkflowCards,
  recordDeletedCardTombstones,
  removeDeletedCardTombstones,
  saveBoundDirectoryHandle,
  saveCardImageBlob,
  saveDeletedCardTombstones,
} from '../utils/storageCache';

interface WorkflowCollectionModalProps {
  open: boolean;
  onClose: () => void;
  cards: WorkflowCollectionCard[];
  onChangeCards: (next: WorkflowCollectionCard[]) => { ok: boolean; error?: string };
  comfyUrl: string;
  activeProfile: ComfyProfile;
  activeCharacterName: string;
  knownCharacterHints?: string[];
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
  imageByteSize?: number;
  imageContentHash?: string;
  imageFile?: File | null;
  previewObjectUrl?: string;
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
  imageByteSize: undefined,
  imageContentHash: undefined,
  imageFile: null,
  previewObjectUrl: undefined,
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

function cardHasImage(card: WorkflowCollectionCard): boolean {
  return Boolean(
    card.hasOriginalImageBlob || card.originalImageDataUrl || card.thumbnailDataUrl
  );
}

function cardHasLosslessOriginal(card: WorkflowCollectionCard): boolean {
  return Boolean(card.hasOriginalImageBlob || card.originalImageDataUrl);
}

const CardThumbnailPreview: React.FC<{
  card: WorkflowCollectionCard;
  onOpenLightbox: (cardId: string) => void;
}> = memo(({ card, onOpenLightbox }) => {
  const { src, loading } = useCardImageSrc(card);
  const hasAny = cardHasImage(card);

  if (!hasAny) {
    return (
      <div className="w-[84px] h-[104px] rounded-[9px] border border-[#E0E0E6] bg-[#FAFAFC] flex flex-col items-center justify-center text-[#949AA8] shrink-0">
        <FileJson className="w-5 h-5 mb-1" />
        <span className="text-[10px]">纯 JSON</span>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onOpenLightbox(card.id);
      }}
      title="点击查看大图（保留原图画质）"
      className="group relative w-[84px] h-[104px] rounded-[9px] overflow-hidden border border-[#E0E0E6] bg-[#FAFAFC] shrink-0 cursor-zoom-in focus:outline-none focus:ring-2 focus:ring-[#7C5CFC]/50"
    >
      {src ? (
        <img
          src={src}
          alt={card.title}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-105"
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-[#949AA8]">
          {loading ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <ImagePlus className="w-4 h-4" />
          )}
        </div>
      )}
      <span className="absolute right-1 bottom-1 w-5 h-5 rounded-md bg-black/55 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
        <ZoomIn className="w-3 h-3" />
      </span>
    </button>
  );
});

const DrawerThumbnailButton: React.FC<{
  card: WorkflowCollectionCard;
  alt: string;
  onOpenLightbox: (cardId: string) => void;
}> = ({ card, alt, onOpenLightbox }) => {
  const { src } = useCardImageSrc(card);
  if (!cardHasImage(card)) {
    return (
      <div className="w-10 h-10 rounded-[8px] border border-[#E0E0E6] bg-[#FAFAFC] flex items-center justify-center text-[#949AA8] shrink-0">
        <FileJson className="w-4 h-4" />
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onOpenLightbox(card.id)}
      title="点击查看大图"
      className="w-10 h-10 shrink-0 rounded-[8px] overflow-hidden border border-[#E0E0E6] bg-[#FAFAFC] cursor-zoom-in flex items-center justify-center"
    >
      {src ? (
        <img
          src={src}
          alt={alt}
          referrerPolicy="no-referrer"
          className="w-full h-full object-cover"
        />
      ) : (
        <Loader2 className="w-4 h-4 animate-spin text-[#949AA8]" />
      )}
    </button>
  );
};

const LightboxImageElement: React.FC<{
  card: WorkflowCollectionCard;
}> = ({ card }) => {
  const { src, loading } = useCardImageSrc(card);
  if (loading && !src) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 text-white/80 py-16">
        <Loader2 className="w-7 h-7 animate-spin" />
        <span className="text-[12px]">正在读取无损原图...</span>
      </div>
    );
  }
  if (!src) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 text-white/75 py-16">
        <FileJson className="w-9 h-9 opacity-70" />
        <span className="text-[12.5px]">该卡片暂无参考图数据</span>
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={card.title}
      referrerPolicy="no-referrer"
      className="max-w-full max-h-[80vh] object-contain rounded-[10px] shadow-[0_24px_64px_rgba(0,0,0,0.55)] bg-black/25 select-none"
    />
  );
};

export const WorkflowCollectionModal: React.FC<WorkflowCollectionModalProps> = ({
  open,
  onClose,
  cards,
  onChangeCards,
  comfyUrl,
  activeProfile,
  activeCharacterName,
  knownCharacterHints,
  onOpenSettings,
}) => {
  const [draft, setDraft] = useState<DraftImportState>(EMPTY_DRAFT);
  const [createPanelOpen, setCreatePanelOpen] = useState<boolean>(
    () => cards.filter((c) => !c.isPrivate).length === 0
  );
  const [isDragging, setIsDragging] = useState(false);
  const [isBatchDragging, setIsBatchDragging] = useState(false);
  const [isImportingBatch, setIsImportingBatch] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{
    processed: number;
    total: number;
    succeeded: number;
    skipped: number;
    currentFile: string;
  } | null>(null);
  const [skippedDetails, setSkippedDetails] = useState<{ fileName: string; reason: string }[]>([]);
  const [showSkippedDetails, setShowSkippedDetails] = useState(false);
  const [importNotice, setImportNotice] = useState<{
    type: 'ok' | 'err' | 'warn';
    text: string;
  } | null>(null);
  const [storageWarning, setStorageWarning] = useState<string | null>(null);

  const [privateView, setPrivateView] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [activeTagFilter, setActiveTagFilter] = useState<string>('ALL');
  const [showAllTags, setShowAllTags] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<24 | 48 | 96>(24);

  // Batch organization mode
  const [batchSelectMode, setBatchSelectMode] = useState(false);
  const [selectedCardIds, setSelectedCardIds] = useState<Set<string>>(() => new Set());
  const [batchTagInput, setBatchTagInput] = useState('');
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);

  const [runStatus, setRunStatus] = useState<WorkbenchRunStatus>({ state: 'idle' });
  const [preferStudioProfile, setPreferStudioProfile] = useState(false);
  const [workbenchSeedOverride, setWorkbenchSeedOverride] = useState<'card' | 'fixed' | 'random'>('card');
  const [workbenchFixedSeed, setWorkbenchFixedSeed] = useState<number>(DEFAULT_COMFY_SEED);

  // Local folder binding state (File System Access API + graceful fallback)
  const fsApiSupported = useMemo(() => isFileSystemAccessSupported(), []);
  const inRestrictedIframe = useMemo(() => isInRestrictedIframe(), []);
  const [boundDirHandle, setBoundDirHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [dirPermState, setDirPermState] = useState<'none' | 'granted' | 'prompt' | 'denied'>('none');
  const [folderIndexMap, setFolderIndexMap] = useState<Record<string, FolderSyncIndexEntry> | null>(null);
  const [folderNotice, setFolderNotice] = useState<{
    type: 'ok' | 'warn' | 'err';
    text: string;
  } | null>(null);
  const [deleteStatus, setDeleteStatus] = useState<{
    phase: 'pending' | 'done' | 'warn';
    count: number;
    text: string;
  } | null>(null);
  const [isSyncingFolder, setIsSyncingFolder] = useState(false);
  const [syncProgress, setSyncProgress] = useState<{
    done: number;
    total: number;
    percent?: number;
    currentTitle: string;
    actionLabel?: string;
    addedCount?: number;
    updatedCount?: number;
    skippedCount?: number;
  } | null>(null);
  const [isScanningFolder, setIsScanningFolder] = useState(false);
  const [scanProgress, setScanProgress] = useState<{
    scanned: number;
    currentPath: string;
  } | null>(null);
  const [isExportingJson, setIsExportingJson] = useState(false);

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
  const bodyScrollRef = useRef<HTMLDivElement | null>(null);
  const batchToolbarRef = useRef<HTMLDivElement | null>(null);
  const cardGridRef = useRef<HTMLDivElement | null>(null);
  const lastBatchClickedIdRef = useRef<string | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const draftPreviewUrlRef = useRef<string | undefined>(undefined);
  const tombstonesRef = useRef<Record<string, DeletedCardTombstone>>(
    loadDeletedCardTombstones()
  );
  const deletedIdsSessionRef = useRef<Set<string>>(new Set());
  const cardsRef = useRef<WorkflowCollectionCard[]>(cards);
  cardsRef.current =
    deletedIdsSessionRef.current.size > 0
      ? cards.filter((c) => !deletedIdsSessionRef.current.has(c.id))
      : cards;
  const boundDirHandleRef = useRef<FileSystemDirectoryHandle | null>(boundDirHandle);
  boundDirHandleRef.current = boundDirHandle;
  const dirPermStateRef = useRef<'none' | 'granted' | 'prompt' | 'denied'>(dirPermState);
  dirPermStateRef.current = dirPermState;
  const folderIoQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingDeleteCardsRef = useRef<Map<string, WorkflowCollectionCard>>(new Map());
  const deleteFlushScheduledRef = useRef(false);
  const deleteToastTimerRef = useRef<number | null>(null);
  const burstDeletedTotalRef = useRef(0);

  const handleOpenLightbox = useCallback((id: string) => {
    setLightboxCardId(id);
  }, []);

  const enqueueFolderIo = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const run = folderIoQueueRef.current.then(task, task);
    folderIoQueueRef.current = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }, []);

  useEffect(() => {
    draftPreviewUrlRef.current = draft.previewObjectUrl;
  }, [draft.previewObjectUrl]);

  useEffect(() => {
    return () => {
      if (draftPreviewUrlRef.current) {
        URL.revokeObjectURL(draftPreviewUrlRef.current);
      }
      if (deleteToastTimerRef.current !== null) {
        window.clearTimeout(deleteToastTimerRef.current);
      }
      clearCardImageCache();
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(searchQuery);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [searchQuery]);

  const editingCard = useMemo(
    () => (editingCardId ? cards.find((c) => c.id === editingCardId) ?? null : null),
    [cards, editingCardId]
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const idbTombstones = await loadDeletedCardTombstonesFromIndexedDb();
        if (!cancelled) {
          tombstonesRef.current = mergeDeletedTombstonesMaps(
            tombstonesRef.current,
            idbTombstones
          );
        }
        const savedHandle = await loadBoundDirectoryHandle();
        if (cancelled || !savedHandle) return;
        const perm = await ensureDirectoryWritePermission(savedHandle, false);
        if (cancelled) return;
        setBoundDirHandle(savedHandle);
        setDirPermState(perm);
        if (perm === 'granted') {
          const snapshot = await loadFolderSyncStateSnapshot(savedHandle);
          if (!cancelled) {
            if (Object.keys(snapshot.deletedTombstones).length > 0) {
              const merged = mergeDeletedTombstonesMaps(
                tombstonesRef.current,
                snapshot.deletedTombstones
              );
              tombstonesRef.current = merged;
              void saveDeletedCardTombstones(merged);
            }
            const filteredEntries = { ...snapshot.entries };
            for (const delId of deletedIdsSessionRef.current) {
              delete filteredEntries[delId];
            }
            for (const tombId of Object.keys(tombstonesRef.current)) {
              delete filteredEntries[tombId];
            }
            setFolderIndexMap(filteredEntries);
          }
        }
      } catch {
        // 忽略挂载期的非致命目录恢复异常
      }
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

  const pendingSyncCount = useMemo(() => {
    if (!boundDirHandle || !folderIndexMap) return scopedCards.length;
    let count = 0;
    for (const card of scopedCards) {
      const entry = folderIndexMap[card.id];
      const targetPath = buildCardFolderPathSegments(card).join('/');
      const fp = card.contentFingerprint || computeCardContentFingerprint(card);
      if (!entry || entry.relativePath !== targetPath || entry.contentFingerprint !== fp) {
        count += 1;
      }
    }
    return count;
  }, [boundDirHandle, folderIndexMap, scopedCards]);

  const untaggedCount = useMemo(
    () => scopedCards.filter((c) => c.tags.length === 0).length,
    [scopedCards]
  );

  const modifiedCount = useMemo(
    () =>
      scopedCards.filter(
        (c) =>
          c.fineTunedPositive.trim() !== c.extractedPositive.trim() ||
          c.fineTunedNegative.trim() !== c.extractedNegative.trim()
      ).length,
    [scopedCards]
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
    const q = debouncedSearch.trim().toLowerCase();
    return scopedCards.filter((card) => {
      if (activeTagFilter === '__UNTAGGED__') {
        if (card.tags.length > 0) return false;
      } else if (activeTagFilter === '__MODIFIED__') {
        const modified =
          card.fineTunedPositive.trim() !== card.extractedPositive.trim() ||
          card.fineTunedNegative.trim() !== card.extractedNegative.trim();
        if (!modified) return false;
      } else if (activeTagFilter !== 'ALL' && !card.tags.includes(activeTagFilter)) {
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
  }, [scopedCards, activeTagFilter, debouncedSearch]);

  const totalPages = Math.max(1, Math.ceil(filteredCards.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pagedCards = useMemo(() => {
    const start = (safePage - 1) * pageSize;
    return filteredCards.slice(start, start + pageSize);
  }, [filteredCards, safePage, pageSize]);

  const scopedCardsRef = useRef<WorkflowCollectionCard[]>(scopedCards);
  scopedCardsRef.current = scopedCards;
  const filteredCardsRef = useRef<WorkflowCollectionCard[]>(filteredCards);
  filteredCardsRef.current = filteredCards;
  const pagedCardsRef = useRef<WorkflowCollectionCard[]>(pagedCards);
  pagedCardsRef.current = pagedCards;

  const scopedCardIdsKey = useMemo(
    () => scopedCards.map((c) => c.id).join('\u0000'),
    [scopedCards]
  );

  const goToPage = useCallback(
    (nextPage: number) => {
      const clamped = Math.max(1, Math.min(totalPages, nextPage));
      setPage(clamped);
      bodyScrollRef.current?.scrollTo({ top: 0, behavior: 'auto' });
    },
    [totalPages]
  );

  const toggleCardSelectionInBatch = useCallback(
    (cardId: string, shiftKey = false) => {
      const currentPaged = pagedCardsRef.current;
      const prevAnchorId = lastBatchClickedIdRef.current;
      if (shiftKey && prevAnchorId && prevAnchorId !== cardId) {
        const anchorIdx = currentPaged.findIndex((c) => c.id === prevAnchorId);
        const targetIdx = currentPaged.findIndex((c) => c.id === cardId);
        if (anchorIdx >= 0 && targetIdx >= 0) {
          const start = Math.min(anchorIdx, targetIdx);
          const end = Math.max(anchorIdx, targetIdx);
          setSelectedCardIds((prev) => {
            const next = new Set(prev);
            for (let i = start; i <= end; i += 1) {
              next.add(currentPaged[i].id);
            }
            return next;
          });
          lastBatchClickedIdRef.current = cardId;
          return;
        }
      }
      setSelectedCardIds((prev) => {
        const next = new Set(prev);
        if (next.has(cardId)) next.delete(cardId);
        else next.add(cardId);
        return next;
      });
      lastBatchClickedIdRef.current = cardId;
    },
    []
  );

  useEffect(() => {
    setPage(1);
    setConfirmBulkDelete(false);
    lastBatchClickedIdRef.current = null;
  }, [debouncedSearch, activeTagFilter, privateView, pageSize]);

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages]);

  // 仅依赖卡片 ID 集合字符串，避免因 workflowCards 内容更新导致全量数组引用变动触发无效重算
  useEffect(() => {
    const validIds = new Set(
      scopedCardIdsKey ? scopedCardIdsKey.split('\u0000') : []
    );
    setSelectedCardIds((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (validIds.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
    if (lastBatchClickedIdRef.current && !validIds.has(lastBatchClickedIdRef.current)) {
      lastBatchClickedIdRef.current = null;
    }
  }, [scopedCardIdsKey]);

  useEffect(() => {
    setConfirmBulkDelete(false);
  }, [selectedCardIds, batchSelectMode]);

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
      setBatchSelectMode(false);
      setSelectedCardIds(new Set());
      lastBatchClickedIdRef.current = null;
      clearCardImageCache();
    }
  }, [open]);

  // 通过 Ref 读取 filteredCards 与 onClose，避免 workflowCards 更新时反复卸载/重绑 window 监听
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const currentFiltered = filteredCardsRef.current;
      if (lightboxCardId) {
        if (e.key === 'Escape') {
          e.preventDefault();
          setLightboxCardId(null);
          return;
        }
        if (e.key === 'ArrowLeft' && currentFiltered.length > 1) {
          e.preventDefault();
          const curIdx = currentFiltered.findIndex((c) => c.id === lightboxCardId);
          const prevIdx =
            curIdx <= 0 ? currentFiltered.length - 1 : curIdx - 1;
          setLightboxCardId(currentFiltered[prevIdx].id);
          return;
        }
        if (e.key === 'ArrowRight' && currentFiltered.length > 1) {
          e.preventDefault();
          const curIdx = currentFiltered.findIndex((c) => c.id === lightboxCardId);
          const nextIdx =
            curIdx < 0 || curIdx >= currentFiltered.length - 1 ? 0 : curIdx + 1;
          setLightboxCardId(currentFiltered[nextIdx].id);
          return;
        }
        return;
      }

      if (e.key === 'Escape') {
        if (editingCardId) {
          setEditingCardId(null);
        } else {
          onCloseRef.current();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, editingCardId, lightboxCardId]);

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
    (next: WorkflowCollectionCard[], sourceEvent?: React.SyntheticEvent) => {
      if (sourceEvent) {
        sourceEvent.preventDefault();
        sourceEvent.stopPropagation();
      }
      const safeNext =
        deletedIdsSessionRef.current.size > 0
          ? next.filter((c) => !deletedIdsSessionRef.current.has(c.id))
          : next;
      cardsRef.current = safeNext;
      const res = onChangeCards(safeNext);
      if (!res.ok && res.error) {
        setStorageWarning(res.error);
      } else {
        setStorageWarning(null);
      }
      return res;
    },
    [onChangeCards]
  );

  const handleScanLocalFolder = useCallback(
    async (
      dirHandle: FileSystemDirectoryHandle,
      options?: { silentIfEmpty?: boolean }
    ) => {
      setIsScanningFolder(true);
      setScanProgress({ scanned: 0, currentPath: dirHandle.name });
      try {
        return await enqueueFolderIo(async () => {
          const scanStartedAt = Date.now();
          const res = await scanLocalDirectoryAndMerge(dirHandle, cardsRef.current, {
            tombstones: tombstonesRef.current,
            onProgress: (scanned, currentPath) => {
              setScanProgress({ scanned, currentPath });
            },
          });

          // 并发安全：防止扫描过程中被用户手动删除的卡片在异步返回时复活
          const currentTombstones = tombstonesRef.current;
          const deletedDuringScanIds = new Set<string>();
          for (const [id, tomb] of Object.entries(currentTombstones)) {
            if (tomb.deletedAt >= scanStartedAt) {
              deletedDuringScanIds.add(id);
            }
          }
          for (const id of deletedIdsSessionRef.current) {
            const tomb = currentTombstones[id];
            if (!tomb || tomb.deletedAt >= scanStartedAt) {
              deletedDuringScanIds.add(id);
            }
          }

          const safeTombstones = mergeDeletedTombstonesMaps(
            res.tombstones,
            currentTombstones
          );
          const clearedNotDeleted: string[] = [];
          for (const clearedId of res.clearedTombstoneIds) {
            if (!deletedDuringScanIds.has(clearedId)) {
              deletedIdsSessionRef.current.delete(clearedId);
              delete safeTombstones[clearedId];
              clearedNotDeleted.push(clearedId);
            }
          }
          tombstonesRef.current = safeTombstones;
          if (clearedNotDeleted.length > 0) {
            void removeDeletedCardTombstones(clearedNotDeleted);
          }
          void saveDeletedCardTombstones(safeTombstones);

          const safeIndexEntries = { ...res.indexEntries };
          for (const delId of deletedDuringScanIds) {
            delete safeIndexEntries[delId];
          }
          setFolderIndexMap(safeIndexEntries);

          const safeMergedCards = res.mergedCards.filter(
            (c) => !deletedDuringScanIds.has(c.id)
          );
          const safeMergedIdSet = new Set(safeMergedCards.map((c) => c.id));
          const locallyAddedDuringScan = cardsRef.current.filter(
            (c) => !safeMergedIdSet.has(c.id) && !deletedDuringScanIds.has(c.id)
          );
          const finalMergedCards = [...locallyAddedDuringScan, ...safeMergedCards];

          const safeAdded = res.addedCards.filter((c) => !deletedDuringScanIds.has(c.id));
          const safeUpdated = res.updatedCards.filter((c) => !deletedDuringScanIds.has(c.id));

          if (
            safeAdded.length > 0 ||
            safeUpdated.length > 0 ||
            res.restoredImageBlobsCount > 0
          ) {
            commitCards(finalMergedCards);
          }

          if (res.discoveredCardsCount === 0 && res.skippedTombstones.length === 0) {
            if (!options?.silentIfEmpty) {
              setFolderNotice({
                type: 'ok',
                text: `已绑定本地文件夹「${dirHandle.name}」：目录中暂未发现已有卡片（.card.json），可点击右侧「增量同步」将当前工作台卡片写入本地`,
              });
            }
            return res;
          }

          const totalSkippedCount =
            res.stats.skippedDuplicateCount + res.stats.skippedTombstoneCount;
          const extraRestoreNote =
            res.restoredImageBlobsCount > 0
              ? `（含补齐原图 ${res.restoredImageBlobsCount} 张）`
              : '';
          const tombstoneSkipNote =
            res.stats.skippedTombstoneCount > 0
              ? `，其中拦截已删除卡片 ${res.stats.skippedTombstoneCount} 张`
              : '';
          const reintroNote =
            res.reintroducedFromTombstone.length > 0
              ? `（检测到文件夹中重新放入曾删除的同名/同源新文件 ${res.reintroducedFromTombstone.length} 张，已重新收录）`
              : '';
          setFolderNotice({
            type: res.reintroducedFromTombstone.length > 0 ? 'warn' : 'ok',
            text: `已从「${dirHandle.name}」扫描 ${res.discoveredCardsCount} 张卡片：新增 ${safeAdded.length} 张 · 更新 ${safeUpdated.length} 张${extraRestoreNote} · 跳过 ${totalSkippedCount} 张（重复/未变更 ${res.stats.skippedDuplicateCount} 张${tombstoneSkipNote}）${reintroNote}`,
          });
          return res;
        });
      } catch (err) {
        setFolderNotice({
          type: 'warn',
          text:
            err instanceof Error
              ? `扫描本地文件夹失败：${err.message}`
              : '扫描本地文件夹失败，请检查目录读写权限',
        });
        return null;
      } finally {
        setIsScanningFolder(false);
        setScanProgress(null);
      }
    },
    [commitCards, enqueueFolderIo]
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
      await handleScanLocalFolder(result.handle);
    } else {
      setFolderNotice({
        type: 'warn',
        text: `已选择文件夹「${result.handle.name}」，但暂未获得读写权限；请点击「授权写入」或降级使用导出下载`,
      });
    }
  };

  const handleUnbindLocalFolder = async () => {
    setBoundDirHandle(null);
    setDirPermState('none');
    setFolderIndexMap(null);
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
      const scanRes = await handleScanLocalFolder(boundDirHandle, { silentIfEmpty: true });
      if (!scanRes || scanRes.discoveredCardsCount === 0) {
        setFolderNotice({
          type: 'ok',
          text: `已重新授权本地文件夹「${boundDirHandle.name}」读写权限`,
        });
      }
    } else {
      setFolderNotice({
        type: 'warn',
        text: `未能获取「${boundDirHandle.name}」写入权限，可重新选择本地文件夹或使用导出下载`,
      });
    }
  };

  const tryAutoWriteCardToFolder = useCallback(
    async (
      card: WorkflowCollectionCard,
      overrideBlob?: Blob | null
    ): Promise<{
      written: boolean;
      skippedUnchanged?: boolean;
      path?: string;
      updatedCard?: WorkflowCollectionCard;
      error?: string;
    }> => {
      if (!boundDirHandleRef.current || dirPermStateRef.current !== 'granted') {
        return { written: false };
      }
      return enqueueFolderIo(async () => {
        const activeHandle = boundDirHandleRef.current;
        if (
          !activeHandle ||
          dirPermStateRef.current !== 'granted' ||
          deletedIdsSessionRef.current.has(card.id)
        ) {
          return { written: false };
        }
        const blobsByCardId = new Map<string, Blob>();
        if (overrideBlob) {
          blobsByCardId.set(card.id, overrideBlob);
        }
        const res = await syncCardsIncrementalToLocalDirectory(activeHandle, [card], {
          blobsByCardId: blobsByCardId.size > 0 ? blobsByCardId : undefined,
          isCardActive: (cardId) => !deletedIdsSessionRef.current.has(cardId),
          extraTombstones: tombstonesRef.current,
        });
        const cleanedIndex = { ...res.indexEntries };
        for (const delId of deletedIdsSessionRef.current) {
          delete cleanedIndex[delId];
        }
        setFolderIndexMap(cleanedIndex);
        if (res.failed.length > 0) {
          return { written: false, error: res.failed[0].error };
        }
        const syncedCard = res.updatedCardsById.get(card.id);
        if (res.skippedCount > 0 && res.addedCount === 0 && res.updatedCount === 0) {
          return {
            written: false,
            skippedUnchanged: true,
            path: buildCardFolderPathSegments(card).join('/'),
            updatedCard: syncedCard,
          };
        }
        return {
          written: true,
          path: buildCardFolderPathSegments(card).join('/'),
          updatedCard: syncedCard,
        };
      });
    },
    [enqueueFolderIo]
  );

  const handleSyncScopedCardsToFolder = async (
    cardsOverride?: WorkflowCollectionCard[],
    sourceEvent?: React.SyntheticEvent
  ) => {
    if (sourceEvent) {
      sourceEvent.preventDefault();
      sourceEvent.stopPropagation();
    }
    const dirHandle = boundDirHandleRef.current;
    if (!dirHandle) {
      await handleSelectLocalFolder();
      return;
    }
    const perm = await ensureDirectoryWritePermission(dirHandle, true);
    setDirPermState(perm);
    dirPermStateRef.current = perm;
    if (perm !== 'granted') {
      setFolderNotice({
        type: 'warn',
        text: `未获得「${dirHandle.name}」写入权限，无法写入磁盘；已保留浏览器缓存并可使用「导出集」下载`,
      });
      return;
    }
    const targetCards = (cardsOverride ?? scopedCardsRef.current).filter(
      (c) => !deletedIdsSessionRef.current.has(c.id)
    );
    if (targetCards.length === 0) {
      setFolderNotice({
        type: 'warn',
        text: privateView ? '当前私密区暂无卡片可同步' : '当前公开区暂无卡片可同步',
      });
      return;
    }

    setIsSyncingFolder(true);
    setSyncProgress({
      done: 0,
      total: targetCards.length,
      currentTitle: targetCards[0]?.title ?? '',
      actionLabel: '比对差异',
    });
    try {
      await enqueueFolderIo(async () => {
        const activeCards = targetCards.filter(
          (c) => !deletedIdsSessionRef.current.has(c.id)
        );
        const res = await syncCardsIncrementalToLocalDirectory(dirHandle, activeCards, {
          isCardActive: (cardId) => !deletedIdsSessionRef.current.has(cardId),
          extraTombstones: tombstonesRef.current,
          onProgress: (done, total, currentTitle, actionLabel, detail) => {
            setSyncProgress({
              done,
              total,
              percent: detail?.percent,
              currentTitle,
              actionLabel,
              addedCount: detail?.addedCount,
              updatedCount: detail?.updatedCount,
              skippedCount: detail?.skippedCount,
            });
          },
        });
        const cleanedIndex = { ...res.indexEntries };
        for (const delId of deletedIdsSessionRef.current) {
          delete cleanedIndex[delId];
        }
        setFolderIndexMap(cleanedIndex);
        if (res.updatedCardsById.size > 0) {
          commitCards(
            cardsRef.current.map((c) => res.updatedCardsById.get(c.id) ?? c)
          );
        }

        if (res.failed.length === 0) {
          if (res.addedCount === 0 && res.updatedCount === 0) {
            setFolderNotice({
              type: 'ok',
              text: `「${dirHandle.name}」已是最新，无需重写（跳过未变更 ${res.skippedCount} 张）`,
            });
          } else {
            setFolderNotice({
              type: 'ok',
              text: `增量同步完成（${dirHandle.name}）：新增 ${res.addedCount} 张、更新 ${res.updatedCount} 张、跳过未变更 ${res.skippedCount} 张`,
            });
          }
        } else {
          setFolderNotice({
            type: 'warn',
            text: `增量同步部分完成：新增 ${res.addedCount} 张、更新 ${res.updatedCount} 张、跳过 ${res.skippedCount} 张，${res.failed.length} 张写入失败（${res.failed[0]?.title}: ${res.failed[0]?.error}）`,
          });
        }
      });
    } finally {
      setIsSyncingFolder(false);
      setSyncProgress(null);
    }
  };

  const handleWriteSingleCardToFolder = async (card: WorkflowCollectionCard) => {
    const dirHandle = boundDirHandleRef.current;
    if (!dirHandle) {
      await handleSelectLocalFolder();
      return;
    }
    const perm = await ensureDirectoryWritePermission(dirHandle, true);
    setDirPermState(perm);
    dirPermStateRef.current = perm;
    if (perm !== 'granted') {
      setFolderNotice({
        type: 'warn',
        text: `未获得「${dirHandle.name}」写入权限，请先授权或改用单卡下载`,
      });
      return;
    }
    await enqueueFolderIo(async () => {
      if (deletedIdsSessionRef.current.has(card.id)) return;
      const res = await syncCardsIncrementalToLocalDirectory(dirHandle, [card], {
        isCardActive: (cardId) => !deletedIdsSessionRef.current.has(cardId),
        extraTombstones: tombstonesRef.current,
      });
      const cleanedIndex = { ...res.indexEntries };
      for (const delId of deletedIdsSessionRef.current) {
        delete cleanedIndex[delId];
      }
      setFolderIndexMap(cleanedIndex);
      if (res.failed.length > 0) {
        setFolderNotice({
          type: 'err',
          text: `写入「${card.title}」失败：${res.failed[0].error}`,
        });
        return;
      }
      const updatedCard = res.updatedCardsById.get(card.id);
      if (updatedCard) {
        commitCards(
          cardsRef.current.map((c) => (c.id === card.id ? updatedCard : c))
        );
      }
      if (res.skippedCount > 0 && res.addedCount === 0 && res.updatedCount === 0) {
        setFolderNotice({
          type: 'ok',
          text: `「${card.title}」与本地文件夹内容一致，已是最新无需重写`,
        });
      } else {
        setFolderNotice({
          type: 'ok',
          text: `已将「${card.title}」增量写入「${dirHandle.name}/${buildCardFolderPathSegments(card).join('/')}」`,
        });
      }
    });
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

    let imageDims: { width?: number; height?: number } = {};
    let imageContentHash: string | undefined;
    let previewObjectUrl: string | undefined;
    let inlineDataUrlFallback: string | undefined;
    let pngMeta: Awaited<ReturnType<typeof extractComfyMetadataFromPngFile>> | null = null;

    if (nextImageFile) {
      try {
        imageDims = await readImageDimensions(nextImageFile);
        imageContentHash = await computeBlobContentHash(nextImageFile);
        previewObjectUrl = URL.createObjectURL(nextImageFile);
        if (!isIndexedDbSupported()) {
          inlineDataUrlFallback = await encodeBlobToDataUrl(nextImageFile);
        }
        if (
          nextImageFile.type === 'image/png' ||
          nextImageFile.name.toLowerCase().endsWith('.png')
        ) {
          pngMeta = await extractComfyMetadataFromPngFile(nextImageFile);
        }
      } catch (err) {
        if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
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
      if (nextImageFile && prev.previewObjectUrl && prev.previewObjectUrl !== previewObjectUrl) {
        URL.revokeObjectURL(prev.previewObjectUrl);
      }
      const updated = { ...prev };
      if (nextImageFile) {
        updated.imageFile = nextImageFile;
        updated.previewObjectUrl = previewObjectUrl;
        updated.thumbnailDataUrl = inlineDataUrlFallback ?? previewObjectUrl ?? '';
        updated.originalImageDataUrl = inlineDataUrlFallback;
        updated.originalImageMime = nextImageFile.type || 'image/png';
        updated.originalImageWidth = imageDims.width;
        updated.originalImageHeight = imageDims.height;
        updated.imageByteSize = nextImageFile.size;
        updated.imageContentHash = imageContentHash;
        updated.imageName = nextImageFile.name;
        if (!updated.title.trim()) {
          const stem = stripFileExtension(nextImageFile.name);
          const ch = pngMeta?.chibipromptMeta?.character?.trim();
          updated.title =
            ch && stem && !stem.toLowerCase().includes(ch.toLowerCase())
              ? `${ch} · ${stem}`
              : stem || ch || '';
        }
      }

      const effectiveRawJson = rawJsonText || pngMeta?.workflowJson || '';
      const effectiveApiJson = pngMeta?.apiPromptJson;

      if (
        effectiveRawJson ||
        effectiveApiJson ||
        pngMeta?.chibipromptMeta ||
        pngMeta?.a1111Meta
      ) {
        try {
          const parsed = parseComfyWorkflowSource({
            rawJsonText: effectiveRawJson || undefined,
            apiPromptJsonText: effectiveApiJson,
            chibipromptMeta: pngMeta?.chibipromptMeta,
            a1111Meta: pngMeta?.a1111Meta,
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
              : `已从 PNG 元数据自动提取工作流与提示词（${formatFormatLabel(parsed.workflowFormat)}，保留无损原图）`,
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

    const dupExisting = await findDuplicateCardForSingleDraft(cardsRef.current, {
      imageFile: draft.imageFile ?? null,
      imageContentHash: draft.imageContentHash,
      rawWorkflowJson: draft.rawWorkflowJson || '{}',
      apiPromptJson: draft.apiPromptJson,
      extractedPositive: draft.extractedPositive,
      extractedNegative: draft.extractedNegative,
    });
    if (dupExisting) {
      setImportNotice({
        type: 'warn',
        text: `跳过重复建卡：工作台已存在相同参考图与工作流的卡片「${dupExisting.title}」`,
      });
      return;
    }

    const now = Date.now();
    const title =
      draft.title.trim() ||
      stripFileExtension(draft.imageName) ||
      stripFileExtension(draft.workflowFileName) ||
      `工作流收藏 #${cardsRef.current.length + 1}`;
    const tags = parseTagsInput(draft.tagsInput);
    const cardId = `wf-card-${now}-${Math.random().toString(36).slice(2, 6)}`;

    let imageContentHash = draft.imageContentHash;
    if (!imageContentHash && draft.imageFile) {
      imageContentHash = await computeBlobContentHash(draft.imageFile);
    }

    let storedInIdb = false;
    if (draft.imageFile && isIndexedDbSupported()) {
      storedInIdb = await saveCardImageBlob(cardId, {
        blob: draft.imageFile,
        mimeType: draft.imageFile.type || draft.originalImageMime || 'image/png',
        width: draft.originalImageWidth,
        height: draft.originalImageHeight,
        byteSize: draft.imageFile.size,
        updatedAt: now,
      });
    }

    let fallbackInlineDataUrl = draft.originalImageDataUrl;
    if (draft.imageFile && !storedInIdb && !fallbackInlineDataUrl) {
      try {
        fallbackInlineDataUrl = await encodeBlobToDataUrl(draft.imageFile);
      } catch {
        fallbackInlineDataUrl = undefined;
      }
    }

    let newCard: WorkflowCollectionCard = {
      id: cardId,
      title,
      tags,
      thumbnailDataUrl: storedInIdb ? '' : fallbackInlineDataUrl || '',
      originalImageDataUrl: storedInIdb ? undefined : fallbackInlineDataUrl,
      originalImageMime: draft.originalImageMime,
      originalImageWidth: draft.originalImageWidth,
      originalImageHeight: draft.originalImageHeight,
      hasOriginalImageBlob: Boolean(draft.imageFile || fallbackInlineDataUrl),
      imageByteSize: draft.imageByteSize ?? draft.imageFile?.size,
      imageContentHash,
      autoImportedSource: 'manual',
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
    newCard.contentFingerprint = computeCardContentFingerprint(newCard);

    const folderRes = await tryAutoWriteCardToFolder(newCard, draft.imageFile ?? null);
    if (folderRes.updatedCard) {
      newCard = folderRes.updatedCard;
    } else if (folderRes.error) {
      setFolderNotice({
        type: 'warn',
        text: `已保存到浏览器缓存，但写入本地文件夹失败：${folderRes.error}`,
      });
    }

    deletedIdsSessionRef.current.delete(newCard.id);
    if (imageContentHash) {
      const matchingOldTombIds = Object.values(tombstonesRef.current)
        .filter((t) => t.imageContentHash === imageContentHash)
        .map((t) => t.cardId);
      if (matchingOldTombIds.length > 0) {
        const nextTombs = { ...tombstonesRef.current };
        for (const id of matchingOldTombIds) delete nextTombs[id];
        tombstonesRef.current = nextTombs;
        void removeDeletedCardTombstones(matchingOldTombIds);
      }
    }

    const saveRes = commitCards([newCard, ...cardsRef.current]);
    if (saveRes.ok) {
      if (draft.previewObjectUrl) {
        URL.revokeObjectURL(draft.previewObjectUrl);
      }
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

  const handleToggleCardPrivate = (
    cardId: string,
    e?: React.SyntheticEvent
  ) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    const target = cardsRef.current.find((c) => c.id === cardId);
    if (!target) return;
    const nextPrivate = !target.isPrivate;
    const res = commitCards(
      cardsRef.current.map((c) => {
        if (c.id !== cardId) return c;
        const updated: WorkflowCollectionCard = {
          ...c,
          isPrivate: nextPrivate,
          updatedAt: Date.now(),
        };
        updated.contentFingerprint = computeCardContentFingerprint(updated);
        return updated;
      }),
      e
    );
    if (res.ok) {
      setSelectedCardIds((prev) => {
        if (!prev.has(cardId)) return prev;
        const next = new Set(prev);
        next.delete(cardId);
        return next;
      });
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

  const scheduleDeletePersistenceFlush = useCallback(() => {
    if (deleteFlushScheduledRef.current) return;
    deleteFlushScheduledRef.current = true;

    void enqueueFolderIo(async () => {
      deleteFlushScheduledRef.current = false;
      const batchCards = Array.from(pendingDeleteCardsRef.current.values());
      if (batchCards.length === 0) {
        burstDeletedTotalRef.current = 0;
        return;
      }
      pendingDeleteCardsRef.current.clear();

      const batchIds = batchCards.map((c) => c.id);
      const deletedAt = Date.now();
      const batchTombstones: DeletedCardTombstone[] = batchCards.map((c) => ({
        cardId: c.id,
        title: c.title,
        deletedAt,
        contentFingerprint: c.contentFingerprint || computeCardContentFingerprint(c),
        imageContentHash: c.imageContentHash,
        imageName: c.imageName,
        imageByteSize: c.imageByteSize,
        relativePath: c.folderSyncedPath || buildCardFolderPathSegments(c).join('/'),
        diskFilesDeleted: false,
      }));

      let removedFilesCount = 0;
      let folderWarnText: string | null = null;
      const activeDirHandle = boundDirHandleRef.current;

      try {
        try {
          await deleteCardImageBlobsBatch(batchIds);
        } catch (err) {
          folderWarnText =
            err instanceof Error
              ? `部分缓存原图清理受限（${err.message}），卡片已从列表移除`
              : '部分缓存原图清理受限，卡片已从列表移除';
        }

        try {
          const updatedLocalTombstones = await recordDeletedCardTombstones(batchTombstones);
          tombstonesRef.current = mergeDeletedTombstonesMaps(
            tombstonesRef.current,
            updatedLocalTombstones
          );
        } catch {
          // 内存墓碑已同步写入，IndexedDB 写入失败不阻断后续流程
        }

        if (activeDirHandle) {
          try {
            // 在异步队列中仅做无手势的权限查询，绝不在丢失 user activation 后强行弹窗请求权限
            let perm = dirPermStateRef.current;
            if (perm !== 'granted') {
              perm = await ensureDirectoryWritePermission(activeDirHandle, false);
              setDirPermState(perm);
              dirPermStateRef.current = perm;
            }
            if (perm === 'granted') {
              const delRes = await deleteCardsFromLocalDirectory(
                activeDirHandle,
                batchCards,
                { extraTombstones: tombstonesRef.current }
              );
              removedFilesCount = delRes.removedFilesCount;
              const cleanedIndex = { ...delRes.indexEntries };
              for (const delId of deletedIdsSessionRef.current) {
                delete cleanedIndex[delId];
              }
              setFolderIndexMap(cleanedIndex);
              tombstonesRef.current = mergeDeletedTombstonesMaps(
                tombstonesRef.current,
                delRes.deletedTombstones
              );
              await saveDeletedCardTombstones(tombstonesRef.current).catch(() => undefined);

              if (delRes.failed.length > 0) {
                folderWarnText = `已从工作台移除，但部分本地文件清理失败：${delRes.failed[0].error}`;
              }
            } else {
              folderWarnText = `已从工作台删除 ${batchCards.length} 张卡片并记录墓碑（本地目录暂未授权写入，请点击上方「授权写入」后再同步）`;
            }
          } catch (err) {
            folderWarnText =
              err instanceof Error
                ? `已从工作台移除并记录墓碑，本地文件夹清理异常：${err.message}`
                : '已从工作台移除并记录墓碑，本地文件夹清理发生异常';
          }
        }
      } catch (err) {
        folderWarnText =
          err instanceof Error
            ? `已从工作台移除，异步持久化出现异常：${err.message}`
            : '已从工作台移除，异步持久化出现异常';
      } finally {
        // 若在磁盘清理期间又有新的连续删除入队，立即续排并保持提示连贯
        if (pendingDeleteCardsRef.current.size > 0) {
          scheduleDeletePersistenceFlush();
        } else {
          const finalBurstCount = Math.max(burstDeletedTotalRef.current, batchCards.length);
          burstDeletedTotalRef.current = 0;

          if (folderWarnText) {
            setDeleteStatus({
              phase: 'warn',
              count: finalBurstCount,
              text: folderWarnText,
            });
          } else {
            const doneText = activeDirHandle
              ? finalBurstCount === 1
                ? `已彻底删除「${batchCards[0].title}」（同步移除本地文件 ${removedFilesCount} 个）`
                : `已连续彻底删除 ${finalBurstCount} 张卡片（同步清理缓存与本地文件）`
              : finalBurstCount === 1
              ? `已彻底删除「${batchCards[0].title}」`
              : `已连续彻底删除 ${finalBurstCount} 张卡片及其缓存原图`;
            setDeleteStatus({
              phase: 'done',
              count: finalBurstCount,
              text: doneText,
            });
            if (deleteToastTimerRef.current !== null) {
              window.clearTimeout(deleteToastTimerRef.current);
            }
            deleteToastTimerRef.current = window.setTimeout(() => {
              setDeleteStatus((prev) => (prev?.phase === 'done' ? null : prev));
              deleteToastTimerRef.current = null;
            }, 3200);
          }
        }
      }
    });
  }, [enqueueFolderIo]);

  const performDeleteCards = useCallback(
    (
      cardsToDelete: WorkflowCollectionCard[],
      isBulk: boolean,
      sourceEvent?: React.SyntheticEvent
    ) => {
      if (sourceEvent) {
        sourceEvent.preventDefault();
        sourceEvent.stopPropagation();
      }
      const uniqueNewTargets = cardsToDelete.filter(
        (c) => !deletedIdsSessionRef.current.has(c.id)
      );
      if (uniqueNewTargets.length === 0) return;

      const prevScrollTop = bodyScrollRef.current?.scrollTop ?? null;

      // 键盘/连续删卡焦点保护：若当前焦点位于待删除卡片按钮上，删后平滑落回同位置的下一张卡
      let activeDeleteBtnIndex = -1;
      const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
      if (
        activeEl instanceof HTMLElement &&
        cardGridRef.current &&
        cardGridRef.current.contains(activeEl)
      ) {
        const deleteBtns = Array.from(
          cardGridRef.current.querySelectorAll<HTMLButtonElement>('[data-card-delete-btn]')
        );
        activeDeleteBtnIndex = deleteBtns.indexOf(activeEl as HTMLButtonElement);
      }

      const targetIds = uniqueNewTargets.map((c) => c.id);
      const targetIdSet = new Set(targetIds);
      const deletedAt = Date.now();

      for (const card of uniqueNewTargets) {
        deletedIdsSessionRef.current.add(card.id);
        pendingDeleteCardsRef.current.set(card.id, card);
      }

      // 立即同步更新内存墓碑，确保任意并发扫描/导入/同步瞬间可见，绝不复活
      const immediateTombstones: Record<string, DeletedCardTombstone> = {};
      for (const c of uniqueNewTargets) {
        immediateTombstones[c.id] = {
          cardId: c.id,
          title: c.title,
          deletedAt,
          contentFingerprint: c.contentFingerprint || computeCardContentFingerprint(c),
          imageContentHash: c.imageContentHash,
          imageName: c.imageName,
          imageByteSize: c.imageByteSize,
          relativePath: c.folderSyncedPath || buildCardFolderPathSegments(c).join('/'),
          diskFilesDeleted: false,
        };
      }
      tombstonesRef.current = mergeDeletedTombstonesMaps(
        tombstonesRef.current,
        immediateTombstones
      );

      setEditingCardId((prev) => (prev && targetIdSet.has(prev) ? null : prev));
      setLightboxCardId((prev) => (prev && targetIdSet.has(prev) ? null : prev));

      setSelectedCardIds((prev) => {
        if (prev.size === 0) return prev;
        let changed = false;
        const next = new Set(prev);
        for (const id of targetIds) {
          if (next.delete(id)) changed = true;
        }
        return changed ? next : prev;
      });
      if (lastBatchClickedIdRef.current && targetIdSet.has(lastBatchClickedIdRef.current)) {
        lastBatchClickedIdRef.current = null;
      }
      if (isBulk) {
        setConfirmBulkDelete(false);
      }

      invalidateCardImageCache(targetIds);

      // 立即从 cardsRef / IndexedDB workflow_cards / localStorage 中彻底移除
      const nextCards = cardsRef.current.filter((c) => !targetIdSet.has(c.id));
      commitCards(nextCards, sourceEvent);

      // 立即移除同步状态索引中的已删条目
      setFolderIndexMap((prev) => {
        if (!prev) return prev;
        let changed = false;
        const next = { ...prev };
        for (const id of targetIds) {
          if (id in next) {
            delete next[id];
            changed = true;
          }
        }
        return changed ? next : prev;
      });

      if (deleteToastTimerRef.current !== null) {
        window.clearTimeout(deleteToastTimerRef.current);
        deleteToastTimerRef.current = null;
      }
      burstDeletedTotalRef.current += uniqueNewTargets.length;
      const pendingTotal = burstDeletedTotalRef.current;
      setDeleteStatus({
        phase: 'pending',
        count: pendingTotal,
        text: boundDirHandleRef.current
          ? `正在同步删除 ${pendingTotal} 张卡片与本地文件夹残留...`
          : `正在清理 ${pendingTotal} 张卡片缓存...`,
      });

      window.requestAnimationFrame(() => {
        if (bodyScrollRef.current && prevScrollTop !== null) {
          const maxScroll = Math.max(
            0,
            bodyScrollRef.current.scrollHeight - bodyScrollRef.current.clientHeight
          );
          bodyScrollRef.current.scrollTop = Math.min(prevScrollTop, maxScroll);
        }

        if (isBulk && batchToolbarRef.current) {
          const fallbackTarget =
            batchToolbarRef.current.querySelector<HTMLButtonElement>(
              '[data-batch-exit-btn]'
            ) ??
            batchToolbarRef.current.querySelector<HTMLButtonElement>(
              '[data-batch-delete-trigger]'
            );
          fallbackTarget?.focus({ preventScroll: true });
          return;
        }

        if (activeDeleteBtnIndex >= 0) {
          if (
            document.activeElement &&
            document.activeElement !== document.body
          ) {
            return;
          }
          const nextBtns = Array.from(
            cardGridRef.current?.querySelectorAll<HTMLButtonElement>('[data-card-delete-btn]') ??
              []
          );
          if (nextBtns.length > 0) {
            const targetBtn =
              nextBtns[Math.min(activeDeleteBtnIndex, nextBtns.length - 1)];
            targetBtn?.focus({ preventScroll: true });
          }
        }
      });

      scheduleDeletePersistenceFlush();
    },
    [commitCards, scheduleDeletePersistenceFlush]
  );

  const handleDeleteCard = (
    cardId: string,
    e?: React.MouseEvent<HTMLButtonElement>
  ) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (deletedIdsSessionRef.current.has(cardId)) return;
    const target = cardsRef.current.find((c) => c.id === cardId);
    if (!target) return;
    performDeleteCards([target], false, e);
  };

  const handleBulkTogglePrivate = (
    makePrivate: boolean,
    e?: React.SyntheticEvent
  ) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (selectedCardIds.size === 0) return;
    const now = Date.now();
    const targetIds = new Set(
      cardsRef.current
        .filter((c) => selectedCardIds.has(c.id) && Boolean(c.isPrivate) === privateView)
        .map((c) => c.id)
    );
    if (targetIds.size === 0) return;
    const res = commitCards(
      cardsRef.current.map((c) => {
        if (!targetIds.has(c.id)) return c;
        const updated: WorkflowCollectionCard = {
          ...c,
          isPrivate: makePrivate,
          updatedAt: now,
        };
        updated.contentFingerprint = computeCardContentFingerprint(updated);
        return updated;
      }),
      e
    );
    if (res.ok) {
      setImportNotice({
        type: 'ok',
        text: makePrivate
          ? `已将选中的 ${targetIds.size} 张卡片设为私密`
          : `已将选中的 ${targetIds.size} 张卡片取消私密`,
      });
      setSelectedCardIds(new Set());
      setConfirmBulkDelete(false);
    }
  };

  const handleBulkAddTags = (e?: React.SyntheticEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    const tagsToAdd = parseTagsInput(batchTagInput);
    if (selectedCardIds.size === 0 || tagsToAdd.length === 0) return;
    const now = Date.now();
    const targetIds = new Set(
      cardsRef.current
        .filter((c) => selectedCardIds.has(c.id) && Boolean(c.isPrivate) === privateView)
        .map((c) => c.id)
    );
    if (targetIds.size === 0) return;
    const res = commitCards(
      cardsRef.current.map((c) => {
        if (!targetIds.has(c.id)) return c;
        const mergedTags = Array.from(new Set([...c.tags, ...tagsToAdd]));
        const updated: WorkflowCollectionCard = {
          ...c,
          tags: mergedTags,
          updatedAt: now,
        };
        updated.contentFingerprint = computeCardContentFingerprint(updated);
        return updated;
      }),
      e
    );
    if (res.ok) {
      setBatchTagInput('');
      setImportNotice({
        type: 'ok',
        text: `已为选中的 ${targetIds.size} 张卡片批量添加标签：${tagsToAdd.join('、')}`,
      });
    }
  };

  const handleBulkDeleteSelected = (e?: React.SyntheticEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (selectedCardIds.size === 0) return;
    const targets = cardsRef.current.filter(
      (c) =>
        selectedCardIds.has(c.id) &&
        Boolean(c.isPrivate) === privateView &&
        !deletedIdsSessionRef.current.has(c.id)
    );
    if (targets.length === 0) {
      setSelectedCardIds(new Set());
      setConfirmBulkDelete(false);
      return;
    }
    performDeleteCards(targets, true, e);
  };

  const handleDownloadCardOriginalImage = async (card: WorkflowCollectionCard) => {
    const resolved = await resolveCardImageBlob(card);
    if (!resolved) return;
    const ext =
      card.imageName.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase() ||
      (resolved.mimeType.includes('jpeg')
        ? 'jpg'
        : resolved.mimeType.includes('webp')
        ? 'webp'
        : 'png');
    const url = URL.createObjectURL(resolved.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${sanitizeFilenamePrefix(card.title)}.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
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

      if (!deletedIdsSessionRef.current.has(card.id)) {
        commitCards(
          cardsRef.current.map((c) =>
            c.id === card.id
              ? { ...c, lastRunAt: Date.now(), lastPromptId: res.promptId }
              : c
          )
        );
      }

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
    const nextCard: WorkflowCollectionCard = {
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
    nextCard.contentFingerprint = computeCardContentFingerprint(nextCard);
    return nextCard;
  };

  const handleSaveToCurrentCard = async () => {
    const updated = buildUpdatedEditingCard();
    if (!updated) return;
    const folderRes = await tryAutoWriteCardToFolder(updated);
    const finalCard = folderRes.updatedCard ?? updated;
    const res = commitCards(
      cardsRef.current.map((c) => (c.id === finalCard.id ? finalCard : c))
    );
    if (res.ok) {
      setSaveFeedback(
        folderRes.written
          ? '已保存到当前卡片并增量写入本地文件夹'
          : folderRes.skippedUnchanged
          ? '已保存到当前卡片（文件夹内容未变更，已跳过重写）'
          : '已保存到当前卡片'
      );
      window.setTimeout(() => setSaveFeedback(null), 2200);
    }
  };

  const handleSaveAsNewCard = async () => {
    const updated = buildUpdatedEditingCard();
    if (!updated || !editingCard) return;
    const now = Date.now();
    const baseTitle = updated.title;
    const newTitle =
      baseTitle === editingCard.title ? `${baseTitle} · 微调` : baseTitle;
    const newId = `wf-card-${now}-${Math.random().toString(36).slice(2, 6)}`;

    let clonedHasBlob = Boolean(updated.hasOriginalImageBlob);
    if (editingCard.hasOriginalImageBlob && isIndexedDbSupported()) {
      const copied = await copyCardImageBlob(editingCard.id, newId);
      clonedHasBlob = copied || clonedHasBlob;
    }

    let cloned: WorkflowCollectionCard = {
      ...updated,
      id: newId,
      title: newTitle,
      hasOriginalImageBlob: clonedHasBlob,
      folderSyncedPath: undefined,
      folderSyncedFingerprint: undefined,
      folderSyncedImageHash: undefined,
      lastRunAt: undefined,
      lastPromptId: undefined,
      lastFolderSyncAt: undefined,
      createdAt: now,
      updatedAt: now,
    };
    cloned.contentFingerprint = computeCardContentFingerprint(cloned);

    const folderRes = await tryAutoWriteCardToFolder(cloned);
    if (folderRes.updatedCard) {
      cloned = folderRes.updatedCard;
    }
    const res = commitCards([cloned, ...cardsRef.current]);
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
    commitCards(cardsRef.current.map((c) => (c.id === updated.id ? updated : c)));
    await handleRunCard(updated);
  };

  const handleExportCollection = async () => {
    setIsExportingJson(true);
    try {
      const { payload, omittedLargeImagesCount } = await buildCardExportPayloadAsync(cards);
      const blob = new Blob([payload], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `chibiprompt-workflow-cards-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      if (omittedLargeImagesCount > 0) {
        setImportNotice({
          type: 'warn',
          text: `已导出公开收藏集；因图片总体积过大，${omittedLargeImagesCount} 张卡片在 JSON 中仅保留元数据（完整原图建议通过「同步本地文件夹」落盘备份）`,
        });
      }
    } finally {
      setIsExportingJson(false);
    }
  };

  const handleExportPrivateCollection = async () => {
    setIsExportingJson(true);
    try {
      const { payload, omittedLargeImagesCount } = await buildCardExportPayloadAsync(cards, {
        onlyPrivate: true,
      });
      const blob = new Blob([payload], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `chibiprompt-private-workflow-cards-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      if (omittedLargeImagesCount > 0) {
        setImportNotice({
          type: 'warn',
          text: `已导出私密卡片；因图片总体积过大，${omittedLargeImagesCount} 张卡片在 JSON 中仅保留元数据（完整原图建议绑定本地文件夹落盘）`,
        });
      }
    } finally {
      setIsExportingJson(false);
    }
  };

  const handleImportCollection = async (input: FileList | File[]) => {
    const files = Array.from(input);
    if (files.length === 0) return;

    setIsImportingBatch(true);
    setImportNotice(null);
    setSkippedDetails([]);
    setShowSkippedDetails(false);
    setBatchProgress({
      processed: 0,
      total: files.length,
      succeeded: 0,
      skipped: 0,
      currentFile: files[0]?.name ?? '',
    });

    const incomingItems: IncomingCardWithBlob[] = [];
    const blobsByCardId = new Map<string, Blob>();
    const invalidSkipped: { fileName: string; reason: string }[] = [];

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const lower = file.name.toLowerCase();
        setBatchProgress({
          processed: i,
          total: files.length,
          succeeded: incomingItems.length,
          skipped: invalidSkipped.length,
          currentFile: file.name,
        });

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
              invalidSkipped.push({
                fileName: file.name,
                reason: '未找到有效的收藏卡片列表（需包含 cards 数组）',
              });
              continue;
            }

            const normalized = normalizeWorkflowCards(rawArr);
            if (normalized.length === 0) {
              invalidSkipped.push({
                fileName: file.name,
                reason: '卡片数据结构无效或为空',
              });
              continue;
            }
            for (const c of normalized) {
              incomingItems.push({
                card: c,
                sourceLabel: `${file.name} · ${c.title}`,
                fromCollectionJson: true,
              });
            }
          } catch {
            invalidSkipped.push({
              fileName: file.name,
              reason: '无法解析收藏集 JSON 文件',
            });
          }
        } else if (file.type === 'image/png' || lower.endsWith('.png')) {
          const pngResult = await buildWorkflowCardFromPngFile(file, {
            isPrivate: privateView,
            knownCharacterHints,
            indexSeed: i,
          });
          if (pngResult.ok) {
            blobsByCardId.set(pngResult.card.id, pngResult.imageBlob);
            incomingItems.push({
              card: pngResult.card,
              imageBlob: pngResult.imageBlob,
              mimeType: pngResult.mimeType,
              sourceLabel: file.name,
              fileModifiedAt: file.lastModified,
            });
          } else {
            invalidSkipped.push({
              fileName: pngResult.fileName,
              reason: pngResult.reason,
            });
          }
        } else {
          invalidSkipped.push({
            fileName: file.name,
            reason: '仅支持收藏集 .json 或内嵌 ComfyUI 参数的 .png 图片',
          });
        }

        if (i > 0 && i % 6 === 0) {
          await new Promise((r) => setTimeout(r, 0));
        }
      }

      const mergeRes = await dedupeAndMergeIncomingCards(
        cardsRef.current,
        incomingItems,
        {
          preferIncomingOnSameIdUpdate: true,
          tombstones: tombstonesRef.current,
          sourceMode: 'manual-import',
        }
      );

      if (mergeRes.clearedTombstoneIds.length > 0) {
        const nextTombs = { ...tombstonesRef.current };
        for (const id of mergeRes.clearedTombstoneIds) {
          delete nextTombs[id];
          deletedIdsSessionRef.current.delete(id);
        }
        tombstonesRef.current = nextTombs;
        void removeDeletedCardTombstones(mergeRes.clearedTombstoneIds);
      }

      const allSkippedDetails = [
        ...mergeRes.skippedDuplicates.map((d) => ({
          fileName: d.fileName,
          reason: d.reason,
        })),
        ...mergeRes.skippedTombstones.map((t) => ({
          fileName: t.fileName,
          reason: t.reason,
        })),
        ...invalidSkipped,
      ];
      setSkippedDetails(allSkippedDetails);

      const changedCards = [...mergeRes.addedCards, ...mergeRes.updatedCards];
      let finalCards = mergeRes.mergedCards;
      let folderSyncSummary = '';

      if (changedCards.length > 0) {
        const activeDirHandle = boundDirHandleRef.current;
        if (activeDirHandle && dirPermStateRef.current === 'granted') {
          const syncRes = await enqueueFolderIo(() =>
            syncCardsIncrementalToLocalDirectory(
              activeDirHandle,
              changedCards.filter((c) => !deletedIdsSessionRef.current.has(c.id)),
              {
                blobsByCardId,
                isCardActive: (cardId) => !deletedIdsSessionRef.current.has(cardId),
                extraTombstones: tombstonesRef.current,
                onProgress: (done, total, currentTitle, actionLabel, detail) => {
                  setSyncProgress({
                    done,
                    total,
                    percent: detail?.percent,
                    currentTitle,
                    actionLabel,
                    addedCount: detail?.addedCount,
                    updatedCount: detail?.updatedCount,
                    skippedCount: detail?.skippedCount,
                  });
                },
              }
            )
          );
          setSyncProgress(null);
          const cleanedIndex = { ...syncRes.indexEntries };
          for (const delId of deletedIdsSessionRef.current) {
            delete cleanedIndex[delId];
          }
          setFolderIndexMap(cleanedIndex);
          if (syncRes.updatedCardsById.size > 0) {
            finalCards = finalCards.map((c) => syncRes.updatedCardsById.get(c.id) ?? c);
          }
          if (syncRes.addedCount > 0 || syncRes.updatedCount > 0) {
            folderSyncSummary = `，已增量写入「${activeDirHandle.name}」（新增 ${syncRes.addedCount} / 更新 ${syncRes.updatedCount}）`;
          }
        }

        finalCards = finalCards.filter(
          (c) => !deletedIdsSessionRef.current.has(c.id)
        );
        const res = commitCards(finalCards);
        if (res.ok) {
          const dupSkippedCount = mergeRes.stats.skippedDuplicateCount;
          const tombSkippedCount = mergeRes.stats.skippedTombstoneCount;
          const reintroCount = mergeRes.reintroducedFromTombstone.length;
          const invalidCount = invalidSkipped.length;
          const statsText = `导入完成：新增 ${mergeRes.stats.addedCount} 张 · 更新 ${mergeRes.stats.updatedCount} 张 · 跳过重复 ${dupSkippedCount} 张${
            tombSkippedCount > 0 ? ` · 跳过已删除旧备份 ${tombSkippedCount} 张` : ''
          }${
            reintroCount > 0
              ? `（其中 ${reintroCount} 张曾被删除，本次手动导入已重新收录）`
              : ''
          }${
            invalidCount > 0 ? `（另有 ${invalidCount} 个无效/无参数文件被跳过）` : ''
          }`;
          const importedPrivateCount = changedCards.filter((c) =>
            Boolean(c.isPrivate)
          ).length;
          const privateSuffix =
            importedPrivateCount > 0 && !privateView
              ? `；其中 ${importedPrivateCount} 张为私密卡片已归入「私密」区`
              : '';
          setImportNotice({
            type: allSkippedDetails.length > 0 ? 'warn' : 'ok',
            text: `${statsText}${folderSyncSummary}${privateSuffix}`,
          });
        }
      } else if (
        mergeRes.skippedDuplicates.length > 0 ||
        mergeRes.skippedTombstones.length > 0
      ) {
        // 即使没有新增/更新，若后台补齐了旧卡片 hash 也可安全同步索引
        if (mergeRes.mergedCards !== cardsRef.current) {
          commitCards(mergeRes.mergedCards);
        }
        const invalidCount = invalidSkipped.length;
        const tombSkipText =
          mergeRes.stats.skippedTombstoneCount > 0
            ? ` · 拦截已删除旧备份 ${mergeRes.stats.skippedTombstoneCount} 张`
            : '';
        setImportNotice({
          type: 'warn',
          text: `未产生重复入库（幂等跳过）：新增 0 张 · 更新 0 张 · 跳过重复/已存在 ${mergeRes.stats.skippedDuplicateCount} 张${tombSkipText}${
            invalidCount > 0 ? `（另有 ${invalidCount} 个文件无可用参数被跳过）` : ''
          }`,
        });
      } else {
        const previewSkip = invalidSkipped
          .slice(0, 3)
          .map((s) => `${s.fileName}（${s.reason}）`)
          .join('、');
        const moreSuffix =
          invalidSkipped.length > 3 ? ` 等共 ${invalidSkipped.length} 个文件` : '';
        setImportNotice({
          type: 'err',
          text: previewSkip
            ? `导入失败：${previewSkip}${moreSuffix}`
            : '导入失败：未识别到有效的收藏集 JSON 或内嵌工作流的 PNG 图片',
        });
      }
    } finally {
      setIsImportingBatch(false);
      setBatchProgress(null);
      setSyncProgress(null);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E2028]/35 backdrop-blur-xs p-2 sm:p-5"
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
        className={`relative w-full max-w-[1280px] h-[92vh] sm:h-[90vh] flex flex-col rounded-[16px] bg-[#F4F4F7] border shadow-[0_24px_60px_rgba(18,22,33,0.18)] overflow-hidden overflow-x-hidden transition-colors ${
          isBatchDragging ? 'border-[#7C5CFC] ring-2 ring-[#7C5CFC]/25' : 'border-[#E0E0E6]'
        }`}
      >
        {/* 顶栏（支持半屏/窄屏自动换行，无右侧裁切） */}
        <header className="shrink-0 min-h-[56px] px-3.5 sm:px-5 py-2 bg-white border-b border-[#E0E0E6] flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-[10px] bg-[#F4F2FF] border border-[#DDD8FA] flex items-center justify-center text-[#6B48F5] shrink-0">
              <Layers className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-[14px] sm:text-[14.5px] font-bold text-[#1E2028] truncate">
                  参考图与工作流收藏工作台
                </h2>
                <span className="text-[11.5px] text-[#686E7E] tabular-nums whitespace-nowrap">
                  {privateView
                    ? `· 私密区 ${privateCards.length} 张`
                    : `· ${publicCards.length} 张卡片`}
                </span>
              </div>
              <p className="text-[11px] text-[#8E94A4] truncate max-w-[460px]">
                独立工作流库 · 不影响角色槽位与可爱预设快填 · ComfyUI: {comfyUrl || '未配置'}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
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
              <span className="max-w-[120px] truncate">
                {boundDirHandle ? `文件夹: ${boundDirHandle.name}` : '选择本地文件夹'}
              </span>
            </button>

            <button
              type="button"
              onClick={() => {
                setPrivateView((prev) => !prev);
                setActiveTagFilter('ALL');
                setLightboxCardId(null);
                setSelectedCardIds(new Set());
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
              className={`h-8 px-2.5 sm:px-3 inline-flex items-center gap-1.5 text-[11.5px] sm:text-[12px] font-medium rounded-[10px] border transition-colors whitespace-nowrap cursor-pointer ${
                createPanelOpen
                  ? 'border-[#7C5CFC] bg-[#F4F2FF] text-[#6B48F5]'
                  : 'border-[#E0E0E6] bg-white text-[#4C5264] hover:border-[#7C5CFC]/50 hover:text-[#6B48F5]'
              }`}
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{createPanelOpen ? '收起建卡' : '导入图片 + JSON 建卡'}</span>
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
              onClick={() => void handleExportCollection()}
              disabled={publicCards.length === 0 || isExportingJson}
              title="导出公开收藏集（默认自动排除私密卡片）"
              className="h-8 px-2.5 inline-flex items-center gap-1 text-[11.5px] font-medium rounded-[10px] border border-[#E0E0E6] bg-white text-[#4C5264] hover:border-[#7C5CFC]/40 hover:text-[#7C5CFC] disabled:opacity-40 transition-colors whitespace-nowrap cursor-pointer"
            >
              {isExportingJson ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Download className="w-3.5 h-3.5" />
              )}
              <span>导出集</span>
            </button>

            <button
              type="button"
              onClick={onClose}
              aria-label="关闭收藏工作台"
              className="h-8 w-8 inline-flex items-center justify-center rounded-[10px] border border-[#E0E0E6] bg-white text-[#5A6072] hover:text-[#1E2028] transition-colors cursor-pointer shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </header>

        {/* 主体区 + 浮动删除状态包裹层（确保常驻底部工具栏与分页栏始终贴底免上拉） */}
        <div className="relative flex-1 min-h-0 flex flex-col overflow-hidden">
        <div
          ref={bodyScrollRef}
          className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-3.5 sm:p-5 space-y-3.5"
        >
          {/* 本地文件夹绑定状态与沙箱降级同步条 */}
          {(boundDirHandle || folderNotice || !fsApiSupported || inRestrictedIframe) && (
            <div
              className={`rounded-[12px] border px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2.5 text-[12px] ${
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
                        ? pendingSyncCount > 0
                          ? `（读写已授权 · 待增量同步 ${pendingSyncCount} 张）`
                          : '（读写已授权 · 当前视图已是最新）'
                        : '（页面刷新后需点击右侧「授权写入」恢复读写与扫描权限）'}
                    </span>
                  ) : inRestrictedIframe ? (
                    <span>
                      当前处于受限预览 iframe 沙箱：若浏览器拦截本地文件夹授权，将自动降级为 IndexedDB 原图缓存 +「导出集 / 单卡下载」（拉取到本地 <code className="font-mono text-[11px] bg-[#F2F3F7] px-1 rounded">npm run dev</code> 独立窗口打开即可直写与读取本地文件夹）。
                    </span>
                  ) : (
                    <span>
                      当前浏览器环境暂不支持直接读写本地磁盘文件夹，已自动使用 IndexedDB 浏览器存储保留原图并支持「导出集 / 单卡下载」。
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
                    disabled={isScanningFolder || isSyncingFolder}
                    onClick={async () => {
                      const perm = await ensureDirectoryWritePermission(boundDirHandle, true);
                      setDirPermState(perm);
                      if (perm === 'granted') {
                        await handleScanLocalFolder(boundDirHandle);
                      } else {
                        setFolderNotice({
                          type: 'warn',
                          text: `未获得「${boundDirHandle.name}」读取权限，请先授权`,
                        });
                      }
                    }}
                    title="递归扫描本地文件夹（含 _私密区）恢复缺失卡片与无损原图，自动跳过已存在卡片"
                    className="h-7 px-2.5 inline-flex items-center gap-1 rounded-[8px] border border-[#DDD8FA] bg-white text-[11.5px] font-medium text-[#6B48F5] hover:bg-[#F4F2FF] disabled:opacity-45 cursor-pointer whitespace-nowrap"
                  >
                    {isScanningFolder ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="w-3.5 h-3.5" />
                    )}
                    <span>
                      {isScanningFolder && scanProgress
                        ? `扫描 ${scanProgress.scanned}`
                        : '从文件夹读取'}
                    </span>
                  </button>
                )}
                {boundDirHandle && (
                  <button
                    type="button"
                    disabled={isSyncingFolder || isScanningFolder || scopedCards.length === 0}
                    onClick={() => void handleSyncScopedCardsToFolder()}
                    title="仅写入新增或修改过的卡片，未变更卡片及未改动原图自动跳过"
                    className="h-7 px-2.5 inline-flex items-center gap-1 rounded-[8px] border border-emerald-300 bg-white text-[11.5px] font-medium text-emerald-800 hover:bg-emerald-50 disabled:opacity-45 cursor-pointer whitespace-nowrap"
                  >
                    {isSyncingFolder ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <FolderSync className="w-3.5 h-3.5" />
                    )}
                    <span>
                      {isSyncingFolder && syncProgress
                        ? `${syncProgress.actionLabel || '同步中'} ${syncProgress.done}/${syncProgress.total}`
                        : pendingSyncCount > 0
                        ? `增量同步 (${pendingSyncCount}/${scopedCards.length})`
                        : `增量同步 (已最新)`}
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

          {/* 文件夹扫描/增量同步进度条 */}
          {(scanProgress || syncProgress) && (
            <div className="rounded-[12px] border border-emerald-200 bg-emerald-50/80 px-4 py-2 text-[12px] text-emerald-900 space-y-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Loader2 className="w-4 h-4 animate-spin shrink-0 text-emerald-600" />
                  <span className="font-medium truncate">
                    {scanProgress
                      ? `正在扫描本地目录并去重恢复：${scanProgress.currentPath}`
                      : `正在增量同步（${syncProgress!.actionLabel || '检查'}）：${
                          syncProgress!.currentTitle || '更新目录索引'
                        }`}
                  </span>
                </div>
                <span className="font-mono text-[11px] tabular-nums shrink-0">
                  {scanProgress
                    ? `已扫描 ${scanProgress.scanned} 项`
                    : `${syncProgress!.done} / ${syncProgress!.total}${
                        typeof syncProgress!.addedCount === 'number'
                          ? `（新增 ${syncProgress!.addedCount} · 更新 ${
                              syncProgress!.updatedCount ?? 0
                            } · 跳过 ${syncProgress!.skippedCount ?? 0}）`
                          : ''
                      }`}
                </span>
              </div>
              {syncProgress && syncProgress.total > 0 && (
                <div className="h-1.5 rounded-full bg-white overflow-hidden">
                  <div
                    className="h-full bg-emerald-500 transition-all duration-150"
                    style={{
                      width: `${
                        syncProgress.percent ??
                        Math.min(
                          100,
                          Math.round((syncProgress.done / Math.max(1, syncProgress.total)) * 100)
                        )
                      }%`,
                    }}
                  />
                </div>
              )}
            </div>
          )}

          {/* 批量导入进度条 */}
          {batchProgress && (
            <div className="rounded-[12px] border border-[#DDD8FA] bg-[#F4F2FF] px-4 py-2.5 text-[12px] text-[#5B3DF5] space-y-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                  <span className="font-medium truncate">
                    正在批量解析并保留原图：{batchProgress.currentFile}
                  </span>
                </div>
                <span className="font-mono text-[11px] tabular-nums shrink-0">
                  {batchProgress.processed + 1} / {batchProgress.total}（成功 {batchProgress.succeeded} · 跳过 {batchProgress.skipped}）
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-white overflow-hidden">
                <div
                  className="h-full bg-[#7C5CFC] transition-all duration-150"
                  style={{
                    width: `${Math.min(
                      100,
                      Math.round(((batchProgress.processed + 1) / Math.max(1, batchProgress.total)) * 100)
                    )}%`,
                  }}
                />
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
                  onClick={() => void handleExportPrivateCollection()}
                  disabled={privateCards.length === 0 || isExportingJson}
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
                    setSelectedCardIds(new Set());
                    setConfirmBulkDelete(false);
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
              松开即可通过「导入集」批量导入含 ComfyUI 参数的 PNG 图片（保留原图不压缩）或收藏集 .json
            </div>
          )}

          {/* 导入反馈条（折叠建卡面板时依然可见，支持展开跳过明细） */}
          {!createPanelOpen && importNotice && (
            <div
              role="status"
              className={`rounded-[12px] border px-4 py-2.5 text-[12px] space-y-2 ${
                importNotice.type === 'err'
                  ? 'border-[#F8C8D2] bg-[#FFF1F3] text-[#B42343]'
                  : importNotice.type === 'warn'
                  ? 'border-amber-200 bg-amber-50/90 text-amber-800'
                  : 'border-emerald-200 bg-emerald-50/90 text-emerald-900'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-start gap-2 min-w-0 flex-1">
                  {importNotice.type === 'err' || importNotice.type === 'warn' ? (
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  ) : (
                    <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-emerald-600" />
                  )}
                  <span className="break-words">{importNotice.text}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {skippedDetails.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setShowSkippedDetails((v) => !v)}
                      className="text-[11px] font-medium underline cursor-pointer whitespace-nowrap"
                    >
                      {showSkippedDetails ? '收起跳过明细' : `查看跳过明细 (${skippedDetails.length})`}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setImportNotice(null);
                      setSkippedDetails([]);
                      setShowSkippedDetails(false);
                    }}
                    aria-label="关闭导入提示"
                    className="p-0.5 opacity-70 hover:opacity-100 cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              {showSkippedDetails && skippedDetails.length > 0 && (
                <div className="max-h-32 overflow-y-auto rounded-[8px] bg-white/75 border border-black/10 p-2 text-[11px] space-y-1">
                  {skippedDetails.map((item, idx) => (
                    <div key={`${item.fileName}-${idx}`} className="flex items-center justify-between gap-2">
                      <span className="font-mono truncate">{item.fileName}</span>
                      <span className="shrink-0 opacity-85">{item.reason}</span>
                    </div>
                  ))}
                </div>
              )}
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
                    支持同时拖入 1 张参考图与 1 个 .json 工作流；若仅拖入含 ComfyUI 元数据的 PNG，将自动提取内置工作流与提示词并保留无损原图。
                  </p>
                </div>
                {(draft.thumbnailDataUrl || draft.rawWorkflowJson || draft.extractedPositive) && (
                  <button
                    type="button"
                    onClick={() => {
                      if (draft.previewObjectUrl) {
                        URL.revokeObjectURL(draft.previewObjectUrl);
                      }
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

          {/* 搜索、标签筛选与批量整理栏 */}
          <div className="space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2.5">
              <div className="flex flex-wrap items-center gap-2 flex-1 min-w-[200px]">
                <div className="relative w-full sm:w-[250px]">
                  <Search className="w-3.5 h-3.5 text-[#949AA8] absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="搜索卡片名称、标签或提示词..."
                    className="w-full h-8 pl-8 pr-7 rounded-[9px] border border-[#E0E0E6] bg-white text-[12px] text-[#1E2028] focus:outline-none focus:border-[#7C5CFC]"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={() => setSearchQuery('')}
                      aria-label="清空搜索"
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-[#949AA8] hover:text-[#1E2028] cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setBatchSelectMode((v) => !v);
                    setSelectedCardIds(new Set());
                    setConfirmBulkDelete(false);
                    lastBatchClickedIdRef.current = null;
                  }}
                  className={`min-h-[38px] px-3.5 py-1.5 inline-flex items-center gap-1.5 rounded-[10px] border text-[12px] font-medium transition-colors cursor-pointer whitespace-nowrap ${
                    batchSelectMode
                      ? 'border-[#7C5CFC] bg-[#F4F2FF] text-[#6B48F5]'
                      : 'border-[#E0E0E6] bg-white text-[#4C5264] hover:border-[#7C5CFC]/50 hover:text-[#6B48F5]'
                  }`}
                >
                  <CheckSquare className="w-4 h-4" />
                  <span>{batchSelectMode ? '退出批量整理' : '批量整理'}</span>
                </button>

                {totalPages > 1 && (
                  <div className="inline-flex items-center gap-1 rounded-[9px] border border-[#E0E0E6] bg-white px-1.5 h-[36px] text-[11.5px] text-[#4C5264] tabular-nums">
                    <button
                      type="button"
                      disabled={safePage <= 1}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        goToPage(safePage - 1);
                      }}
                      title="上一页"
                      aria-label="上一页"
                      className="w-6 h-6 inline-flex items-center justify-center rounded-[6px] hover:bg-[#F4F2FF] hover:text-[#6B48F5] disabled:opacity-35 cursor-pointer"
                    >
                      <ChevronLeft className="w-3.5 h-3.5" />
                    </button>
                    <span className="px-1 font-mono text-[11px]">
                      {safePage}/{totalPages}
                    </span>
                    <button
                      type="button"
                      disabled={safePage >= totalPages}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        goToPage(safePage + 1);
                      }}
                      title="下一页"
                      aria-label="下一页"
                      className="w-6 h-6 inline-flex items-center justify-center rounded-[6px] hover:bg-[#F4F2FF] hover:text-[#6B48F5] disabled:opacity-35 cursor-pointer"
                    >
                      <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2.5">
                <div className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
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
                        className="w-[120px] h-7 px-2 rounded-[7px] border border-[#E0E0E6] bg-white text-[11px] font-mono tabular-nums text-[#1E2028] focus:outline-none focus:border-[#7C5CFC]"
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

            {/* 分类标签快捷筛选条（大库时自动折叠冗余标签） */}
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setActiveTagFilter('ALL')}
                className={`h-7 px-2.5 rounded-[8px] text-[11.5px] font-medium border transition-colors cursor-pointer whitespace-nowrap tabular-nums ${
                  activeTagFilter === 'ALL'
                    ? 'border-[#7C5CFC] bg-[#F4F2FF] text-[#6B48F5]'
                    : 'border-[#E0E0E6] bg-white text-[#686E7E] hover:text-[#1E2028]'
                }`}
              >
                全部 ({scopedCards.length})
              </button>
              {untaggedCount > 0 && (
                <button
                  type="button"
                  onClick={() => setActiveTagFilter('__UNTAGGED__')}
                  className={`h-7 px-2.5 rounded-[8px] text-[11.5px] font-medium border transition-colors cursor-pointer whitespace-nowrap tabular-nums ${
                    activeTagFilter === '__UNTAGGED__'
                      ? 'border-[#7C5CFC] bg-[#F4F2FF] text-[#6B48F5]'
                      : 'border-[#E0E0E6] bg-white text-[#686E7E] hover:text-[#1E2028]'
                  }`}
                >
                  未分类 ({untaggedCount})
                </button>
              )}
              {modifiedCount > 0 && (
                <button
                  type="button"
                  onClick={() => setActiveTagFilter('__MODIFIED__')}
                  className={`h-7 px-2.5 rounded-[8px] text-[11.5px] font-medium border transition-colors cursor-pointer whitespace-nowrap tabular-nums ${
                    activeTagFilter === '__MODIFIED__'
                      ? 'border-[#7C5CFC] bg-[#F4F2FF] text-[#6B48F5]'
                      : 'border-[#E0E0E6] bg-white text-[#686E7E] hover:text-[#1E2028]'
                  }`}
                >
                  已微调 ({modifiedCount})
                </button>
              )}
              {(showAllTags ? allCategoryTags : allCategoryTags.slice(0, 12)).map(
                ([tag, count]) => (
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
                )
              )}
              {allCategoryTags.length > 12 && (
                <button
                  type="button"
                  onClick={() => setShowAllTags((v) => !v)}
                  className="h-7 px-2.5 rounded-[8px] text-[11px] font-medium border border-dashed border-[#D2D4DF] bg-white text-[#6B48F5] hover:bg-[#F4F2FF] cursor-pointer whitespace-nowrap"
                >
                  {showAllTags
                    ? '收起标签'
                    : `展开全部标签 (+${allCategoryTags.length - 12})`}
                </button>
              )}
            </div>

            {batchSelectMode && (
              <div className="rounded-[10px] border border-[#DDD8FA] bg-[#F8F6FF] px-3 py-1.5 text-[11.5px] text-[#5B3DF5] flex flex-wrap items-center justify-between gap-2">
                <span>
                  批量整理已开启：点击卡片任意位置即可快速勾选，按住 <kbd className="px-1 py-0.5 rounded bg-white border border-[#DDD8FA] font-mono text-[10.5px]">Shift</kbd> 点击可连续范围多选；批量删除与翻页按钮已常驻固定在底部。
                </span>
              </div>
            )}
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
                      : '点击上方「导入图片 + JSON 建卡」，或使用「导入集」批量拖入含 ComfyUI 参数的 PNG 图片，即可保留无损原图、快速筛选微调并发送到 ComfyUI。'
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
            <div ref={cardGridRef} className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3.5">
              {pagedCards.map((card) => {
                const isSendingThis =
                  runStatus.state === 'sending' && runStatus.cardId === card.id;
                const isSelected = selectedCardIds.has(card.id);
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
                    data-card-id={card.id}
                    onClick={
                      batchSelectMode
                        ? (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            toggleCardSelectionInBatch(card.id, e.shiftKey);
                          }
                        : undefined
                    }
                    className={`rounded-[14px] border overflow-hidden flex flex-col transition-colors ${
                      batchSelectMode ? 'cursor-pointer select-none' : ''
                    } ${
                      isSelected
                        ? 'border-[#7C5CFC] bg-[#FAF8FF] ring-2 ring-[#7C5CFC]/25'
                        : 'border-[#E0E0E6] bg-white hover:border-[#7C5CFC]/45'
                    }`}
                  >
                    {/* 缩略图与头部 */}
                    <div className="flex gap-3 p-3.5 border-b border-[#EAEAEF]">
                      {batchSelectMode && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            toggleCardSelectionInBatch(card.id, e.shiftKey);
                          }}
                          aria-label={isSelected ? '取消选择此卡片' : '选择此卡片'}
                          className={`self-start w-7 h-7 rounded-[8px] border flex items-center justify-center transition-colors cursor-pointer shrink-0 ${
                            isSelected
                              ? 'border-[#7C5CFC] bg-[#7C5CFC] text-white'
                              : 'border-[#D2D4DF] bg-[#FAFAFC] text-[#949AA8] hover:border-[#7C5CFC]/60 hover:text-[#6B48F5]'
                          }`}
                        >
                          {isSelected ? (
                            <CheckSquare className="w-4 h-4" />
                          ) : (
                            <Square className="w-4 h-4" />
                          )}
                        </button>
                      )}

                      <CardThumbnailPreview
                        card={card}
                        onOpenLightbox={handleOpenLightbox}
                      />

                      <div className="min-w-0 flex-1 flex flex-col justify-between">
                        <div className="space-y-1">
                          <div className="flex items-start justify-between gap-1.5">
                            <h4 className="text-[13.5px] font-semibold text-[#1E2028] leading-snug line-clamp-2 break-words">
                              {card.title}
                            </h4>
                            <div className="flex items-center gap-1 shrink-0">
                              <button
                                type="button"
                                onClick={(e) => handleToggleCardPrivate(card.id, e)}
                                title={card.isPrivate ? '取消私密并移回公开列表' : '设为私密（移入私密区）'}
                                className={`h-7 px-2 inline-flex items-center gap-1 rounded-[7px] border text-[10.5px] font-medium transition-colors cursor-pointer whitespace-nowrap ${
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
                              {cardHasImage(card) && (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    void handleDownloadCardOriginalImage(card);
                                  }}
                                  title="下载原始参考图"
                                  className="w-7 h-7 inline-flex items-center justify-center rounded-[7px] text-[#949AA8] hover:bg-[#F4F2FF] hover:text-[#7C5CFC] cursor-pointer"
                                >
                                  <ImageDown className="w-3.5 h-3.5" />
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  handleDownloadCardJson(card);
                                }}
                                title="下载卡片工作流 JSON"
                                className="w-7 h-7 inline-flex items-center justify-center rounded-[7px] text-[#949AA8] hover:bg-[#F4F2FF] hover:text-[#7C5CFC] cursor-pointer"
                              >
                                <Download className="w-3.5 h-3.5" />
                              </button>
                              {boundDirHandle && (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    void handleWriteSingleCardToFolder(card);
                                  }}
                                  title="写入当前绑定的本地文件夹"
                                  className="w-7 h-7 inline-flex items-center justify-center rounded-[7px] text-[#949AA8] hover:bg-emerald-50 hover:text-emerald-600 cursor-pointer"
                                >
                                  <FolderSync className="w-3.5 h-3.5" />
                                </button>
                              )}
                              <button
                                type="button"
                                data-card-delete-btn={card.id}
                                onClick={(e) => handleDeleteCard(card.id, e)}
                                title="删除此卡片"
                                aria-label={`删除卡片 ${card.title}`}
                                className="w-7 h-7 inline-flex items-center justify-center rounded-[7px] text-[#949AA8] hover:bg-[#FFF1F3] hover:text-[#E85D75] cursor-pointer"
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
                          {card.originalImageWidth && card.originalImageHeight && (
                            <span>
                              · {card.originalImageWidth}×{card.originalImageHeight}
                            </span>
                          )}
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

                    {/* 可点击唤出微调的提示词摘要区（批量模式下点击同样快速勾选） */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (batchSelectMode) {
                          toggleCardSelectionInBatch(card.id, e.shiftKey);
                        } else {
                          openFineTuner(card, 'positive');
                        }
                      }}
                      title={
                        batchSelectMode
                          ? '点击勾选/取消此卡片（按住 Shift 支持连选）'
                          : '点击唤出可视化 Tag 微调面板'
                      }
                      className={`flex-1 px-3.5 py-2.5 text-left transition-colors cursor-pointer space-y-1.5 ${
                        isSelected
                          ? 'bg-[#F5F2FF]/80 hover:bg-[#EFEAFF]'
                          : 'bg-[#FAFAFC] hover:bg-[#F5F3FF]/60'
                      }`}
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
                    <div
                      onClick={(e) => {
                        if (batchSelectMode) {
                          e.stopPropagation();
                        }
                      }}
                      className="px-3.5 py-2.5 bg-white border-t border-[#EAEAEF] flex items-center gap-2"
                    >
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          openFineTuner(card, 'positive');
                        }}
                        className="flex-1 h-8 px-2.5 inline-flex items-center justify-center gap-1.5 text-[11.5px] font-medium rounded-[9px] border border-[#E0E0E6] bg-white text-[#4C5264] hover:border-[#7C5CFC]/50 hover:text-[#6B48F5] transition-colors whitespace-nowrap cursor-pointer"
                      >
                        <SlidersHorizontal className="w-3.5 h-3.5" />
                        <span>微调提示词</span>
                      </button>

                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          void handleRunCard(card);
                        }}
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

        {/* 连续删卡局部无感浮动反馈（悬浮在滚动区域右下角，位于常驻底部操作坞上方） */}
        {deleteStatus && (
          <div className="pointer-events-none absolute bottom-3 right-4 left-4 sm:left-auto z-20 flex justify-end">
            <div
              role="status"
              aria-live="polite"
              className={`pointer-events-auto max-w-full sm:max-w-[460px] rounded-[11px] border px-3.5 py-2.5 shadow-[0_8px_24px_rgba(18,22,33,0.14)] backdrop-blur-md flex items-center gap-2.5 text-[12px] ${
                deleteStatus.phase === 'warn'
                  ? 'border-amber-300 bg-amber-50/95 text-amber-900'
                  : deleteStatus.phase === 'done'
                  ? 'border-emerald-300 bg-emerald-50/95 text-emerald-900'
                  : 'border-[#DDD8FA] bg-white/95 text-[#373C4B]'
              }`}
            >
              {deleteStatus.phase === 'pending' && (
                <Loader2 className="w-4 h-4 animate-spin shrink-0 text-[#7C5CFC]" />
              )}
              {deleteStatus.phase === 'done' && (
                <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600" />
              )}
              {deleteStatus.phase === 'warn' && (
                <AlertCircle className="w-4 h-4 shrink-0 text-amber-600" />
              )}
              <span className="truncate font-medium">{deleteStatus.text}</span>
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (deleteToastTimerRef.current !== null) {
                    window.clearTimeout(deleteToastTimerRef.current);
                    deleteToastTimerRef.current = null;
                  }
                  setDeleteStatus(null);
                }}
                aria-label="关闭删除提示"
                className="p-0.5 opacity-65 hover:opacity-100 cursor-pointer shrink-0"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}
        </div>

        {/* 底部常驻控制坞：无论滚动到哪一屏，批量删除、快捷批量整理与翻页始终触手可及 */}
        {(batchSelectMode || filteredCards.length > 0) && (
          <div
            ref={batchToolbarRef}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            className="shrink-0 z-10 bg-white border-t border-[#E0E0E6] px-3.5 sm:px-5 py-2.5 space-y-2.5 shadow-[0_-6px_20px_rgba(18,22,33,0.06)]"
          >
            {batchSelectMode && (
              <div className="rounded-[11px] border border-[#DDD8FA] bg-[#FAF9FF] px-3 py-2.5 flex flex-col gap-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center min-h-[34px] px-2.5 rounded-[8px] bg-[#7C5CFC] text-white text-[12px] font-semibold tabular-nums whitespace-nowrap">
                      已选 {selectedCardIds.size} 张
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setSelectedCardIds((prev) => {
                          const next = new Set(prev);
                          for (const c of pagedCardsRef.current) next.add(c.id);
                          return next;
                        });
                      }}
                      className="min-h-[34px] px-3 py-1 rounded-[8px] border border-[#E0E0E6] bg-white text-[12px] font-medium text-[#4C5264] hover:border-[#7C5CFC]/45 hover:text-[#6B48F5] transition-colors cursor-pointer whitespace-nowrap"
                    >
                      全选本页 ({pagedCards.length})
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setSelectedCardIds((prev) => {
                          const next = new Set(prev);
                          for (const c of pagedCardsRef.current) {
                            if (next.has(c.id)) next.delete(c.id);
                            else next.add(c.id);
                          }
                          return next;
                        });
                      }}
                      className="min-h-[34px] px-3 py-1 rounded-[8px] border border-[#E0E0E6] bg-white text-[12px] font-medium text-[#4C5264] hover:border-[#7C5CFC]/45 hover:text-[#6B48F5] transition-colors cursor-pointer whitespace-nowrap"
                    >
                      反选本页
                    </button>
                    {filteredCards.length > pagedCards.length && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setSelectedCardIds(
                            new Set(filteredCardsRef.current.map((c) => c.id))
                          );
                        }}
                        className="min-h-[34px] px-3 py-1 rounded-[8px] border border-[#E0E0E6] bg-white text-[12px] font-medium text-[#4C5264] hover:border-[#7C5CFC]/45 hover:text-[#6B48F5] transition-colors cursor-pointer whitespace-nowrap"
                      >
                        全选筛选 ({filteredCards.length})
                      </button>
                    )}
                    {selectedCardIds.size > 0 && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setSelectedCardIds(new Set());
                          setConfirmBulkDelete(false);
                          lastBatchClickedIdRef.current = null;
                        }}
                        className="min-h-[34px] px-3 py-1 rounded-[8px] border border-[#E0E0E6] bg-white text-[12px] font-medium text-[#686E7E] hover:border-[#C5C8D4] hover:text-[#1E2028] transition-colors cursor-pointer whitespace-nowrap"
                      >
                        清空
                      </button>
                    )}
                  </div>

                  <button
                    type="button"
                    data-batch-exit-btn
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setBatchSelectMode(false);
                      setSelectedCardIds(new Set());
                      setConfirmBulkDelete(false);
                      lastBatchClickedIdRef.current = null;
                    }}
                    className="min-h-[34px] px-3 py-1 inline-flex items-center gap-1.5 rounded-[8px] border border-[#E0E0E6] bg-white text-[12px] font-medium text-[#4C5264] hover:border-[#7C5CFC]/45 hover:text-[#1E2028] transition-colors cursor-pointer whitespace-nowrap"
                  >
                    <X className="w-3.5 h-3.5" />
                    <span>退出批量</span>
                  </button>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="flex items-center gap-1.5">
                      <input
                        type="text"
                        value={batchTagInput}
                        onChange={(e) => setBatchTagInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            e.stopPropagation();
                            handleBulkAddTags(e);
                          }
                        }}
                        placeholder="批量添加标签（空格/逗号分隔）"
                        className="w-[175px] sm:w-[205px] min-h-[36px] px-2.5 rounded-[8px] border border-[#E0E0E6] bg-white text-[12px] text-[#1E2028] focus:outline-none focus:border-[#7C5CFC]"
                      />
                      <button
                        type="button"
                        disabled={selectedCardIds.size === 0 || !batchTagInput.trim()}
                        onClick={(e) => handleBulkAddTags(e)}
                        className="min-h-[36px] px-3 py-1 inline-flex items-center gap-1.5 rounded-[8px] border border-[#DDD8FA] bg-[#F4F2FF] text-[12px] font-medium text-[#6B48F5] hover:bg-[#EBE6FF] disabled:opacity-40 transition-colors cursor-pointer whitespace-nowrap"
                      >
                        <Tag className="w-3.5 h-3.5" />
                        <span>打标签</span>
                      </button>
                    </div>

                    <button
                      type="button"
                      disabled={selectedCardIds.size === 0}
                      onClick={(e) => handleBulkTogglePrivate(!privateView, e)}
                      className="min-h-[36px] px-3 py-1 inline-flex items-center gap-1.5 rounded-[8px] border border-[#E5C4D6] bg-[#FDF6FA] text-[12px] font-medium text-[#8C3665] hover:bg-[#F9EAF2] hover:border-[#D39BB9] disabled:opacity-40 transition-colors cursor-pointer whitespace-nowrap"
                    >
                      {privateView ? (
                        <Eye className="w-3.5 h-3.5" />
                      ) : (
                        <EyeOff className="w-3.5 h-3.5" />
                      )}
                      <span>{privateView ? '取消私密' : '设为私密'}</span>
                    </button>

                    {boundDirHandle && (
                      <button
                        type="button"
                        disabled={selectedCardIds.size === 0 || isSyncingFolder}
                        onClick={(e) =>
                          void handleSyncScopedCardsToFolder(
                            scopedCardsRef.current.filter((c) => selectedCardIds.has(c.id)),
                            e
                          )
                        }
                        className="min-h-[36px] px-3 py-1 inline-flex items-center gap-1.5 rounded-[8px] border border-emerald-300 bg-emerald-50 text-[12px] font-medium text-emerald-800 hover:bg-emerald-100/80 disabled:opacity-40 transition-colors cursor-pointer whitespace-nowrap"
                      >
                        <FolderSync className="w-3.5 h-3.5" />
                        <span>写入文件夹</span>
                      </button>
                    )}
                  </div>

                  {/* 危险删除独立隔离区（完全阻止默认事件与冒泡） */}
                  <div className="flex flex-wrap items-center gap-2 sm:pl-3 sm:border-l sm:border-[#E5E2F5]">
                    {confirmBulkDelete ? (
                      <div className="inline-flex flex-wrap items-center gap-2 p-1 rounded-[9px] border border-[#F5B8C4] bg-[#FFF1F3]">
                        <button
                          type="button"
                          onClick={(e) => handleBulkDeleteSelected(e)}
                          className="min-h-[36px] px-4 py-1 inline-flex items-center gap-1.5 rounded-[8px] bg-[#D92D4B] text-white text-[12px] font-semibold shadow-[0_2px_8px_rgba(217,45,75,0.28)] hover:bg-[#BE1E3A] transition-colors cursor-pointer whitespace-nowrap"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>确认彻底删除 ({selectedCardIds.size})</span>
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setConfirmBulkDelete(false);
                          }}
                          className="min-h-[36px] px-3 py-1 rounded-[8px] border border-[#E0E0E6] bg-white text-[12px] font-medium text-[#4C5264] hover:text-[#1E2028] transition-colors cursor-pointer whitespace-nowrap"
                        >
                          取消
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        data-batch-delete-trigger
                        disabled={selectedCardIds.size === 0}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setConfirmBulkDelete(true);
                        }}
                        className="min-h-[36px] px-4 py-1 inline-flex items-center gap-1.5 rounded-[8px] border border-[#F5B8C4] bg-[#FFF5F7] text-[12px] font-semibold text-[#B42343] hover:bg-[#FFE6EC] hover:border-[#E85D75] disabled:opacity-40 disabled:hover:bg-[#FFF5F7] transition-colors cursor-pointer whitespace-nowrap"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>
                          {selectedCardIds.size > 0
                            ? `批量删除 (${selectedCardIds.size})`
                            : '批量删除'}
                        </span>
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* 常驻底部翻页与快速批量入口 */}
            {filteredCards.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2 text-[11.5px] text-[#4C5264]">
                <div className="flex flex-wrap items-center gap-2 tabular-nums">
                  <span>
                    显示第 {(safePage - 1) * pageSize + 1}–
                    {Math.min(safePage * pageSize, filteredCards.length)} 张，共{' '}
                    {filteredCards.length} 张
                  </span>
                  <select
                    aria-label="每页显示卡片数"
                    value={pageSize}
                    onChange={(e) => setPageSize(Number(e.target.value) as 24 | 48 | 96)}
                    className="h-7 px-2 rounded-[7px] border border-[#E0E0E6] bg-[#FAFAFC] text-[11px] text-[#1E2028]"
                  >
                    <option value={24}>每页 24 张</option>
                    <option value={48}>每页 48 张</option>
                    <option value={96}>每页 96 张</option>
                  </select>
                  {!batchSelectMode && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setBatchSelectMode(true);
                        setSelectedCardIds(new Set());
                        setConfirmBulkDelete(false);
                        lastBatchClickedIdRef.current = null;
                      }}
                      className="h-7 px-2.5 inline-flex items-center gap-1 rounded-[7px] border border-[#E0E0E6] bg-white text-[11px] font-medium text-[#4C5264] hover:border-[#7C5CFC]/50 hover:text-[#6B48F5] cursor-pointer whitespace-nowrap"
                    >
                      <CheckSquare className="w-3.5 h-3.5" />
                      <span>批量整理</span>
                    </button>
                  )}
                </div>

                {totalPages > 1 && (
                  <div className="flex flex-wrap items-center gap-1.5 tabular-nums">
                    <button
                      type="button"
                      disabled={safePage <= 1}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        goToPage(1);
                      }}
                      className="h-7 px-2 rounded-[7px] border border-[#E0E0E6] bg-white text-[11px] hover:border-[#7C5CFC]/50 disabled:opacity-40 cursor-pointer"
                    >
                      首页
                    </button>
                    <button
                      type="button"
                      disabled={safePage <= 1}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        goToPage(safePage - 1);
                      }}
                      className="h-7 px-2.5 inline-flex items-center gap-1 rounded-[7px] border border-[#E0E0E6] bg-white hover:border-[#7C5CFC]/50 disabled:opacity-40 cursor-pointer"
                    >
                      <ChevronLeft className="w-3.5 h-3.5" />
                      <span>上一页</span>
                    </button>
                    <select
                      aria-label="快速跳转页码"
                      value={safePage}
                      onChange={(e) => {
                        e.stopPropagation();
                        goToPage(Number(e.target.value));
                      }}
                      className="h-7 px-2 rounded-[7px] border border-[#E0E0E6] bg-[#FAFAFC] font-mono text-[11px] text-[#1E2028]"
                    >
                      {Array.from({ length: totalPages }, (_, idx) => idx + 1).map((p) => (
                        <option key={p} value={p}>
                          第 {p} / {totalPages} 页
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      disabled={safePage >= totalPages}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        goToPage(safePage + 1);
                      }}
                      className="h-7 px-2.5 inline-flex items-center gap-1 rounded-[7px] border border-[#E0E0E6] bg-white hover:border-[#7C5CFC]/50 disabled:opacity-40 cursor-pointer"
                    >
                      <span>下一页</span>
                      <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={safePage >= totalPages}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        goToPage(totalPages);
                      }}
                      className="h-7 px-2 rounded-[7px] border border-[#E0E0E6] bg-white text-[11px] hover:border-[#7C5CFC]/50 disabled:opacity-40 cursor-pointer"
                    >
                      末页
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

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
              <div className="shrink-0 px-4 sm:px-5 py-3.5 border-b border-[#EAEAEF] flex flex-wrap items-center justify-between gap-2.5">
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <DrawerThumbnailButton
                    card={editingCard}
                    alt={editTitle}
                    onOpenLightbox={(id) => setLightboxCardId(id)}
                  />
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
            <div className="shrink-0 max-w-[1200px] w-full mx-auto flex flex-wrap items-center justify-between gap-2.5 pb-3 text-white">
              <div className="flex flex-wrap items-center gap-2 min-w-0">
                <h3 className="text-[14.5px] font-semibold truncate max-w-[320px] sm:max-w-[420px]">
                  {lightboxCard.title}
                </h3>

                {lightboxCard.isPrivate && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[6px] bg-[#E85D75]/25 border border-[#E85D75]/60 text-[11px] font-medium text-[#FFD3DC] whitespace-nowrap">
                    <EyeOff className="w-3 h-3" />
                    <span>私密</span>
                  </span>
                )}

                {cardHasLosslessOriginal(lightboxCard) ? (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-[6px] bg-emerald-500/20 border border-emerald-400/50 text-[11px] font-medium text-emerald-200 whitespace-nowrap tabular-nums">
                    原图无损
                    {lightboxCard.originalImageWidth && lightboxCard.originalImageHeight
                      ? ` · ${lightboxCard.originalImageWidth}×${lightboxCard.originalImageHeight}`
                      : ''}
                    {lightboxCard.imageByteSize
                      ? ` · ${formatBytesCompact(lightboxCard.imageByteSize)}`
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

              <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 shrink-0">
                {filteredCards.length > 1 && lightboxIndex >= 0 && (
                  <span className="text-[11.5px] text-white/70 font-mono tabular-nums mr-1">
                    {lightboxIndex + 1} / {filteredCards.length}
                  </span>
                )}

                <button
                  type="button"
                  onClick={(e) => handleToggleCardPrivate(lightboxCard.id, e)}
                  className="h-8 px-2.5 inline-flex items-center gap-1.5 rounded-[8px] bg-white/10 hover:bg-white/20 border border-white/15 text-[11.5px] text-white cursor-pointer whitespace-nowrap"
                >
                  {lightboxCard.isPrivate ? (
                    <Eye className="w-3.5 h-3.5" />
                  ) : (
                    <EyeOff className="w-3.5 h-3.5" />
                  )}
                  <span>{lightboxCard.isPrivate ? '取消私密' : '设为私密'}</span>
                </button>

                <button
                  type="button"
                  onClick={() => void handleDownloadCardOriginalImage(lightboxCard)}
                  className="h-8 px-2.5 inline-flex items-center gap-1.5 rounded-[8px] bg-white/10 hover:bg-white/20 border border-white/15 text-[11.5px] text-white cursor-pointer whitespace-nowrap"
                >
                  <ImageDown className="w-3.5 h-3.5" />
                  <span>下载原图</span>
                </button>

                <button
                  type="button"
                  onClick={() => handleDownloadCardJson(lightboxCard)}
                  className="h-8 px-2.5 inline-flex items-center gap-1.5 rounded-[8px] bg-white/10 hover:bg-white/20 border border-white/15 text-[11.5px] text-white cursor-pointer whitespace-nowrap"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>下载 JSON</span>
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

              <LightboxImageElement card={lightboxCard} />

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
              点击空白处或按 Esc 关闭预览 · 左右方向键切换卡片（当前{privateView ? '私密' : '公开'}视图范围）
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

