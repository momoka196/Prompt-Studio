import { useEffect, useState } from 'react';
import { WorkflowCollectionCard } from '../types/studio';
import { loadCardImageBlob } from './storageCache';

const MAX_OBJECT_URL_CACHE = 120;

interface CacheEntry {
  url: string;
  version: number;
}

const urlCache = new Map<string, CacheEntry>();
const pendingLoads = new Map<string, Promise<string | null>>();

function setCacheEntry(cardId: string, entry: CacheEntry): void {
  const existing = urlCache.get(cardId);
  if (existing && existing.url !== entry.url) {
    URL.revokeObjectURL(existing.url);
    urlCache.delete(cardId);
  }
  urlCache.set(cardId, entry);

  while (urlCache.size > MAX_OBJECT_URL_CACHE) {
    const oldestKey = urlCache.keys().next().value;
    if (!oldestKey) break;
    const oldest = urlCache.get(oldestKey);
    urlCache.delete(oldestKey);
    if (oldest) {
      URL.revokeObjectURL(oldest.url);
    }
  }
}

export function getCachedCardImageUrl(card: WorkflowCollectionCard): string | null {
  if (card.originalImageDataUrl) return card.originalImageDataUrl;
  if (card.hasOriginalImageBlob) {
    const hit = urlCache.get(card.id);
    if (hit && hit.version === card.updatedAt) {
      urlCache.delete(card.id);
      urlCache.set(card.id, hit);
      return hit.url;
    }
    return null;
  }
  return card.thumbnailDataUrl || null;
}

export async function loadAndCacheCardImageUrl(
  card: WorkflowCollectionCard
): Promise<string | null> {
  if (card.originalImageDataUrl) return card.originalImageDataUrl;
  if (!card.hasOriginalImageBlob) return card.thumbnailDataUrl || null;

  const hit = urlCache.get(card.id);
  if (hit && hit.version === card.updatedAt) {
    urlCache.delete(card.id);
    urlCache.set(card.id, hit);
    return hit.url;
  }

  const inflight = pendingLoads.get(card.id);
  if (inflight) return inflight;

  const promise = (async () => {
    try {
      const stored = await loadCardImageBlob(card.id);
      if (!stored) {
        return card.thumbnailDataUrl || null;
      }
      const objectUrl = URL.createObjectURL(stored.blob);
      setCacheEntry(card.id, { url: objectUrl, version: card.updatedAt });
      return objectUrl;
    } catch {
      return card.thumbnailDataUrl || null;
    } finally {
      pendingLoads.delete(card.id);
    }
  })();

  pendingLoads.set(card.id, promise);
  return promise;
}

export function invalidateCardImageCache(cardIds: string[]): void {
  for (const id of cardIds) {
    const entry = urlCache.get(id);
    if (entry) {
      URL.revokeObjectURL(entry.url);
      urlCache.delete(id);
    }
    pendingLoads.delete(id);
  }
}

export function clearCardImageCache(): void {
  for (const entry of urlCache.values()) {
    URL.revokeObjectURL(entry.url);
  }
  urlCache.clear();
  pendingLoads.clear();
}

export function useCardImageSrc(card: WorkflowCollectionCard | null): {
  src: string | null;
  loading: boolean;
} {
  const [src, setSrc] = useState<string | null>(() =>
    card ? getCachedCardImageUrl(card) : null
  );
  const [loading, setLoading] = useState<boolean>(() =>
    Boolean(card && card.hasOriginalImageBlob && !getCachedCardImageUrl(card))
  );

  useEffect(() => {
    if (!card) {
      setSrc(null);
      setLoading(false);
      return;
    }

    const immediate = getCachedCardImageUrl(card);
    if (immediate) {
      setSrc(immediate);
      setLoading(false);
      return;
    }

    if (!card.hasOriginalImageBlob) {
      setSrc(card.thumbnailDataUrl || null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    void loadAndCacheCardImageUrl(card).then((resolved) => {
      if (cancelled) return;
      setSrc(resolved);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [card?.id, card?.updatedAt, card?.originalImageDataUrl, card?.hasOriginalImageBlob, card?.thumbnailDataUrl]);

  return { src, loading };
}

export function formatBytesCompact(bytes?: number): string {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
