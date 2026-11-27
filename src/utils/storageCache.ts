import {
  QuickFillCategory,
  StudioConfig,
  WorkflowCollectionCard,
} from '../types/studio';

export const STUDIO_CONFIG_KEY = 'chibiprompt_studio_config_v3';
export const STUDIO_HISTORY_KEY = 'chibiprompt_studio_history_v3';
export const STUDIO_UI_CACHE_KEY = 'chibiprompt_studio_ui_cache_v1';
export const STUDIO_WORKFLOW_CARDS_KEY = 'chibiprompt_studio_workflow_cards_v1';
export const STUDIO_DELETED_CARD_TOMBSTONES_KEY = 'chibiprompt_deleted_card_tombstones_v1';

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
    const rawThumb =
      typeof rec.thumbnailDataUrl === 'string' ? rec.thumbnailDataUrl : '';
    const rawOriginal =
      typeof rec.originalImageDataUrl === 'string' && rec.originalImageDataUrl
        ? rec.originalImageDataUrl
        : undefined;
    const hasBlob = Boolean(rec.hasOriginalImageBlob);
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
      thumbnailDataUrl: hasBlob ? '' : rawThumb || rawOriginal || '',
      originalImageDataUrl: hasBlob ? undefined : rawOriginal,
      originalImageMime:
        typeof rec.originalImageMime === 'string' ? rec.originalImageMime : undefined,
      originalImageWidth:
        typeof rec.originalImageWidth === 'number' &&
        Number.isFinite(rec.originalImageWidth) &&
        rec.originalImageWidth > 0
          ? Math.round(rec.originalImageWidth)
          : undefined,
      originalImageHeight:
        typeof rec.originalImageHeight === 'number' &&
        Number.isFinite(rec.originalImageHeight) &&
        rec.originalImageHeight > 0
          ? Math.round(rec.originalImageHeight)
          : undefined,
      hasOriginalImageBlob: hasBlob || Boolean(rawOriginal),
      imageByteSize:
        typeof rec.imageByteSize === 'number' &&
        Number.isFinite(rec.imageByteSize) &&
        rec.imageByteSize > 0
          ? Math.round(rec.imageByteSize)
          : undefined,
      autoImportedSource:
        rec.autoImportedSource === 'png' ||
        rec.autoImportedSource === 'json' ||
        rec.autoImportedSource === 'manual'
          ? rec.autoImportedSource
          : undefined,
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
      imageContentHash:
        typeof rec.imageContentHash === 'string' && rec.imageContentHash
          ? rec.imageContentHash
          : undefined,
      contentFingerprint:
        typeof rec.contentFingerprint === 'string' && rec.contentFingerprint
          ? rec.contentFingerprint
          : undefined,
      folderSyncedPath:
        typeof rec.folderSyncedPath === 'string' && rec.folderSyncedPath
          ? rec.folderSyncedPath
          : undefined,
      folderSyncedFingerprint:
        typeof rec.folderSyncedFingerprint === 'string' && rec.folderSyncedFingerprint
          ? rec.folderSyncedFingerprint
          : undefined,
      folderSyncedImageHash:
        typeof rec.folderSyncedImageHash === 'string' && rec.folderSyncedImageHash
          ? rec.folderSyncedImageHash
          : undefined,
      lastRunAt: typeof rec.lastRunAt === 'number' ? rec.lastRunAt : undefined,
      lastPromptId:
        typeof rec.lastPromptId === 'string' ? rec.lastPromptId : undefined,
      lastFolderSyncAt:
        typeof rec.lastFolderSyncAt === 'number' ? rec.lastFolderSyncAt : undefined,
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

export function mergeImportedWorkflowCards(
  existing: WorkflowCollectionCard[],
  incoming: WorkflowCollectionCard[]
): WorkflowCollectionCard[] {
  const existingIds = new Set(existing.map((c) => c.id));
  const now = Date.now();
  const dedupedIncoming = incoming.map((card, idx) => {
    let nextId = card.id;
    if (existingIds.has(nextId)) {
      nextId = `${card.id}-imp-${now}-${idx}`;
    }
    existingIds.add(nextId);
    return nextId === card.id ? card : { ...card, id: nextId };
  });
  return [...dedupedIncoming, ...existing];
}

const STUDIO_IDB_NAME = 'chibiprompt_studio_db_v1';
const STUDIO_IDB_VERSION = 2;
const STUDIO_IDB_CARDS_STORE = 'workflow_cards';
const STUDIO_IDB_IMAGES_STORE = 'card_images';
const STUDIO_IDB_FS_STORE = 'fs_handles';
const STUDIO_IDB_CARDS_KEY = 'cards_v1';
const STUDIO_IDB_TOMBSTONES_KEY = 'deleted_tombstones_v1';
const STUDIO_IDB_DIR_KEY = 'bound_workflow_dir';

export interface DeletedCardTombstone {
  cardId: string;
  title?: string;
  deletedAt: number;
  contentFingerprint?: string;
  imageContentHash?: string;
  imageName?: string;
  imageByteSize?: number;
  relativePath?: string;
  diskFilesDeleted: boolean;
}

export interface StoredCardImageRecord {
  blob: Blob;
  mimeType: string;
  width?: number;
  height?: number;
  byteSize: number;
  updatedAt: number;
}

export function isIndexedDbSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined';
}

function openStudioDb(): Promise<IDBDatabase | null> {
  if (!isIndexedDbSupported()) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = window.indexedDB.open(STUDIO_IDB_NAME, STUDIO_IDB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STUDIO_IDB_CARDS_STORE)) {
          db.createObjectStore(STUDIO_IDB_CARDS_STORE);
        }
        if (!db.objectStoreNames.contains(STUDIO_IDB_IMAGES_STORE)) {
          db.createObjectStore(STUDIO_IDB_IMAGES_STORE);
        }
        if (!db.objectStoreNames.contains(STUDIO_IDB_FS_STORE)) {
          db.createObjectStore(STUDIO_IDB_FS_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export function decodeDataUrlToBlob(dataUrl: string): Blob {
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx < 0) {
    throw new Error('无效的图像 DataURL');
  }
  const header = dataUrl.slice(0, commaIdx);
  const body = dataUrl.slice(commaIdx + 1);
  const mimeMatch = header.match(/data:([^;]+)/i);
  const mimeType = mimeMatch ? mimeMatch[1] : 'application/octet-stream';

  if (/;base64/i.test(header)) {
    const binStr = atob(body);
    const bytes = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) {
      bytes[i] = binStr.charCodeAt(i);
    }
    return new Blob([bytes], { type: mimeType });
  }
  return new Blob([decodeURIComponent(body)], { type: mimeType });
}

export function encodeBlobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('无法编码图像数据'));
      }
    };
    reader.onerror = () => reject(new Error('读取图像 Blob 失败'));
    reader.readAsDataURL(blob);
  });
}

export async function saveCardImageBlob(
  cardId: string,
  record: StoredCardImageRecord
): Promise<boolean> {
  return saveCardImageBlobsBatch([{ cardId, record }]);
}

export async function saveCardImageBlobsBatch(
  entries: { cardId: string; record: StoredCardImageRecord }[]
): Promise<boolean> {
  if (entries.length === 0) return true;
  const db = await openStudioDb();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STUDIO_IDB_IMAGES_STORE, 'readwrite');
      const store = tx.objectStore(STUDIO_IDB_IMAGES_STORE);
      for (const entry of entries) {
        store.put(entry.record, entry.cardId);
      }
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

export async function loadCardImageBlob(
  cardId: string
): Promise<StoredCardImageRecord | null> {
  const db = await openStudioDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STUDIO_IDB_IMAGES_STORE, 'readonly');
      const store = tx.objectStore(STUDIO_IDB_IMAGES_STORE);
      const req = store.get(cardId);
      req.onsuccess = () => {
        const res = req.result as Partial<StoredCardImageRecord> | undefined;
        if (res && res.blob instanceof Blob) {
          resolve({
            blob: res.blob,
            mimeType: res.mimeType || res.blob.type || 'image/png',
            width: res.width,
            height: res.height,
            byteSize: res.byteSize ?? res.blob.size,
            updatedAt: res.updatedAt ?? Date.now(),
          });
        } else {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function listStoredCardImageIds(): Promise<Set<string>> {
  const db = await openStudioDb();
  if (!db) return new Set();
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STUDIO_IDB_IMAGES_STORE, 'readonly');
      const store = tx.objectStore(STUDIO_IDB_IMAGES_STORE);
      const req = store.getAllKeys();
      req.onsuccess = () => {
        const keys = Array.isArray(req.result)
          ? req.result.filter((k): k is string => typeof k === 'string')
          : [];
        resolve(new Set(keys));
      };
      req.onerror = () => resolve(new Set());
    } catch {
      resolve(new Set());
    }
  });
}

export async function deleteCardImageBlob(cardId: string): Promise<void> {
  await deleteCardImageBlobsBatch([cardId]);
}

export async function deleteCardImageBlobsBatch(cardIds: string[]): Promise<void> {
  if (cardIds.length === 0) return;
  const db = await openStudioDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STUDIO_IDB_IMAGES_STORE, 'readwrite');
      const store = tx.objectStore(STUDIO_IDB_IMAGES_STORE);
      for (const id of cardIds) {
        store.delete(id);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function copyCardImageBlob(
  srcCardId: string,
  destCardId: string
): Promise<boolean> {
  const rec = await loadCardImageBlob(srcCardId);
  if (!rec) return false;
  return saveCardImageBlob(destCardId, {
    ...rec,
    updatedAt: Date.now(),
  });
}

export async function migrateCardInlineImagesToIdb(
  cards: WorkflowCollectionCard[]
): Promise<{ cards: WorkflowCollectionCard[]; migrated: boolean }> {
  if (!isIndexedDbSupported()) return { cards, migrated: false };
  const toStore: { cardId: string; record: StoredCardImageRecord }[] = [];
  let changed = false;

  const nextCards = cards.map((c) => {
    if (!c.originalImageDataUrl) return c;
    try {
      const blob = decodeDataUrlToBlob(c.originalImageDataUrl);
      toStore.push({
        cardId: c.id,
        record: {
          blob,
          mimeType: c.originalImageMime || blob.type || 'image/png',
          width: c.originalImageWidth,
          height: c.originalImageHeight,
          byteSize: blob.size,
          updatedAt: c.updatedAt || Date.now(),
        },
      });
      changed = true;
      return {
        ...c,
        originalImageDataUrl: undefined,
        thumbnailDataUrl: '',
        hasOriginalImageBlob: true,
        imageByteSize: blob.size,
      };
    } catch {
      return c;
    }
  });

  if (!changed) return { cards, migrated: false };
  const ok = await saveCardImageBlobsBatch(toStore);
  if (!ok) return { cards, migrated: false };
  return { cards: nextCards, migrated: true };
}

let idbCardsWriteChain: Promise<boolean> = Promise.resolve(true);

export async function loadWorkflowCardsFromIndexedDbWithState(): Promise<{
  exists: boolean;
  cards: WorkflowCollectionCard[];
}> {
  const db = await openStudioDb();
  if (!db) return { exists: false, cards: [] };
  const rawResult = await new Promise<{ exists: boolean; raw: unknown }>((resolve) => {
    try {
      const tx = db.transaction(STUDIO_IDB_CARDS_STORE, 'readonly');
      const store = tx.objectStore(STUDIO_IDB_CARDS_STORE);
      const req = store.get(STUDIO_IDB_CARDS_KEY);
      req.onsuccess = () => {
        resolve({
          exists: Array.isArray(req.result),
          raw: req.result,
        });
      };
      req.onerror = () => resolve({ exists: false, raw: undefined });
    } catch {
      resolve({ exists: false, raw: undefined });
    }
  });

  if (!rawResult.exists) return { exists: false, cards: [] };
  const rawCards = normalizeWorkflowCards(rawResult.raw);
  if (rawCards.length === 0) return { exists: true, cards: [] };
  const { cards: migratedCards, migrated } = await migrateCardInlineImagesToIdb(rawCards);
  if (migrated) {
    void saveWorkflowCardsToIndexedDb(migratedCards);
  }
  return { exists: true, cards: migratedCards };
}

export async function loadWorkflowCardsFromIndexedDb(): Promise<WorkflowCollectionCard[]> {
  const res = await loadWorkflowCardsFromIndexedDbWithState();
  return res.cards;
}

export function saveWorkflowCardsToIndexedDb(
  cards: WorkflowCollectionCard[]
): Promise<boolean> {
  const snapshot = cards;
  const nextWrite = idbCardsWriteChain.then(async () => {
    const db = await openStudioDb();
    if (!db) return false;
    return new Promise<boolean>((resolve) => {
      try {
        const tx = db.transaction(STUDIO_IDB_CARDS_STORE, 'readwrite');
        const store = tx.objectStore(STUDIO_IDB_CARDS_STORE);
        store.put(snapshot, STUDIO_IDB_CARDS_KEY);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch {
        resolve(false);
      }
    });
  });
  idbCardsWriteChain = nextWrite.catch(() => false);
  return nextWrite;
}

function normalizeDeletedTombstonesMap(
  raw: unknown
): Record<string, DeletedCardTombstone> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const result: Record<string, DeletedCardTombstone> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!val || typeof val !== 'object') continue;
    const rec = val as Partial<DeletedCardTombstone>;
    const cardId = typeof rec.cardId === 'string' && rec.cardId ? rec.cardId : key;
    if (!cardId) continue;
    result[cardId] = {
      cardId,
      title: typeof rec.title === 'string' ? rec.title : undefined,
      deletedAt:
        typeof rec.deletedAt === 'number' && Number.isFinite(rec.deletedAt)
          ? rec.deletedAt
          : Date.now(),
      contentFingerprint:
        typeof rec.contentFingerprint === 'string' ? rec.contentFingerprint : undefined,
      imageContentHash:
        typeof rec.imageContentHash === 'string' ? rec.imageContentHash : undefined,
      imageName: typeof rec.imageName === 'string' ? rec.imageName : undefined,
      imageByteSize:
        typeof rec.imageByteSize === 'number' && Number.isFinite(rec.imageByteSize)
          ? rec.imageByteSize
          : undefined,
      relativePath:
        typeof rec.relativePath === 'string' ? rec.relativePath : undefined,
      diskFilesDeleted: Boolean(rec.diskFilesDeleted),
    };
  }
  return result;
}

function trimTombstonesMap(
  map: Record<string, DeletedCardTombstone>,
  maxEntries = 2000
): Record<string, DeletedCardTombstone> {
  const entries = Object.entries(map);
  if (entries.length <= maxEntries) return map;
  entries.sort((a, b) => b[1].deletedAt - a[1].deletedAt);
  return Object.fromEntries(entries.slice(0, maxEntries));
}

export function mergeDeletedTombstonesMaps(
  base: Record<string, DeletedCardTombstone>,
  incoming: Record<string, DeletedCardTombstone>
): Record<string, DeletedCardTombstone> {
  const next: Record<string, DeletedCardTombstone> = { ...base };
  for (const [id, item] of Object.entries(incoming)) {
    const prev = next[id];
    if (!prev) {
      next[id] = item;
    } else if (item.deletedAt > prev.deletedAt) {
      next[id] = {
        ...prev,
        ...item,
        diskFilesDeleted: item.diskFilesDeleted || prev.diskFilesDeleted,
      };
    } else if (item.deletedAt === prev.deletedAt && item.diskFilesDeleted && !prev.diskFilesDeleted) {
      next[id] = { ...prev, diskFilesDeleted: true };
    }
  }
  return trimTombstonesMap(next);
}

export function loadDeletedCardTombstones(): Record<string, DeletedCardTombstone> {
  try {
    const raw = localStorage.getItem(STUDIO_DELETED_CARD_TOMBSTONES_KEY);
    if (!raw) return {};
    return normalizeDeletedTombstonesMap(JSON.parse(raw));
  } catch {
    return {};
  }
}

export async function loadDeletedCardTombstonesFromIndexedDb(): Promise<
  Record<string, DeletedCardTombstone>
> {
  const localMap = loadDeletedCardTombstones();
  const db = await openStudioDb();
  if (!db) return localMap;
  const idbMap = await new Promise<Record<string, DeletedCardTombstone>>((resolve) => {
    try {
      const tx = db.transaction(STUDIO_IDB_CARDS_STORE, 'readonly');
      const store = tx.objectStore(STUDIO_IDB_CARDS_STORE);
      const req = store.get(STUDIO_IDB_TOMBSTONES_KEY);
      req.onsuccess = () => resolve(normalizeDeletedTombstonesMap(req.result));
      req.onerror = () => resolve({});
    } catch {
      resolve({});
    }
  });
  return mergeDeletedTombstonesMaps(localMap, idbMap);
}

export async function saveDeletedCardTombstones(
  map: Record<string, DeletedCardTombstone>
): Promise<void> {
  const trimmed = trimTombstonesMap(map);
  try {
    localStorage.setItem(STUDIO_DELETED_CARD_TOMBSTONES_KEY, JSON.stringify(trimmed));
  } catch {
    // 忽略 localStorage 配额异常，以 IndexedDB 为准
  }
  const db = await openStudioDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STUDIO_IDB_CARDS_STORE, 'readwrite');
      const store = tx.objectStore(STUDIO_IDB_CARDS_STORE);
      store.put(trimmed, STUDIO_IDB_TOMBSTONES_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function recordDeletedCardTombstones(
  items: DeletedCardTombstone[]
): Promise<Record<string, DeletedCardTombstone>> {
  const current = await loadDeletedCardTombstonesFromIndexedDb();
  const next = { ...current };
  for (const item of items) {
    if (!item.cardId) continue;
    const prev = next[item.cardId];
    next[item.cardId] = prev
      ? {
          ...prev,
          ...item,
          deletedAt: Math.max(prev.deletedAt, item.deletedAt),
          diskFilesDeleted: Boolean(item.diskFilesDeleted || prev.diskFilesDeleted),
        }
      : item;
  }
  const trimmed = trimTombstonesMap(next);
  await saveDeletedCardTombstones(trimmed);
  return trimmed;
}

export async function removeDeletedCardTombstones(
  cardIds: string[]
): Promise<Record<string, DeletedCardTombstone>> {
  const current = await loadDeletedCardTombstonesFromIndexedDb();
  if (cardIds.length === 0) return current;
  let changed = false;
  const next = { ...current };
  for (const id of cardIds) {
    if (id in next) {
      delete next[id];
      changed = true;
    }
  }
  if (changed) {
    await saveDeletedCardTombstones(next);
  }
  return next;
}

export async function saveBoundDirectoryHandle(
  handle: FileSystemDirectoryHandle | null
): Promise<void> {
  const db = await openStudioDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STUDIO_IDB_FS_STORE, 'readwrite');
      const store = tx.objectStore(STUDIO_IDB_FS_STORE);
      const req = handle
        ? store.put(handle, STUDIO_IDB_DIR_KEY)
        : store.delete(STUDIO_IDB_DIR_KEY);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function loadBoundDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
  const db = await openStudioDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STUDIO_IDB_FS_STORE, 'readonly');
      const store = tx.objectStore(STUDIO_IDB_FS_STORE);
      const req = store.get(STUDIO_IDB_DIR_KEY);
      req.onsuccess = () => {
        const res = req.result as FileSystemDirectoryHandle | undefined;
        resolve(res && typeof res.getDirectoryHandle === 'function' ? res : null);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function buildLightweightCardsForLocalStorage(
  cards: WorkflowCollectionCard[]
): WorkflowCollectionCard[] {
  return cards.map((c) => {
    const thumbTooBig = (c.thumbnailDataUrl?.length ?? 0) > 48_000;
    return {
      ...c,
      originalImageDataUrl: undefined,
      thumbnailDataUrl: thumbTooBig ? '' : c.thumbnailDataUrl,
    };
  });
}

export function saveWorkflowCardsSafely(cards: WorkflowCollectionCard[]): {
  ok: boolean;
  error?: string;
} {
  const idbAvailable = isIndexedDbSupported();
  if (idbAvailable) {
    void saveWorkflowCardsToIndexedDb(cards);
  }

  if (cards.length === 0) {
    try {
      localStorage.setItem(STUDIO_WORKFLOW_CARDS_KEY, '[]');
    } catch {
      // 忽略异常
    }
    return { ok: true };
  }

  // 当卡片数量较大或存在大图时，优先持久化轻量索引到 localStorage，避免 JSON.stringify 数百张原图阻塞主线程
  const hasAnyInlineOriginal = cards.some((c) => Boolean(c.originalImageDataUrl));
  if (idbAvailable && (cards.length > 30 || hasAnyInlineOriginal)) {
    try {
      const lightPayload = JSON.stringify(buildLightweightCardsForLocalStorage(cards));
      if (lightPayload.length < 2_500_000) {
        localStorage.setItem(STUDIO_WORKFLOW_CARDS_KEY, lightPayload);
      } else {
        // 避免 localStorage 残留过期的旧列表而在刷新时复活已删除卡片
        localStorage.removeItem(STUDIO_WORKFLOW_CARDS_KEY);
      }
    } catch {
      // IndexedDB 已完成持久化，忽略 localStorage 配额限制
      try {
        localStorage.removeItem(STUDIO_WORKFLOW_CARDS_KEY);
      } catch {
        // ignore
      }
    }
    return { ok: true };
  }

  try {
    const payload = JSON.stringify(cards);
    localStorage.setItem(STUDIO_WORKFLOW_CARDS_KEY, payload);
    return { ok: true };
  } catch {
    try {
      const lightPayload = JSON.stringify(buildLightweightCardsForLocalStorage(cards));
      localStorage.setItem(STUDIO_WORKFLOW_CARDS_KEY, lightPayload);
      if (idbAvailable) {
        return { ok: true };
      }
      return {
        ok: true,
        error:
          '当前环境 localStorage 容量已达上限，已降级保存卡片结构与提示词（建议绑定本地文件夹落盘保存原图）。',
      };
    } catch {
      if (idbAvailable) {
        return { ok: true };
      }
      return {
        ok: false,
        error:
          '本地存储空间已满（QuotaExceeded），本次收藏卡片未能写入缓存。建议绑定本地文件夹写入或导出备份。',
      };
    }
  }
}



