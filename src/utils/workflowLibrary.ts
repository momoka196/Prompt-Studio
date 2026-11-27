import {
  ComfyProfile,
  WorkflowCollectionCard,
  WorkflowJsonFormat,
  WorkflowPromptNodeCandidate,
  WorkflowPromptTagItem,
} from '../types/studio';
import {
  clampWeight,
  formatWeightedText,
  parseComfyErrorResponse,
  postProfileToComfyUI,
  sanitizeFilenamePrefix,
  splitPromptTags,
} from './promptBuilder';
import {
  computeBlobContentHash,
  computeCardSyncContentHash,
  computeFastStringDigest64,
  decodeDataUrlToBlob,
  DeletedCardTombstone,
  encodeBlobToDataUrl,
  FolderSyncProgress,
  isIndexedDbSupported,
  listStoredCardImageIds,
  loadCardImageBlob,
  mergeDeletedTombstonesMaps,
  normalizeWorkflowCards,
  runIncrementalFolderSync,
  saveCardImageBlobsBatch,
  StoredCardImageRecord,
} from './storageCache';

type ComfyApiNode = {
  class_type: string;
  inputs: Record<string, unknown>;
};

export type ComfyApiGraph = Record<string, ComfyApiNode>;

interface UiNodeLinkTarget {
  name?: string;
  type?: string;
  link?: number | null;
  widget?: { name?: string };
}

interface UiWorkflowNode {
  id: number;
  type: string;
  title?: string;
  mode?: number;
  inputs?: UiNodeLinkTarget[];
  outputs?: { name?: string; type?: string; links?: number[] | null }[];
  widgets_values?: unknown[];
  widgets_values_named?: Record<string, unknown>;
}

interface UiWorkflowObject {
  nodes: UiWorkflowNode[];
  links?: unknown[];
  [key: string]: unknown;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const SAMPLER_NODE_TYPES = new Set([
  'KSampler',
  'KSamplerAdvanced',
  'SamplerCustom',
  'SamplerCustomAdvanced',
  'KSampler (Efficient)',
  'KSamplerSelect',
  'UltimateSDUpscale',
]);

const TEXT_ENCODE_NODE_RE =
  /^(?:CLIPTextEncode.*|Conditioning.*|FluxGuidance|BNK_CLIPTextEncodeAdvanced|ShowText.*|ttN text.*|CR Prompt Text|PrimitiveString.*|StringLiteral|String|Text.*|easy positive|easy negative|WildcardEncode.*)$/i;

const UI_WIDGET_KEY_MAP: Record<string, (string | null)[]> = {
  CheckpointLoaderSimple: ['ckpt_name'],
  UNETLoader: ['unet_name', 'weight_dtype'],
  CLIPLoader: ['clip_name', 'type', 'device'],
  VAELoader: ['vae_name'],
  LoraLoader: ['lora_name', 'strength_model', 'strength_clip'],
  LoraLoaderModelOnly: ['lora_name', 'strength_model'],
  CLIPTextEncode: ['text'],
  CLIPTextEncodeSDXL: ['width', 'height', 'crop_w', 'crop_h', 'target_width', 'target_height', 'text_g', 'text_l'],
  CLIPTextEncodeFlux: ['clip_l', 't5xxl', 'guidance'],
  EmptyLatentImage: ['width', 'height', 'batch_size'],
  EmptySD3LatentImage: ['width', 'height', 'batch_size'],
  KSampler: ['seed', null, 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise'],
  KSamplerAdvanced: [
    'add_noise',
    'noise_seed',
    null,
    'steps',
    'cfg',
    'sampler_name',
    'scheduler',
    'start_at_step',
    'end_at_step',
    'return_with_leftover_noise',
  ],
  SaveImage: ['filename_prefix'],
  PrimitiveStringMultiline: ['value'],
  PrimitiveString: ['value'],
  PrimitiveBoolean: ['value'],
  PrimitiveInt: ['value', null],
  PrimitiveFloat: ['value'],
  ComfySwitchNode: ['switch'],
  StringConcatenate: ['string_a', 'string_b', 'delimiter'],
  FluxGuidance: ['guidance'],
};

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) >>> 0) |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    bytes[offset + 3]
  ) >>> 0;
}

function decodeLatin1(bytes: Uint8Array): string {
  let out = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return out;
}

function decodeUtf8OrLatin1(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return decodeLatin1(bytes);
  }
}

async function inflateZlibBytes(compressed: Uint8Array): Promise<string | null> {
  if (typeof DecompressionStream === 'undefined') return null;
  const tryFormats: ('deflate' | 'deflate-raw')[] = ['deflate', 'deflate-raw'];
  for (const fmt of tryFormats) {
    try {
      const ds = new DecompressionStream(fmt);
      const writer = ds.writable.getWriter();
      const copy = new Uint8Array(compressed.byteLength);
      copy.set(compressed);
      await writer.write(copy);
      await writer.close();
      const resp = new Response(ds.readable);
      const ab = await resp.arrayBuffer();
      return decodeUtf8OrLatin1(new Uint8Array(ab));
    } catch {
      // try next deflate framing
    }
  }
  return null;
}

export interface A1111PngParametersMeta {
  positive: string;
  negative: string;
  seed?: number;
  steps?: number;
  cfg?: number;
  sampler?: string;
  model?: string;
  rawParameters: string;
}

export interface ExtractedPngComfyMetadata {
  isPng: boolean;
  workflowJson?: string;
  apiPromptJson?: string;
  chibipromptMeta?: {
    character?: string;
    positive?: string;
    negative?: string;
  };
  a1111Meta?: A1111PngParametersMeta;
  rawChunks: Record<string, string>;
}

function parseA1111ParametersText(raw: string): A1111PngParametersMeta | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const lines = trimmed.split(/\r?\n/);
  const negIdx = lines.findIndex((l) => /^Negative prompt:/i.test(l.trim()));
  const stepsIdx = lines.findIndex((l) => /^Steps:\s*\d+/i.test(l.trim()));
  if (negIdx < 0 && stepsIdx < 0) return undefined;

  const posEnd = negIdx >= 0 ? negIdx : stepsIdx >= 0 ? stepsIdx : lines.length;
  const positive = lines.slice(0, posEnd).join('\n').trim();

  let negative = '';
  if (negIdx >= 0) {
    const negEnd = stepsIdx > negIdx ? stepsIdx : lines.length;
    const negLines = lines.slice(negIdx, negEnd);
    negLines[0] = negLines[0].replace(/^Negative prompt:\s*/i, '');
    negative = negLines.join('\n').trim();
  }

  let seed: number | undefined;
  let steps: number | undefined;
  let cfg: number | undefined;
  let sampler: string | undefined;
  let model: string | undefined;

  if (stepsIdx >= 0) {
    const metaLine = lines.slice(stepsIdx).join(' ');
    const stepsMatch = metaLine.match(/Steps:\s*(\d+)/i);
    if (stepsMatch) steps = parseInt(stepsMatch[1], 10);
    const cfgMatch = metaLine.match(/CFG scale:\s*([0-9.]+)/i);
    if (cfgMatch) cfg = parseFloat(cfgMatch[1]);
    const seedMatch = metaLine.match(/Seed:\s*(\d+)/i);
    if (seedMatch) seed = parseInt(seedMatch[1], 10);
    const samplerMatch = metaLine.match(/Sampler:\s*([^,]+)/i);
    if (samplerMatch) sampler = samplerMatch[1].trim();
    const modelMatch = metaLine.match(/Model:\s*([^,]+)/i);
    if (modelMatch) model = modelMatch[1].trim();
  }

  if (!positive && !negative) return undefined;
  return {
    positive,
    negative,
    seed,
    steps,
    cfg,
    sampler,
    model,
    rawParameters: trimmed,
  };
}

export async function extractComfyMetadataFromPngBuffer(
  input: ArrayBuffer | Uint8Array
): Promise<ExtractedPngComfyMetadata> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 16) {
    return { isPng: false, rawChunks: {} };
  }
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) {
      return { isPng: false, rawChunks: {} };
    }
  }

  const rawChunks: Record<string, string> = {};
  let offset = 8;

  while (offset + 12 <= bytes.length) {
    const length = readUint32BE(bytes, offset);
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7]
    );
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) break;

    const data = bytes.subarray(dataStart, dataEnd);

    if (type === 'tEXt') {
      const nullIdx = data.indexOf(0);
      if (nullIdx > 0) {
        const keyword = decodeLatin1(data.subarray(0, nullIdx));
        const text = decodeUtf8OrLatin1(data.subarray(nullIdx + 1));
        rawChunks[keyword] = text;
      }
    } else if (type === 'zTXt') {
      const nullIdx = data.indexOf(0);
      if (nullIdx > 0 && nullIdx + 2 <= data.length) {
        const keyword = decodeLatin1(data.subarray(0, nullIdx));
        const compressionMethod = data[nullIdx + 1];
        if (compressionMethod === 0) {
          const inflated = await inflateZlibBytes(data.subarray(nullIdx + 2));
          if (inflated !== null) {
            rawChunks[keyword] = inflated;
          }
        }
      }
    } else if (type === 'iTXt') {
      const null1 = data.indexOf(0);
      if (null1 > 0 && null1 + 3 <= data.length) {
        const keyword = decodeLatin1(data.subarray(0, null1));
        const compressionFlag = data[null1 + 1];
        const compressionMethod = data[null1 + 2];
        const null2 = data.indexOf(0, null1 + 3);
        const null3 = null2 >= 0 ? data.indexOf(0, null2 + 1) : -1;
        if (null3 >= 0) {
          const textBytes = data.subarray(null3 + 1);
          if (compressionFlag === 1 && compressionMethod === 0) {
            const inflated = await inflateZlibBytes(textBytes);
            if (inflated !== null) {
              rawChunks[keyword] = inflated;
            }
          } else {
            rawChunks[keyword] = decodeUtf8OrLatin1(textBytes);
          }
        }
      }
    } else if (type === 'IEND') {
      break;
    }

    offset = dataEnd + 4;
  }

  const findChunkValue = (targetKey: string): string | undefined => {
    if (rawChunks[targetKey] !== undefined) return rawChunks[targetKey];
    const lowerTarget = targetKey.toLowerCase();
    for (const [k, v] of Object.entries(rawChunks)) {
      if (k.toLowerCase() === lowerTarget) return v;
    }
    return undefined;
  };

  let workflowJson: string | undefined;
  let apiPromptJson: string | undefined;
  let chibipromptMeta: ExtractedPngComfyMetadata['chibipromptMeta'];
  let a1111Meta: A1111PngParametersMeta | undefined;

  const rawWorkflowChunk = findChunkValue('workflow');
  if (rawWorkflowChunk) {
    try {
      JSON.parse(rawWorkflowChunk);
      workflowJson = rawWorkflowChunk;
    } catch {
      // ignore invalid JSON
    }
  }
  const rawPromptChunk = findChunkValue('prompt');
  if (rawPromptChunk) {
    try {
      JSON.parse(rawPromptChunk);
      apiPromptJson = rawPromptChunk;
    } catch {
      // ignore invalid JSON
    }
  }
  const rawChibiChunk = findChunkValue('chibiprompt');
  if (rawChibiChunk) {
    try {
      const parsed = JSON.parse(rawChibiChunk) as Record<string, unknown>;
      chibipromptMeta = {
        character: typeof parsed.character === 'string' ? parsed.character : undefined,
        positive: typeof parsed.positive === 'string' ? parsed.positive : undefined,
        negative: typeof parsed.negative === 'string' ? parsed.negative : undefined,
      };
    } catch {
      // ignore invalid JSON
    }
  }

  if (!workflowJson && !apiPromptJson && !chibipromptMeta) {
    const rawParamsChunk = findChunkValue('parameters');
    if (rawParamsChunk) {
      a1111Meta = parseA1111ParametersText(rawParamsChunk);
    }
  }

  return {
    isPng: true,
    workflowJson,
    apiPromptJson,
    chibipromptMeta,
    a1111Meta,
    rawChunks,
  };
}

export async function extractComfyMetadataFromPngFile(
  file: File
): Promise<ExtractedPngComfyMetadata> {
  const buf = await file.arrayBuffer();
  return extractComfyMetadataFromPngBuffer(buf);
}

export interface OriginalImageReadResult {
  dataUrl: string;
  mimeType: string;
  width?: number;
  height?: number;
  byteSize: number;
}

export async function readImageDimensions(
  file: Blob
): Promise<{ width?: number; height?: number }> {
  // 仅非破坏性探测原图尺寸，绝不经 Canvas 缩放或有损重编码
  const objectUrl = URL.createObjectURL(file);
  try {
    const dims = await new Promise<{ w: number; h: number }>((resolve, reject) => {
      const img = new Image();
      img.onload = () =>
        resolve({
          w: img.naturalWidth || img.width || 0,
          h: img.naturalHeight || img.height || 0,
        });
      img.onerror = () => reject(new Error('无法解码图片尺寸'));
      img.src = objectUrl;
    });
    if (dims.w > 0 && dims.h > 0) {
      return { width: dims.w, height: dims.h };
    }
    return {};
  } catch {
    return {};
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function readImageOriginalData(
  file: File
): Promise<OriginalImageReadResult> {
  const [dataUrl, dims] = await Promise.all([
    encodeBlobToDataUrl(file),
    readImageDimensions(file),
  ]);

  return {
    dataUrl,
    mimeType: file.type || 'image/png',
    width: dims.width,
    height: dims.height,
    byteSize: file.size,
  };
}

export function isApiPromptDict(obj: unknown): obj is ComfyApiGraph {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const rec = obj as Record<string, unknown>;
  const entries = Object.entries(rec);
  if (entries.length === 0) return false;
  let validCount = 0;
  for (const [, val] of entries) {
    if (
      val &&
      typeof val === 'object' &&
      !Array.isArray(val) &&
      typeof (val as Record<string, unknown>).class_type === 'string' &&
      (val as Record<string, unknown>).inputs &&
      typeof (val as Record<string, unknown>).inputs === 'object'
    ) {
      validCount += 1;
    }
  }
  return validCount > 0 && validCount >= Math.min(2, entries.length);
}

export function isUiWorkflowObject(obj: unknown): obj is UiWorkflowObject {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  return Array.isArray((obj as Record<string, unknown>).nodes);
}

function getUiWidgetString(node: UiWorkflowNode, keyCandidates: string[]): string {
  if (node.widgets_values_named && typeof node.widgets_values_named === 'object') {
    for (const k of keyCandidates) {
      const val = node.widgets_values_named[k];
      if (typeof val === 'string') return val;
    }
  }
  if (Array.isArray(node.widgets_values)) {
    for (const v of node.widgets_values) {
      if (typeof v === 'string' && v.trim().length > 0) return v;
    }
  }
  return '';
}

function getUiWidgetBoolean(node: UiWorkflowNode, key = 'value'): boolean | null {
  if (node.widgets_values_named && typeof node.widgets_values_named[key] === 'boolean') {
    return node.widgets_values_named[key] as boolean;
  }
  if (Array.isArray(node.widgets_values) && typeof node.widgets_values[0] === 'boolean') {
    return node.widgets_values[0];
  }
  return null;
}

function inferRoleHintFromLabel(
  label: string,
  nodeType: string
): 'positive' | 'negative' | 'unknown' {
  const lower = `${label} ${nodeType}`.toLowerCase();
  if (/负向|negative|neg\b|anti-|bad quality|worst quality/.test(lower)) {
    return 'negative';
  }
  if (/正向|positive|pos\b|场景词|人设/.test(lower)) {
    return 'positive';
  }
  return 'unknown';
}

function buildUiLinkLookup(links: unknown[] | undefined) {
  // link entry: [linkId, fromNodeId, fromSlot, toNodeId, toSlot, type]
  const byLinkId = new Map<
    number,
    { fromNodeId: number; fromSlot: number; toNodeId: number; toSlot: number; type: string }
  >();
  if (!Array.isArray(links)) return byLinkId;
  for (const item of links) {
    if (!Array.isArray(item) || item.length < 5) continue;
    const linkId = Number(item[0]);
    const fromNodeId = Number(item[1]);
    const fromSlot = Number(item[2]);
    const toNodeId = Number(item[3]);
    const toSlot = Number(item[4]);
    const type = typeof item[5] === 'string' ? item[5] : '';
    if (Number.isFinite(linkId) && Number.isFinite(fromNodeId)) {
      byLinkId.set(linkId, { fromNodeId, fromSlot, toNodeId, toSlot, type });
    }
  }
  return byLinkId;
}

function extractFromUiWorkflow(ui: UiWorkflowObject): {
  extractedPositive: string;
  extractedNegative: string;
  positiveNodeId: string | null;
  negativeNodeId: string | null;
  nodeCandidates: WorkflowPromptNodeCandidate[];
} {
  const nodeMap = new Map<number, UiWorkflowNode>();
  for (const n of ui.nodes) {
    if (n && typeof n.id === 'number') {
      nodeMap.set(n.id, n);
    }
  }
  const linkLookup = buildUiLinkLookup(ui.links);

  const resolveInputSourceNode = (
    node: UiWorkflowNode,
    inputName: string,
    seen = new Set<number>()
  ): UiWorkflowNode | null => {
    const inp = (node.inputs ?? []).find((i) => i.name === inputName);
    if (!inp || typeof inp.link !== 'number') return null;
    const link = linkLookup.get(inp.link);
    if (!link) return null;
    const src = nodeMap.get(link.fromNodeId);
    if (!src) return null;
    if (src.type === 'Reroute' && !seen.has(src.id)) {
      seen.add(src.id);
      return resolveInputSourceNode(src, src.inputs?.[0]?.name || '', seen) ?? src;
    }
    return src;
  };

  const evalBool = (node: UiWorkflowNode, visited = new Set<number>()): boolean => {
    if (visited.has(node.id)) return false;
    visited.add(node.id);
    if (node.type === 'PrimitiveBoolean') {
      return getUiWidgetBoolean(node, 'value') ?? false;
    }
    return getUiWidgetBoolean(node, 'switch') ?? false;
  };

  const evalUiString = (
    node: UiWorkflowNode,
    visited = new Set<number>()
  ): { text: string; leafNodeId?: string; isComposed?: boolean } => {
    if (visited.has(node.id)) return { text: '' };
    visited.add(node.id);

    if (node.type === 'Reroute') {
      const inpName = node.inputs?.[0]?.name ?? '';
      const upstream = resolveInputSourceNode(node, inpName);
      if (upstream) return evalUiString(upstream, visited);
    }

    if (node.type === 'ComfySwitchNode') {
      const switchSrc = resolveInputSourceNode(node, 'switch');
      const isTrue = switchSrc
        ? evalBool(switchSrc, visited)
        : getUiWidgetBoolean(node, 'switch') ?? false;
      const branchName = isTrue ? 'on_true' : 'on_false';
      const branchSrc = resolveInputSourceNode(node, branchName);
      if (branchSrc) {
        return evalUiString(branchSrc, visited);
      }
      return { text: '' };
    }

    if (node.type === 'StringConcatenate') {
      const srcA = resolveInputSourceNode(node, 'string_a');
      const srcB = resolveInputSourceNode(node, 'string_b');
      const valA = srcA
        ? evalUiString(srcA, visited).text
        : String(node.widgets_values_named?.string_a ?? node.widgets_values?.[0] ?? '');
      const valB = srcB
        ? evalUiString(srcB, visited).text
        : String(node.widgets_values_named?.string_b ?? node.widgets_values?.[1] ?? '');
      const delim = String(
        node.widgets_values_named?.delimiter ??
          (typeof node.widgets_values?.[2] === 'string' ? node.widgets_values[2] : '') ??
          ''
      );
      const parts = [valA.trim(), valB.trim()].filter(Boolean);
      const joined = parts.join(delim || ', ').replace(/,\s*,+/g, ', ').trim();
      return { text: joined, isComposed: true };
    }

    if (node.type === 'CLIPTextEncode' || /^CLIPTextEncode/i.test(node.type)) {
      const textSrc =
        resolveInputSourceNode(node, 'text') ??
        resolveInputSourceNode(node, 'text_g') ??
        resolveInputSourceNode(node, 'clip_l');
      if (textSrc) {
        const res = evalUiString(textSrc, visited);
        return {
          text: res.text,
          leafNodeId: res.isComposed ? String(node.id) : res.leafNodeId ?? String(textSrc.id),
          isComposed: res.isComposed,
        };
      }
      return {
        text: getUiWidgetString(node, ['text', 'text_g', 'text_l', 'clip_l']),
        leafNodeId: String(node.id),
      };
    }

    const direct = getUiWidgetString(node, ['value', 'text', 'string', 'prompt']);
    if (direct) {
      return { text: direct, leafNodeId: String(node.id) };
    }

    for (const inp of node.inputs ?? []) {
      if (inp.name && (inp.type === 'STRING' || /text|string|positive|negative/i.test(inp.name))) {
        const src = resolveInputSourceNode(node, inp.name);
        if (src) {
          const res = evalUiString(src, visited);
          if (res.text) return res;
        }
      }
    }
    return { text: '' };
  };

  const traceConditioningToText = (
    node: UiWorkflowNode,
    visited = new Set<number>()
  ): { encodeNodeId: string; textNodeId: string; text: string } | null => {
    if (visited.has(node.id)) return null;
    visited.add(node.id);
    if (node.mode === 2 || node.mode === 4) return null;

    if (/CLIPTextEncode/i.test(node.type)) {
      const evaluated = evalUiString(node);
      return {
        encodeNodeId: String(node.id),
        textNodeId: evaluated.leafNodeId || String(node.id),
        text: evaluated.text,
      };
    }

    for (const inpName of ['conditioning', 'conditioning_1', 'positive', 'negative']) {
      const src = resolveInputSourceNode(node, inpName);
      if (src) {
        const found = traceConditioningToText(src, visited);
        if (found) return found;
      }
    }

    // Fallback: any conditioning/string input
    for (const inp of node.inputs ?? []) {
      if (!inp.name) continue;
      const src = resolveInputSourceNode(node, inp.name);
      if (src) {
        const found = traceConditioningToText(src, visited);
        if (found) return found;
      }
    }
    return null;
  };

  let positiveNodeId: string | null = null;
  let negativeNodeId: string | null = null;
  let extractedPositive = '';
  let extractedNegative = '';

  const samplers = ui.nodes.filter(
    (n) => SAMPLER_NODE_TYPES.has(n.type) && n.mode !== 2 && n.mode !== 4
  );

  for (const sampler of samplers) {
    if (!positiveNodeId) {
      const posCond = resolveInputSourceNode(sampler, 'positive');
      if (posCond) {
        const traced = traceConditioningToText(posCond);
        if (traced) {
          positiveNodeId = traced.textNodeId;
          extractedPositive = traced.text;
        }
      }
    }
    if (!negativeNodeId) {
      const negCond = resolveInputSourceNode(sampler, 'negative');
      if (negCond) {
        const traced = traceConditioningToText(negCond);
        if (traced) {
          negativeNodeId = traced.textNodeId;
          extractedNegative = traced.text;
        }
      }
    }
  }

  const candidates: WorkflowPromptNodeCandidate[] = [];
  const seenCandidateIds = new Set<string>();

  for (const node of ui.nodes) {
    if (!node || node.type === 'Note' || node.mode === 2 || node.mode === 4) continue;
    if (!TEXT_ENCODE_NODE_RE.test(node.type) && node.type !== 'StringConcatenate') continue;

    const evaluated = evalUiString(node);
    const text = evaluated.text.trim();
    if (!text) continue;

    const idStr = String(node.id);
    if (seenCandidateIds.has(idStr)) continue;
    seenCandidateIds.add(idStr);

    const title = (node.title || node.type).trim();
    let roleHint: 'positive' | 'negative' | 'unknown' = inferRoleHintFromLabel(
      title,
      node.type
    );
    if (positiveNodeId === idStr) roleHint = 'positive';
    if (negativeNodeId === idStr) roleHint = 'negative';

    candidates.push({
      nodeId: idStr,
      nodeType: node.type,
      title,
      text,
      roleHint,
      source: evaluated.isComposed ? 'evaluated' : 'ui',
      linkedFromNodeId:
        evaluated.leafNodeId && evaluated.leafNodeId !== idStr
          ? evaluated.leafNodeId
          : undefined,
    });
  }

  if (!positiveNodeId) {
    const posCand =
      candidates.find((c) => c.roleHint === 'positive') ??
      candidates.find((c) => c.roleHint !== 'negative');
    if (posCand) {
      positiveNodeId = posCand.nodeId;
      extractedPositive = posCand.text;
    }
  }

  if (!negativeNodeId) {
    const negCand =
      candidates.find((c) => c.roleHint === 'negative' && c.nodeId !== positiveNodeId) ??
      candidates.find((c) => c.nodeId !== positiveNodeId);
    if (negCand) {
      negativeNodeId = negCand.nodeId;
      extractedNegative = negCand.text;
    }
  }

  return {
    extractedPositive,
    extractedNegative,
    positiveNodeId,
    negativeNodeId,
    nodeCandidates: candidates,
  };
}

function extractFromApiGraph(graph: ComfyApiGraph): {
  extractedPositive: string;
  extractedNegative: string;
  positiveNodeId: string | null;
  negativeNodeId: string | null;
  nodeCandidates: WorkflowPromptNodeCandidate[];
} {
  const resolveApiString = (
    val: unknown,
    visited = new Set<string>()
  ): { text: string; leafNodeId?: string; isComposed?: boolean } => {
    if (typeof val === 'string') {
      return { text: val };
    }
    if (Array.isArray(val) && typeof val[0] === 'string') {
      const refId = val[0];
      if (visited.has(refId)) return { text: '' };
      visited.add(refId);
      const refNode = graph[refId];
      if (!refNode) return { text: '' };

      if (refNode.class_type === 'ComfySwitchNode') {
        const sw = refNode.inputs?.switch;
        let isTrue = Boolean(sw);
        if (Array.isArray(sw) && typeof sw[0] === 'string') {
          isTrue = Boolean(graph[sw[0]]?.inputs?.value);
        }
        return resolveApiString(
          isTrue ? refNode.inputs?.on_true : refNode.inputs?.on_false,
          visited
        );
      }

      if (refNode.class_type === 'StringConcatenate') {
        const a = resolveApiString(refNode.inputs?.string_a, visited).text;
        const b = resolveApiString(refNode.inputs?.string_b, visited).text;
        const delim =
          typeof refNode.inputs?.delimiter === 'string' && refNode.inputs.delimiter
            ? refNode.inputs.delimiter
            : ', ';
        return {
          text: [a.trim(), b.trim()].filter(Boolean).join(delim).trim(),
          isComposed: true,
        };
      }

      const rawText =
        refNode.inputs?.value ??
        refNode.inputs?.text ??
        refNode.inputs?.string ??
        refNode.inputs?.prompt;
      if (typeof rawText === 'string') {
        return { text: rawText, leafNodeId: refId };
      }
      if (Array.isArray(rawText)) {
        return resolveApiString(rawText, visited);
      }
    }
    return { text: '' };
  };

  const traceCondNode = (
    nodeId: string,
    visited = new Set<string>()
  ): { nodeId: string; text: string } | null => {
    if (visited.has(nodeId)) return null;
    visited.add(nodeId);
    const node = graph[nodeId];
    if (!node) return null;

    if (/CLIPTextEncode/i.test(node.class_type)) {
      const candidateKeys = ['text', 'text_g', 'text_l', 'clip_l'];
      for (const k of candidateKeys) {
        if (node.inputs?.[k] !== undefined) {
          const resolved = resolveApiString(node.inputs[k]);
          return {
            nodeId: resolved.isComposed ? nodeId : resolved.leafNodeId ?? nodeId,
            text: resolved.text,
          };
        }
      }
    }

    for (const k of ['conditioning', 'conditioning_1', 'positive', 'negative']) {
      const link = node.inputs?.[k];
      if (Array.isArray(link) && typeof link[0] === 'string') {
        const found = traceCondNode(link[0], visited);
        if (found) return found;
      }
    }
    return null;
  };

  let positiveNodeId: string | null = null;
  let negativeNodeId: string | null = null;
  let extractedPositive = '';
  let extractedNegative = '';

  for (const node of Object.values(graph)) {
    if (!SAMPLER_NODE_TYPES.has(node.class_type)) continue;
    let posLink = node.inputs?.positive;
    let negLink = node.inputs?.negative;
    if ((!Array.isArray(posLink) || !Array.isArray(negLink)) && Array.isArray(node.inputs?.guider)) {
      const guiderNode = graph[String(node.inputs.guider[0])];
      if (guiderNode) {
        posLink = posLink ?? guiderNode.inputs?.positive ?? guiderNode.inputs?.conditioning;
        negLink = negLink ?? guiderNode.inputs?.negative;
      }
    }
    if (!positiveNodeId && Array.isArray(posLink)) {
      const refId = String(posLink[0]);
      const traced = traceCondNode(refId);
      if (traced) {
        positiveNodeId = traced.nodeId;
        extractedPositive = traced.text;
      }
    }
    if (!negativeNodeId && Array.isArray(negLink)) {
      const refId = String(negLink[0]);
      const traced = traceCondNode(refId);
      if (traced) {
        negativeNodeId = traced.nodeId;
        extractedNegative = traced.text;
      }
    }
  }

  const candidates: WorkflowPromptNodeCandidate[] = [];
  for (const [nodeId, node] of Object.entries(graph)) {
    if (!TEXT_ENCODE_NODE_RE.test(node.class_type) && node.class_type !== 'StringConcatenate') {
      continue;
    }
    const textInput =
      node.inputs?.text ??
      node.inputs?.text_g ??
      node.inputs?.clip_l ??
      node.inputs?.value ??
      node.inputs?.string;
    const resolved =
      node.class_type === 'StringConcatenate'
        ? resolveApiString([nodeId, 0])
        : resolveApiString(textInput);
    const text = resolved.text.trim();
    if (!text) continue;

    let roleHint: 'positive' | 'negative' | 'unknown' = inferRoleHintFromLabel(
      '',
      node.class_type
    );
    if (positiveNodeId === nodeId) roleHint = 'positive';
    if (negativeNodeId === nodeId) roleHint = 'negative';
    if (roleHint === 'unknown' && /worst quality|low quality|nsfw|bad anatomy/i.test(text)) {
      roleHint = 'negative';
    }

    candidates.push({
      nodeId,
      nodeType: node.class_type,
      title: `${node.class_type} #${nodeId}`,
      text,
      roleHint,
      source: resolved.isComposed ? 'evaluated' : 'api',
      linkedFromNodeId:
        resolved.leafNodeId && resolved.leafNodeId !== nodeId
          ? resolved.leafNodeId
          : undefined,
    });
  }

  if (!positiveNodeId) {
    const posCand =
      candidates.find((c) => c.roleHint === 'positive') ??
      candidates.find((c) => c.roleHint !== 'negative');
    if (posCand) {
      positiveNodeId = posCand.nodeId;
      extractedPositive = posCand.text;
    }
  }
  if (!negativeNodeId) {
    const negCand =
      candidates.find((c) => c.roleHint === 'negative' && c.nodeId !== positiveNodeId) ??
      candidates.find((c) => c.nodeId !== positiveNodeId);
    if (negCand) {
      negativeNodeId = negCand.nodeId;
      extractedNegative = negCand.text;
    }
  }

  return {
    extractedPositive,
    extractedNegative,
    positiveNodeId,
    negativeNodeId,
    nodeCandidates: candidates,
  };
}

export interface ParsedWorkflowSource {
  workflowFormat: WorkflowJsonFormat;
  rawWorkflowJson: string;
  apiPromptJson?: string;
  extractedPositive: string;
  extractedNegative: string;
  positiveNodeId: string | null;
  negativeNodeId: string | null;
  nodeCandidates: WorkflowPromptNodeCandidate[];
}

export function parseComfyWorkflowSource(params: {
  rawJsonText?: string;
  apiPromptJsonText?: string;
  chibipromptMeta?: { positive?: string; negative?: string; character?: string };
  a1111Meta?: A1111PngParametersMeta;
}): ParsedWorkflowSource {
  const { rawJsonText, apiPromptJsonText, chibipromptMeta, a1111Meta } = params;

  let parsedRaw: unknown = null;
  if (rawJsonText && rawJsonText.trim()) {
    parsedRaw = JSON.parse(rawJsonText);
  }

  let parsedApi: ComfyApiGraph | null = null;
  if (apiPromptJsonText && apiPromptJsonText.trim()) {
    const maybeApi = JSON.parse(apiPromptJsonText);
    if (isApiPromptDict(maybeApi)) {
      parsedApi = maybeApi;
    }
  }

  if (!parsedApi && isApiPromptDict(parsedRaw)) {
    parsedApi = parsedRaw;
  }

  if (isUiWorkflowObject(parsedRaw)) {
    const uiRes = extractFromUiWorkflow(parsedRaw);
    const apiRes = parsedApi ? extractFromApiGraph(parsedApi) : null;

    // Prefer UI candidate titles & rich extraction when UI exists; keep apiPromptJson for direct ComfyUI execution
    const mergedCandidates =
      uiRes.nodeCandidates.length > 0 ? uiRes.nodeCandidates : apiRes?.nodeCandidates ?? [];
    const extractedPositive =
      uiRes.extractedPositive ||
      apiRes?.extractedPositive ||
      chibipromptMeta?.positive ||
      '';
    const extractedNegative =
      uiRes.extractedNegative ||
      apiRes?.extractedNegative ||
      chibipromptMeta?.negative ||
      '';

    return {
      workflowFormat: apiPromptJsonText && !rawJsonText ? 'png-embedded' : 'ui',
      rawWorkflowJson: JSON.stringify(parsedRaw, null, 2),
      apiPromptJson: parsedApi ? JSON.stringify(parsedApi) : undefined,
      extractedPositive,
      extractedNegative,
      positiveNodeId: uiRes.positiveNodeId ?? apiRes?.positiveNodeId ?? null,
      negativeNodeId: uiRes.negativeNodeId ?? apiRes?.negativeNodeId ?? null,
      nodeCandidates: mergedCandidates,
    };
  }

  if (parsedApi) {
    const apiRes = extractFromApiGraph(parsedApi);
    return {
      workflowFormat: apiPromptJsonText && !rawJsonText ? 'png-embedded' : 'api',
      rawWorkflowJson: JSON.stringify(parsedApi, null, 2),
      apiPromptJson: JSON.stringify(parsedApi),
      extractedPositive: apiRes.extractedPositive || chibipromptMeta?.positive || '',
      extractedNegative: apiRes.extractedNegative || chibipromptMeta?.negative || '',
      positiveNodeId: apiRes.positiveNodeId,
      negativeNodeId: apiRes.negativeNodeId,
      nodeCandidates: apiRes.nodeCandidates,
    };
  }

  if (chibipromptMeta && (chibipromptMeta.positive || chibipromptMeta.negative)) {
    return {
      workflowFormat: 'png-embedded',
      rawWorkflowJson: JSON.stringify({ chibiprompt: chibipromptMeta }, null, 2),
      extractedPositive: chibipromptMeta.positive || '',
      extractedNegative: chibipromptMeta.negative || '',
      positiveNodeId: null,
      negativeNodeId: null,
      nodeCandidates: [],
    };
  }

  if (a1111Meta && (a1111Meta.positive || a1111Meta.negative)) {
    return {
      workflowFormat: 'png-embedded',
      rawWorkflowJson: JSON.stringify({ parameters: a1111Meta.rawParameters }, null, 2),
      extractedPositive: a1111Meta.positive || '',
      extractedNegative: a1111Meta.negative || '',
      positiveNodeId: null,
      negativeNodeId: null,
      nodeCandidates: [],
    };
  }

  throw new Error('未在 JSON 或 PNG 元数据中识别到有效的 ComfyUI 工作流节点');
}

export function convertUiWorkflowToApiPrompt(uiRaw: unknown): ComfyApiGraph | null {
  if (!isUiWorkflowObject(uiRaw)) return null;
  const nodeMap = new Map<number, UiWorkflowNode>();
  for (const n of uiRaw.nodes) {
    if (n && typeof n.id === 'number') nodeMap.set(n.id, n);
  }
  const linkLookup = buildUiLinkLookup(uiRaw.links);

  const resolveNonRerouteLink = (
    linkId: number,
    visited = new Set<number>()
  ): [string, number] | null => {
    const link = linkLookup.get(linkId);
    if (!link) return null;
    const src = nodeMap.get(link.fromNodeId);
    if (!src || src.mode === 2 || src.mode === 4) return null;
    if (src.type === 'Reroute' && !visited.has(src.id)) {
      visited.add(src.id);
      const upLink = src.inputs?.[0]?.link;
      if (typeof upLink === 'number') {
        return resolveNonRerouteLink(upLink, visited);
      }
      return null;
    }
    return [String(link.fromNodeId), link.fromSlot];
  };

  const apiGraph: ComfyApiGraph = {};

  for (const node of uiRaw.nodes) {
    if (!node || typeof node.id !== 'number') continue;
    if (node.mode === 2 || node.mode === 4) continue;
    if (node.type === 'Note' || node.type === 'Reroute' || node.type === 'MarkdownNote') {
      continue;
    }

    const inputs: Record<string, unknown> = {};
    const linkedWidgetNames = new Set<string>();

    for (const inp of node.inputs ?? []) {
      if (!inp.name) continue;
      if (typeof inp.link === 'number') {
        const resolved = resolveNonRerouteLink(inp.link);
        if (resolved) {
          inputs[inp.name] = resolved;
          linkedWidgetNames.add(inp.name);
        }
      }
    }

    if (node.widgets_values_named && typeof node.widgets_values_named === 'object') {
      for (const [k, v] of Object.entries(node.widgets_values_named)) {
        if (k === 'control_after_generate') continue;
        if (linkedWidgetNames.has(k)) continue;
        inputs[k] = v;
      }
    } else if (Array.isArray(node.widgets_values)) {
      const schema = UI_WIDGET_KEY_MAP[node.type];
      if (schema) {
        schema.forEach((keyName, idx) => {
          if (!keyName || linkedWidgetNames.has(keyName)) return;
          if (idx < node.widgets_values!.length) {
            inputs[keyName] = node.widgets_values![idx];
          }
        });
      } else {
        // Generic fallback using inputs with widget descriptors
        const widgetInputs = (node.inputs ?? []).filter((i) => i.widget?.name);
        widgetInputs.forEach((wi, idx) => {
          const wName = wi.widget?.name;
          if (!wName || linkedWidgetNames.has(wName)) return;
          if (idx < node.widgets_values!.length) {
            inputs[wName] = node.widgets_values![idx];
          }
        });
      }
    }

    apiGraph[String(node.id)] = {
      class_type: node.type,
      inputs,
    };
  }

  const hasSamplerOrOutput = Object.values(apiGraph).some(
    (n) =>
      SAMPLER_NODE_TYPES.has(n.class_type) ||
      n.class_type === 'SaveImage' ||
      n.class_type === 'PreviewImage'
  );
  return hasSamplerOrOutput ? apiGraph : null;
}

export function parsePromptToTagItems(promptText: string): WorkflowPromptTagItem[] {
  const tokens = splitPromptTags(promptText);
  return tokens.map((token, idx) => {
    const trimmed = token.trim();
    const weightedMatch = trimmed.match(/^\((.+):([0-9]+(?:\.[0-9]+)?)\)$/);
    let innerText = trimmed;
    let weight = 1.0;

    if (weightedMatch) {
      // Check balanced inner parentheses so "(mari (blue archive):1.8)" parses cleanly
      const candidateInner = weightedMatch[1].trim();
      let depth = 0;
      let balanced = true;
      for (let i = 0; i < candidateInner.length; i++) {
        if (candidateInner[i] === '(') depth += 1;
        else if (candidateInner[i] === ')') {
          depth -= 1;
          if (depth < 0) {
            balanced = false;
            break;
          }
        }
      }
      if (balanced && depth === 0) {
        innerText = candidateInner;
        weight = clampWeight(parseFloat(weightedMatch[2]));
      }
    }

    return {
      id: `wtag-${idx}-${Math.random().toString(36).slice(2, 6)}`,
      text: innerText,
      weight,
      enabled: true,
    };
  });
}

export function serializeTagItemsToPrompt(items: WorkflowPromptTagItem[]): string {
  return items
    .filter((item) => item.enabled && item.text.trim().length > 0)
    .map((item) => formatWeightedText(item.text, item.weight))
    .filter(Boolean)
    .join(', ');
}

function patchNodePromptInApiGraph(
  graph: ComfyApiGraph,
  targetNodeId: string | null,
  newPrompt: string,
  role: 'positive' | 'negative'
): void {
  const patchTextOnNode = (node: ComfyApiNode): boolean => {
    if (/CLIPTextEncode/i.test(node.class_type)) {
      if ('text_g' in node.inputs && 'text_l' in node.inputs) {
        node.inputs.text_g = newPrompt;
        node.inputs.text_l = newPrompt;
        return true;
      }
      if ('clip_l' in node.inputs) {
        node.inputs.clip_l = newPrompt;
        return true;
      }
      node.inputs.text = newPrompt;
      return true;
    }
    if ('value' in node.inputs && typeof node.inputs.value === 'string') {
      node.inputs.value = newPrompt;
      return true;
    }
    if ('text' in node.inputs) {
      node.inputs.text = newPrompt;
      return true;
    }
    if ('string' in node.inputs) {
      node.inputs.string = newPrompt;
      return true;
    }
    return false;
  };

  if (targetNodeId && graph[targetNodeId]) {
    if (patchTextOnNode(graph[targetNodeId])) {
      return;
    }
  }

  // Fallback: trace from sampler
  for (const node of Object.values(graph)) {
    if (!SAMPLER_NODE_TYPES.has(node.class_type)) continue;
    const link = node.inputs?.[role];
    if (Array.isArray(link) && typeof link[0] === 'string' && graph[link[0]]) {
      if (patchTextOnNode(graph[link[0]])) return;
    }
  }
}

export type CardComfyRunMode = 'card-workflow' | 'studio-profile-fallback';

export interface RunWorkflowCardResult {
  promptId: string;
  mode: CardComfyRunMode;
  summary: string;
  usedSeed?: number;
}

export async function sendWorkflowCardToComfyUI(params: {
  comfyUrl: string;
  card: WorkflowCollectionCard;
  fallbackProfile: ComfyProfile;
  characterName: string;
  preferStudioProfile?: boolean;
  seedModeOverride?: 'workflow' | 'fixed' | 'random';
  fixedSeedOverride?: number;
}): Promise<RunWorkflowCardResult> {
  const baseUrl = params.comfyUrl.trim().replace(/\/+$/, '');
  if (!baseUrl) {
    throw new Error('请先在设置中填写 ComfyUI 服务地址（默认 http://127.0.0.1:8188）');
  }

  const { card } = params;
  const posPrompt = (card.applyFineTuneOnSend
    ? card.fineTunedPositive
    : card.extractedPositive
  ).trim();
  const negPrompt = (card.applyFineTuneOnSend
    ? card.fineTunedNegative
    : card.extractedNegative
  ).trim();

  let executableGraph: ComfyApiGraph | null = null;
  let sourceLabel = '卡片 API 工作流';

  if (!params.preferStudioProfile) {
    if (card.apiPromptJson) {
      try {
        const parsed = JSON.parse(card.apiPromptJson);
        if (isApiPromptDict(parsed)) {
          executableGraph = JSON.parse(JSON.stringify(parsed)) as ComfyApiGraph;
          sourceLabel = '卡片 API 工作流直发';
        }
      } catch {
        executableGraph = null;
      }
    }

    if (!executableGraph && card.rawWorkflowJson) {
      try {
        const parsedRaw = JSON.parse(card.rawWorkflowJson);
        if (isApiPromptDict(parsedRaw)) {
          executableGraph = JSON.parse(JSON.stringify(parsedRaw)) as ComfyApiGraph;
          sourceLabel = '卡片 API 工作流直发';
        } else if (isUiWorkflowObject(parsedRaw)) {
          executableGraph = convertUiWorkflowToApiPrompt(parsedRaw);
          if (executableGraph) {
            sourceLabel = '卡片 UI 工作流自动转 API 发送';
          }
        }
      } catch {
        executableGraph = null;
      }
    }
  }

  if (executableGraph) {
    if (card.applyFineTuneOnSend) {
      if (posPrompt) {
        patchNodePromptInApiGraph(executableGraph, card.positiveNodeId, posPrompt, 'positive');
      }
      if (negPrompt) {
        patchNodePromptInApiGraph(executableGraph, card.negativeNodeId, negPrompt, 'negative');
      }
    }

    const effectiveSeedMode = params.seedModeOverride ?? card.seedMode ?? 'workflow';
    const overrideFixedSeed =
      typeof params.fixedSeedOverride === 'number' &&
      Number.isFinite(params.fixedSeedOverride) &&
      params.fixedSeedOverride >= 0
        ? Math.floor(params.fixedSeedOverride)
        : typeof card.fixedSeed === 'number' &&
          Number.isFinite(card.fixedSeed) &&
          card.fixedSeed >= 0
        ? Math.floor(card.fixedSeed)
        : undefined;

    const randomSeed = Math.floor(Math.random() * 2147483647);
    let usedSeed: number | undefined;

    for (const node of Object.values(executableGraph)) {
      if (
        SAMPLER_NODE_TYPES.has(node.class_type) ||
        node.class_type === 'RandomNoise'
      ) {
        if ('seed' in node.inputs && typeof node.inputs.seed === 'number') {
          if (effectiveSeedMode === 'random') {
            node.inputs.seed = randomSeed;
          } else if (effectiveSeedMode === 'fixed' && overrideFixedSeed !== undefined) {
            node.inputs.seed = overrideFixedSeed;
          }
          if (usedSeed === undefined) usedSeed = node.inputs.seed as number;
        }
        if ('noise_seed' in node.inputs && typeof node.inputs.noise_seed === 'number') {
          if (effectiveSeedMode === 'random') {
            node.inputs.noise_seed = randomSeed;
          } else if (effectiveSeedMode === 'fixed' && overrideFixedSeed !== undefined) {
            node.inputs.noise_seed = overrideFixedSeed;
          }
          if (usedSeed === undefined) usedSeed = node.inputs.noise_seed as number;
        }
      }
      if (node.class_type === 'SaveImage' && !node.inputs.filename_prefix) {
        node.inputs.filename_prefix = sanitizeFilenamePrefix(card.title);
      }
    }

    const clientId = `chibiprompt-card-${Math.random().toString(36).slice(2, 10)}`;
    const response = await fetch(`${baseUrl}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        prompt: executableGraph,
        extra_data: {
          extra_pnginfo: {
            chibiprompt_card: {
              id: card.id,
              title: card.title,
              tags: card.tags,
              positive: posPrompt,
              negative: negPrompt,
              seed: usedSeed,
              createdAt: new Date().toISOString(),
            },
          },
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      const friendlyMsg = await parseComfyErrorResponse(
        response.status,
        errText,
        executableGraph,
        baseUrl
      );
      throw new Error(friendlyMsg);
    }

    const data = (await response.json()) as { prompt_id?: string };
    return {
      promptId: data.prompt_id ?? 'submitted',
      mode: 'card-workflow',
      summary: sourceLabel,
      usedSeed,
    };
  }

  // Fallback: send card's fine-tuned prompts using current active ComfyProfile
  if (!posPrompt) {
    throw new Error('该卡片暂无可发送的正向提示词，且无法直接解析为可执行节点图');
  }

  const effectiveFallbackMode = params.seedModeOverride ?? card.seedMode ?? 'workflow';
  const fallbackProfile: ComfyProfile =
    effectiveFallbackMode === 'random'
      ? {
          ...params.fallbackProfile,
          sampling: { ...params.fallbackProfile.sampling, seedMode: 'random' },
        }
      : effectiveFallbackMode === 'fixed' &&
        (params.fixedSeedOverride !== undefined || card.fixedSeed !== undefined)
      ? {
          ...params.fallbackProfile,
          sampling: {
            ...params.fallbackProfile.sampling,
            seedMode: 'fixed',
            seed: Math.floor(
              params.fixedSeedOverride ?? card.fixedSeed ?? params.fallbackProfile.sampling.seed ?? 264726437384195
            ),
          },
        }
      : {
          ...params.fallbackProfile,
          sampling: { ...params.fallbackProfile.sampling, seedMode: 'fixed' },
        };

  const res = await postProfileToComfyUI({
    comfyUrl: baseUrl,
    profile: fallbackProfile,
    characterName: `${card.title || params.characterName}`,
    positivePrompt: posPrompt,
    negativePrompt: negPrompt,
    enableFourthLora: false,
  });

  return {
    promptId: res.promptId,
    mode: 'studio-profile-fallback',
    summary: `以当前方案「${params.fallbackProfile.name}」发送卡片提示词`,
    usedSeed: res.usedSeed,
  };
}

export async function resolveCardImageBlob(
  card: WorkflowCollectionCard
): Promise<{ blob: Blob; isLosslessOriginal: boolean; mimeType: string } | null> {
  if (card.originalImageDataUrl) {
    try {
      const blob = decodeDataUrlToBlob(card.originalImageDataUrl);
      return {
        blob,
        isLosslessOriginal: true,
        mimeType: card.originalImageMime || blob.type || 'image/png',
      };
    } catch {
      // fall through
    }
  }

  if (card.hasOriginalImageBlob) {
    const stored = await loadCardImageBlob(card.id);
    if (stored) {
      return {
        blob: stored.blob,
        isLosslessOriginal: true,
        mimeType: stored.mimeType || stored.blob.type || 'image/png',
      };
    }
  }

  if (card.thumbnailDataUrl) {
    try {
      const blob = decodeDataUrlToBlob(card.thumbnailDataUrl);
      return {
        blob,
        isLosslessOriginal: false,
        mimeType: blob.type || 'image/webp',
      };
    } catch {
      return null;
    }
  }

  return null;
}

export async function resolveCardImageDataUrl(
  card: WorkflowCollectionCard
): Promise<string | null> {
  if (card.originalImageDataUrl) return card.originalImageDataUrl;
  if (card.hasOriginalImageBlob) {
    const stored = await loadCardImageBlob(card.id);
    if (stored) {
      return encodeBlobToDataUrl(stored.blob);
    }
  }
  return card.thumbnailDataUrl || null;
}

export function buildCardExportPayload(
  cards: WorkflowCollectionCard[],
  options?: { includePrivate?: boolean; onlyPrivate?: boolean }
): string {
  const filteredCards = options?.onlyPrivate
    ? cards.filter((c) => Boolean(c.isPrivate))
    : options?.includePrivate
    ? cards
    : cards.filter((c) => !c.isPrivate);

  return JSON.stringify(
    {
      schema: 'chibiprompt-workflow-collection-v1',
      exportedAt: new Date().toISOString(),
      cards: filteredCards,
    },
    null,
    2
  );
}

export async function buildCardExportPayloadAsync(
  cards: WorkflowCollectionCard[],
  options?: { includePrivate?: boolean; onlyPrivate?: boolean; maxEmbeddedImageBytes?: number }
): Promise<{ payload: string; omittedLargeImagesCount: number; exportedCount: number }> {
  const filteredCards = options?.onlyPrivate
    ? cards.filter((c) => Boolean(c.isPrivate))
    : options?.includePrivate
    ? cards
    : cards.filter((c) => !c.isPrivate);

  const maxBytes = options?.maxEmbeddedImageBytes ?? 140 * 1024 * 1024;
  let accumulatedBytes = 0;
  let omittedLargeImagesCount = 0;

  const hydratedCards: WorkflowCollectionCard[] = [];
  for (let i = 0; i < filteredCards.length; i++) {
    const card = filteredCards[i];
    if (card.originalImageDataUrl) {
      accumulatedBytes += card.originalImageDataUrl.length;
      hydratedCards.push(card);
    } else if (card.hasOriginalImageBlob) {
      const stored = await loadCardImageBlob(card.id);
      if (stored && accumulatedBytes + stored.byteSize * 1.35 <= maxBytes) {
        const dataUrl = await encodeBlobToDataUrl(stored.blob);
        accumulatedBytes += dataUrl.length;
        hydratedCards.push({
          ...card,
          originalImageDataUrl: dataUrl,
          thumbnailDataUrl: '',
        });
      } else {
        omittedLargeImagesCount += 1;
        hydratedCards.push(card);
      }
    } else {
      hydratedCards.push(card);
    }
    if (i > 0 && i % 15 === 0) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  return {
    payload: JSON.stringify(
      {
        schema: 'chibiprompt-workflow-collection-v1',
        exportedAt: new Date().toISOString(),
        cards: hydratedCards,
      },
      null,
      2
    ),
    omittedLargeImagesCount,
    exportedCount: hydratedCards.length,
  };
}

function inferAutoTagsFromPngMetadata(params: {
  parsed: ParsedWorkflowSource;
  pngMeta: ExtractedPngComfyMetadata;
  knownCharacterHints?: string[];
}): string[] {
  const tags: string[] = ['PNG导入'];
  const lowerCombined = `${params.parsed.extractedPositive}\n${params.parsed.rawWorkflowJson}\n${params.parsed.apiPromptJson ?? ''}`.toLowerCase();

  const charFromMeta = params.pngMeta.chibipromptMeta?.character?.trim();
  if (charFromMeta) {
    tags.push(charFromMeta);
  } else if (params.knownCharacterHints && params.knownCharacterHints.length > 0) {
    for (const hint of params.knownCharacterHints) {
      const clean = hint.trim();
      if (clean && lowerCombined.includes(clean.toLowerCase())) {
        tags.push(clean);
        break;
      }
    }
  }

  // 常见角色英文关键词兜底识别
  if (tags.length === 1) {
    if (/\bibuki\b/.test(lowerCombined)) tags.push('伊吹');
    else if (/\bmari\b/.test(lowerCombined)) tags.push('玛丽');
    else if (/\bsakura\b/.test(lowerCombined)) tags.push('樱');
    else if (/\bblue archive\b/.test(lowerCombined)) tags.push('BlueArchive');
  }

  if (/anima|qwen_3_06b|qwen_image_vae/i.test(lowerCombined)) {
    tags.push('Anima');
  } else if (/illustrious/i.test(lowerCombined)) {
    tags.push('Illustrious');
  } else if (/sdxl|text_g/i.test(lowerCombined)) {
    tags.push('SDXL');
  } else if (/flux/i.test(lowerCombined)) {
    tags.push('Flux');
  }

  return Array.from(new Set(tags)).slice(0, 4);
}

export type PngCardImportResult =
  | {
      ok: true;
      card: WorkflowCollectionCard;
      imageBlob: Blob;
      mimeType: string;
    }
  | { ok: false; fileName: string; reason: string };

export async function buildWorkflowCardFromPngFile(
  file: File,
  options?: {
    isPrivate?: boolean;
    knownCharacterHints?: string[];
    indexSeed?: number;
  }
): Promise<PngCardImportResult> {
  const isPngFile =
    file.type === 'image/png' || file.name.toLowerCase().endsWith('.png');
  if (!isPngFile) {
    return {
      ok: false,
      fileName: file.name,
      reason: '仅支持内嵌 ComfyUI 元数据的 PNG 图片',
    };
  }

  let pngMeta: ExtractedPngComfyMetadata;
  try {
    pngMeta = await extractComfyMetadataFromPngFile(file);
  } catch (err) {
    return {
      ok: false,
      fileName: file.name,
      reason: err instanceof Error ? err.message : '读取 PNG 文件失败',
    };
  }

  if (!pngMeta.isPng) {
    return {
      ok: false,
      fileName: file.name,
      reason: '文件不是有效的 PNG 图片',
    };
  }

  if (
    !pngMeta.workflowJson &&
    !pngMeta.apiPromptJson &&
    !pngMeta.chibipromptMeta &&
    !pngMeta.a1111Meta
  ) {
    return {
      ok: false,
      fileName: file.name,
      reason: '未检测到内嵌 ComfyUI prompt / workflow 或参数元数据',
    };
  }

  let parsed: ParsedWorkflowSource;
  try {
    parsed = parseComfyWorkflowSource({
      rawJsonText: pngMeta.workflowJson,
      apiPromptJsonText: pngMeta.apiPromptJson,
      chibipromptMeta: pngMeta.chibipromptMeta,
      a1111Meta: pngMeta.a1111Meta,
    });
  } catch (err) {
    return {
      ok: false,
      fileName: file.name,
      reason: err instanceof Error ? err.message : '解析 PNG 内嵌工作流失败',
    };
  }

  const dims = await readImageDimensions(file);
  const imageContentHash = await computeBlobContentHash(file);
  const idbAvailable = isIndexedDbSupported();
  let inlineOriginalDataUrl: string | undefined;
  if (!idbAvailable) {
    try {
      inlineOriginalDataUrl = await encodeBlobToDataUrl(file);
    } catch {
      inlineOriginalDataUrl = undefined;
    }
  }

  const now = Date.now();
  const fileStem = file.name.replace(/\.[^/.]+$/, '').trim();
  const charLabel = pngMeta.chibipromptMeta?.character?.trim();
  const baseTitle =
    charLabel && fileStem && !fileStem.toLowerCase().includes(charLabel.toLowerCase())
      ? `${charLabel} · ${fileStem}`
      : fileStem || charLabel || 'PNG 工作流卡片';

  const autoTags = inferAutoTagsFromPngMetadata({
    parsed,
    pngMeta,
    knownCharacterHints: options?.knownCharacterHints,
  });

  const idxToken =
    typeof options?.indexSeed === 'number' ? `${options.indexSeed}-` : '';

  const draftCard: WorkflowCollectionCard = {
    id: `wf-card-${now}-${idxToken}${Math.random().toString(36).slice(2, 7)}`,
    title: baseTitle,
    tags: autoTags,
    thumbnailDataUrl: inlineOriginalDataUrl ?? '',
    originalImageDataUrl: inlineOriginalDataUrl,
    originalImageMime: file.type || 'image/png',
    originalImageWidth: dims.width,
    originalImageHeight: dims.height,
    hasOriginalImageBlob: true,
    imageByteSize: file.size,
    imageContentHash,
    autoImportedSource: 'png',
    imageName: file.name,
    workflowFileName: `${file.name} (内嵌元数据)`,
    workflowFormat: parsed.workflowFormat,
    rawWorkflowJson: parsed.rawWorkflowJson,
    apiPromptJson: parsed.apiPromptJson,
    extractedPositive: parsed.extractedPositive,
    extractedNegative: parsed.extractedNegative,
    fineTunedPositive: parsed.extractedPositive,
    fineTunedNegative: parsed.extractedNegative,
    positiveNodeId: parsed.positiveNodeId,
    negativeNodeId: parsed.negativeNodeId,
    nodeCandidates: parsed.nodeCandidates,
    applyFineTuneOnSend: true,
    isPrivate: Boolean(options?.isPrivate),
    seedMode: 'workflow',
    fixedSeed: pngMeta.a1111Meta?.seed,
    createdAt: now,
    updatedAt: now,
  };
  draftCard.contentFingerprint = computeCardContentFingerprint(draftCard);

  return {
    ok: true,
    imageBlob: file,
    mimeType: file.type || 'image/png',
    card: draftCard,
  };
}

type FsPermissionState = 'granted' | 'denied' | 'prompt';

interface DirectoryHandleWithPermissions extends FileSystemDirectoryHandle {
  queryPermission?: (desc?: { mode?: 'read' | 'readwrite' }) => Promise<FsPermissionState>;
  requestPermission?: (desc?: { mode?: 'read' | 'readwrite' }) => Promise<FsPermissionState>;
}

type WindowWithDirectoryPicker = Window & {
  showDirectoryPicker?: (options?: {
    id?: string;
    mode?: 'read' | 'readwrite';
    startIn?: 'desktop' | 'documents' | 'downloads' | 'pictures';
  }) => Promise<FileSystemDirectoryHandle>;
};

export function isFileSystemAccessSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as WindowWithDirectoryPicker).showDirectoryPicker === 'function'
  );
}

export function isInRestrictedIframe(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

export type PickDirectoryResult =
  | { ok: true; handle: FileSystemDirectoryHandle }
  | {
      ok: false;
      cancelled?: boolean;
      unsupported?: boolean;
      iframeBlocked?: boolean;
      message: string;
    };

export async function pickLocalWorkflowDirectory(): Promise<PickDirectoryResult> {
  if (!isFileSystemAccessSupported()) {
    return {
      ok: false,
      unsupported: true,
      message:
        '当前浏览器不支持 File System Access API（推荐使用桌面版 Chrome / Edge 并直接在独立标签页打开），已自动降级为浏览器缓存 + 文件下载导出模式。',
    };
  }

  try {
    const picker = (window as WindowWithDirectoryPicker).showDirectoryPicker!;
    const handle = await picker({
      id: 'chibiprompt-workflows',
      mode: 'readwrite',
    });
    return { ok: true, handle };
  } catch (err) {
    const name = err instanceof DOMException ? err.name : (err as { name?: string })?.name;
    const rawMsg = err instanceof Error ? err.message : '';
    if (name === 'AbortError') {
      return {
        ok: false,
        cancelled: true,
        message: '已取消选择本地文件夹',
      };
    }
    if (name === 'SecurityError' || /cross origin sub frame|sub frame|iframe|user gesture/i.test(rawMsg)) {
      return {
        ok: false,
        iframeBlocked: true,
        message:
          '当前页面运行在受限的 iframe 沙箱或跨域嵌套环境中，浏览器禁止直接访问本地磁盘目录。已自动降级为浏览器缓存 +「导出集 / 单卡下载」模式（在本地 npm run dev 新窗口打开即可直写本地文件夹）。',
      };
    }
    return {
      ok: false,
      message: rawMsg
        ? `无法打开本地文件夹选择框：${rawMsg}。已自动降级为浏览器缓存 + 文件下载导出模式。`
        : '无法访问本地文件夹，已自动降级为浏览器缓存 + 文件下载导出模式。',
    };
  }
}

export async function ensureDirectoryWritePermission(
  handle: FileSystemDirectoryHandle,
  requestIfNeeded = true
): Promise<FsPermissionState> {
  const dir = handle as DirectoryHandleWithPermissions;
  try {
    if (typeof dir.queryPermission === 'function') {
      const state = await dir.queryPermission({ mode: 'readwrite' });
      if (state === 'granted') return 'granted';
      if (state === 'prompt' && requestIfNeeded && typeof dir.requestPermission === 'function') {
        return await dir.requestPermission({ mode: 'readwrite' });
      }
      return state;
    }
    return 'granted';
  } catch {
    return 'denied';
  }
}

export function dataUrlToBlob(dataUrl: string): Blob {
  return decodeDataUrlToBlob(dataUrl);
}

function inferImageExtension(card: WorkflowCollectionCard, mimeType?: string): string {
  const nameExt = card.imageName.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase();
  if (nameExt) return nameExt;
  const mime = (mimeType || card.originalImageMime || '').toLowerCase();
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('webp')) return 'webp';
  return 'png';
}

export function buildCardFolderPathSegments(card: WorkflowCollectionCard): string[] {
  const shortId = card.id.replace(/[^a-zA-Z0-9]/g, '').slice(-6) || 'card';
  const safeTitle = sanitizeFilenamePrefix(card.title).slice(0, 48);
  const cardDir = `${safeTitle}_${shortId}`;
  const firstTag = card.tags[0]?.trim();
  const tagSegments = firstTag ? [sanitizeFilenamePrefix(firstTag).slice(0, 32)] : [];
  if (card.isPrivate) {
    return ['_私密区', ...tagSegments, cardDir];
  }
  return [...tagSegments, cardDir];
}

async function writeFileInDirectory(
  dirHandle: FileSystemDirectoryHandle,
  fileName: string,
  content: Blob | string
): Promise<void> {
  const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(content);
  } finally {
    await writable.close();
  }
}

export interface FolderWriteCardResult {
  ok: boolean;
  relativePath: string;
  error?: string;
}

export const FOLDER_SYNC_INDEX_FILENAME = '.chibiprompt-sync-index.json';

export { computeBlobContentHash };

export function computeFastDigest64(input: string): string {
  return computeFastStringDigest64(input);
}

export function computeWorkflowSignature(
  card: Pick<
    WorkflowCollectionCard,
    'rawWorkflowJson' | 'apiPromptJson' | 'extractedPositive' | 'extractedNegative'
  >
): string {
  return computeFastStringDigest64(
    JSON.stringify({
      raw: card.rawWorkflowJson?.trim() || '',
      api: card.apiPromptJson?.trim() || '',
      pos: card.extractedPositive.trim(),
      neg: card.extractedNegative.trim(),
    })
  );
}

export function computeCardContentFingerprint(card: WorkflowCollectionCard): string {
  return computeCardSyncContentHash(card);
}

export async function ensureCardContentHashes(
  card: WorkflowCollectionCard,
  overrideBlob?: Blob | null
): Promise<{
  card: WorkflowCollectionCard;
  resolvedBlob: Blob | null;
  resolvedMime?: string;
}> {
  let imageHash = card.imageContentHash;
  let imageByteSize = card.imageByteSize;
  let resolvedBlob: Blob | null = overrideBlob ?? null;
  let resolvedMime: string | undefined = card.originalImageMime;

  if (!imageHash) {
    if (!resolvedBlob && (card.hasOriginalImageBlob || card.originalImageDataUrl || card.thumbnailDataUrl)) {
      const resolved = await resolveCardImageBlob(card);
      if (resolved) {
        resolvedBlob = resolved.blob;
        resolvedMime = resolved.mimeType;
      }
    }
    if (resolvedBlob) {
      imageHash = await computeBlobContentHash(resolvedBlob);
      imageByteSize = imageByteSize ?? resolvedBlob.size;
    }
  }

  const nextCard: WorkflowCollectionCard = {
    ...card,
    imageContentHash: imageHash,
    imageByteSize,
  };
  nextCard.contentFingerprint = computeCardContentFingerprint(nextCard);
  return { card: nextCard, resolvedBlob, resolvedMime };
}

export interface FolderSyncIndexEntry {
  cardId: string;
  relativePath: string;
  contentFingerprint: string;
  imageContentHash?: string;
  imageByteSize?: number;
  imageFileName?: string;
  updatedAt: number;
  syncedAt: number;
}

export interface FolderSyncIndexFile {
  schema: 'chibiprompt-folder-sync-index-v1';
  updatedAt: number;
  entries: Record<string, FolderSyncIndexEntry>;
  deletedTombstones?: Record<string, DeletedCardTombstone>;
}

async function readFolderSyncIndex(rootHandle: FileSystemDirectoryHandle): Promise<{
  entries: Record<string, FolderSyncIndexEntry>;
  deletedTombstones: Record<string, DeletedCardTombstone>;
  exists: boolean;
}> {
  try {
    const fileHandle = await rootHandle.getFileHandle(FOLDER_SYNC_INDEX_FILENAME, {
      create: false,
    });
    const file = await fileHandle.getFile();
    const parsed = JSON.parse(await file.text()) as Partial<FolderSyncIndexFile>;
    if (parsed && parsed.entries && typeof parsed.entries === 'object') {
      const rawTombstones =
        parsed.deletedTombstones && typeof parsed.deletedTombstones === 'object'
          ? (parsed.deletedTombstones as Record<string, DeletedCardTombstone>)
          : {};
      return {
        entries: { ...parsed.entries },
        deletedTombstones: mergeDeletedTombstonesMaps({}, rawTombstones),
        exists: true,
      };
    }
  } catch {
    // ignore missing or malformed index file
  }
  return { entries: {}, deletedTombstones: {}, exists: false };
}

async function writeFolderSyncIndex(
  rootHandle: FileSystemDirectoryHandle,
  entries: Record<string, FolderSyncIndexEntry>,
  deletedTombstones?: Record<string, DeletedCardTombstone>
): Promise<void> {
  try {
    const payload: FolderSyncIndexFile = {
      schema: 'chibiprompt-folder-sync-index-v1',
      updatedAt: Date.now(),
      entries,
      ...(deletedTombstones && Object.keys(deletedTombstones).length > 0
        ? { deletedTombstones }
        : {}),
    };
    await writeFileInDirectory(
      rootHandle,
      FOLDER_SYNC_INDEX_FILENAME,
      JSON.stringify(payload, null, 2)
    );
  } catch {
    // ignore non-fatal index write errors
  }
}

async function getSubdirectoryIfExists(
  rootHandle: FileSystemDirectoryHandle,
  segments: string[]
): Promise<FileSystemDirectoryHandle | null> {
  let cur = rootHandle;
  try {
    for (const seg of segments) {
      cur = await cur.getDirectoryHandle(seg, { create: false });
    }
    return cur;
  } catch {
    return null;
  }
}

async function fileExistsInDirectory(
  dirHandle: FileSystemDirectoryHandle,
  fileName: string
): Promise<boolean> {
  try {
    await dirHandle.getFileHandle(fileName, { create: false });
    return true;
  } catch {
    return false;
  }
}

async function isDirectoryEmpty(dirHandle: FileSystemDirectoryHandle): Promise<boolean> {
  try {
    const iter = (
      dirHandle as unknown as {
        values: () => AsyncIterable<FileSystemHandle>;
      }
    ).values();
    for await (const _entry of iter) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function tryRemoveEmptyAncestorDirs(
  rootHandle: FileSystemDirectoryHandle,
  segments: string[]
): Promise<void> {
  for (let len = segments.length; len >= 1; len--) {
    const parentSegs = segments.slice(0, len - 1);
    const leafName = segments[len - 1];
    // 保留 _私密区 根目录容器仅在彻底为空时可删（或若为空也可清理）
    const parentDir =
      parentSegs.length > 0
        ? await getSubdirectoryIfExists(rootHandle, parentSegs)
        : rootHandle;
    const leafDir =
      parentDir ? await getSubdirectoryIfExists(parentDir, [leafName]) : null;
    if (!parentDir || !leafDir) continue;
    if (await isDirectoryEmpty(leafDir)) {
      await parentDir.removeEntry(leafName).catch(() => undefined);
    } else {
      break;
    }
  }
}

async function removeMatchedCardFilesInDir(
  rootHandle: FileSystemDirectoryHandle,
  segments: string[],
  expectedCardId: string,
  extraKnownImageNames?: string[]
): Promise<{ matched: boolean; removedCount: number }> {
  const targetDir =
    segments.length > 0
      ? await getSubdirectoryIfExists(rootHandle, segments)
      : rootHandle;
  if (!targetDir) return { matched: false, removedCount: 0 };

  try {
    const iter = (
      targetDir as unknown as {
        values: () => AsyncIterable<FileSystemHandle>;
      }
    ).values();
    const entries: FileSystemHandle[] = [];
    for await (const handle of iter) {
      entries.push(handle);
    }

    const cardJsonHandles = entries.filter(
      (h): h is FileSystemFileHandle =>
        h.kind === 'file' && h.name.toLowerCase().endsWith('.card.json')
    );
    if (cardJsonHandles.length === 0) return { matched: false, removedCount: 0 };

    let totalRemoved = 0;
    let matched = false;

    for (const cardJsonHandle of cardJsonHandles) {
      let metaRaw: Partial<WorkflowCollectionCard> | null = null;
      try {
        metaRaw = JSON.parse(
          await (await cardJsonHandle.getFile()).text()
        ) as Partial<WorkflowCollectionCard>;
      } catch {
        metaRaw = null;
      }
      if (!metaRaw || metaRaw.id !== expectedCardId) continue;

      matched = true;
      const baseName = cardJsonHandle.name.replace(/\.card\.json$/i, '');
      const baseLower = baseName.toLowerCase();
      const candidateImageNames = new Set<string>(
        [
          ...(extraKnownImageNames ?? []),
          typeof metaRaw.imageName === 'string' ? metaRaw.imageName : '',
        ]
          .map((n) => n.trim().toLowerCase())
          .filter(Boolean)
      );

      for (const entry of entries) {
        if (entry.kind !== 'file') continue;
        const lower = entry.name.toLowerCase();
        const isMatchedImage =
          (IMAGE_FILE_EXT_RE.test(lower) &&
            (lower.replace(IMAGE_FILE_EXT_RE, '') === baseLower ||
              candidateImageNames.has(lower))) ||
          lower === `${baseLower}.workflow.json` ||
          lower === `${baseLower}.json` ||
          entry.name === cardJsonHandle.name ||
          entry.name.startsWith(`${baseName}.`);

        if (isMatchedImage) {
          await targetDir.removeEntry(entry.name).catch(() => undefined);
          totalRemoved += 1;
        }
      }
    }

    if (matched && segments.length >= 1) {
      await tryRemoveEmptyAncestorDirs(rootHandle, segments);
    }
    return { matched, removedCount: totalRemoved };
  } catch {
    return { matched: false, removedCount: 0 };
  }
}

async function tryCleanupMovedCardFiles(
  rootHandle: FileSystemDirectoryHandle,
  oldRelativePath: string,
  expectedCardId: string
): Promise<void> {
  const segments = oldRelativePath.split('/').filter(Boolean);
  if (segments.length === 0) return;
  await removeMatchedCardFilesInDir(rootHandle, segments, expectedCardId);
}

export async function writeCardToLocalDirectory(
  rootHandle: FileSystemDirectoryHandle,
  card: WorkflowCollectionCard,
  overrideImageBlob?: Blob | null,
  options?: {
    skipImageWrite?: boolean;
    previousRelativePath?: string;
  }
): Promise<FolderWriteCardResult & { writtenImageFileName?: string; card: WorkflowCollectionCard }> {
  const { card: hashedCard, resolvedBlob, resolvedMime } = await ensureCardContentHashes(
    card,
    overrideImageBlob
  );
  const segments = buildCardFolderPathSegments(hashedCard);
  const relativePath = segments.join('/');
  try {
    let targetDir = rootHandle;
    for (const seg of segments) {
      targetDir = await targetDir.getDirectoryHandle(seg, { create: true });
    }

    const baseName = sanitizeFilenamePrefix(hashedCard.title).slice(0, 48);
    let imgBlob: Blob | null = resolvedBlob;
    let imgMime = resolvedMime ?? hashedCard.originalImageMime;
    let writtenImageFileName: string | undefined;

    const hasAnyImg = Boolean(
      imgBlob ||
        hashedCard.hasOriginalImageBlob ||
        hashedCard.originalImageDataUrl ||
        hashedCard.thumbnailDataUrl
    );

    if (hasAnyImg) {
      const predictedExt = inferImageExtension(hashedCard, imgMime || imgBlob?.type);
      const predictedImgName = `${baseName}.${predictedExt}`;
      const canSkipImg =
        Boolean(options?.skipImageWrite) &&
        (await fileExistsInDirectory(targetDir, predictedImgName));

      if (canSkipImg) {
        writtenImageFileName = predictedImgName;
      } else {
        if (!imgBlob) {
          const resolved = await resolveCardImageBlob(hashedCard);
          if (resolved) {
            imgBlob = resolved.blob;
            imgMime = resolved.mimeType;
          }
        }
        if (imgBlob) {
          const ext = inferImageExtension(hashedCard, imgMime || imgBlob.type);
          const imgFileName = `${baseName}.${ext}`;
          await writeFileInDirectory(targetDir, imgFileName, imgBlob);
          writtenImageFileName = imgFileName;
        }
      }
    }

    const workflowText =
      hashedCard.rawWorkflowJson &&
      hashedCard.rawWorkflowJson.trim() &&
      hashedCard.rawWorkflowJson.trim() !== '{}'
        ? hashedCard.rawWorkflowJson
        : hashedCard.apiPromptJson || '{}';
    await writeFileInDirectory(targetDir, `${baseName}.workflow.json`, workflowText);

    const cardMetaPayload = JSON.stringify(
      {
        schema: 'chibiprompt-workflow-card-v1',
        id: hashedCard.id,
        title: hashedCard.title,
        tags: hashedCard.tags,
        isPrivate: Boolean(hashedCard.isPrivate),
        workflowFormat: hashedCard.workflowFormat,
        autoImportedSource: hashedCard.autoImportedSource,
        imageName: hashedCard.imageName,
        originalImageMime: imgMime ?? hashedCard.originalImageMime,
        originalImageWidth: hashedCard.originalImageWidth,
        originalImageHeight: hashedCard.originalImageHeight,
        imageByteSize: hashedCard.imageByteSize ?? imgBlob?.size,
        imageContentHash: hashedCard.imageContentHash,
        contentFingerprint: hashedCard.contentFingerprint,
        applyFineTuneOnSend: hashedCard.applyFineTuneOnSend,
        positiveNodeId: hashedCard.positiveNodeId,
        negativeNodeId: hashedCard.negativeNodeId,
        extractedPositive: hashedCard.extractedPositive,
        extractedNegative: hashedCard.extractedNegative,
        fineTunedPositive: hashedCard.fineTunedPositive,
        fineTunedNegative: hashedCard.fineTunedNegative,
        nodeCandidates: hashedCard.nodeCandidates,
        seedMode: hashedCard.seedMode ?? 'workflow',
        fixedSeed: hashedCard.fixedSeed,
        createdAt: hashedCard.createdAt,
        updatedAt: hashedCard.updatedAt,
      },
      null,
      2
    );
    await writeFileInDirectory(targetDir, `${baseName}.card.json`, cardMetaPayload);

    if (
      options?.previousRelativePath &&
      options.previousRelativePath !== relativePath
    ) {
      await tryCleanupMovedCardFiles(
        rootHandle,
        options.previousRelativePath,
        hashedCard.id
      );
    }

    const syncedCard: WorkflowCollectionCard = {
      ...hashedCard,
      folderSyncedPath: relativePath,
      folderSyncedFingerprint: hashedCard.contentFingerprint,
      folderSyncedImageHash: hashedCard.imageContentHash,
      lastFolderSyncAt: Date.now(),
    };

    return { ok: true, relativePath, writtenImageFileName, card: syncedCard };
  } catch (err) {
    return {
      ok: false,
      relativePath,
      card: hashedCard,
      error: err instanceof Error ? err.message : '写入本地文件夹失败',
    };
  }
}

export interface IncrementalFolderSyncResult {
  addedCount: number;
  updatedCount: number;
  skippedCount: number;
  succeededIds: string[];
  failed: { cardId: string; title: string; error: string }[];
  updatedCardsById: Map<string, WorkflowCollectionCard>;
  indexEntries: Record<string, FolderSyncIndexEntry>;
  deletedTombstones: Record<string, DeletedCardTombstone>;
}

export async function syncCardsIncrementalToLocalDirectory(
  rootHandle: FileSystemDirectoryHandle,
  cards: WorkflowCollectionCard[],
  options?: {
    blobsByCardId?: Map<string, Blob>;
    isCardActive?: (cardId: string) => boolean;
    extraTombstones?: Record<string, DeletedCardTombstone>;
    onProgress?: (
      done: number,
      total: number,
      currentTitle: string,
      actionLabel?: string,
      detail?: FolderSyncProgress
    ) => void;
  }
): Promise<IncrementalFolderSyncResult> {
  const { entries: initialEntries, deletedTombstones: diskTombstones } =
    await readFolderSyncIndex(rootHandle);
  const initialTombstones = options?.extraTombstones
    ? mergeDeletedTombstonesMaps(diskTombstones, options.extraTombstones)
    : { ...diskTombstones };

  const batchResult = await runIncrementalFolderSync<FolderSyncIndexEntry>({
    cards,
    initialEntries,
    initialTombstones,
    folderStorageKey: rootHandle.name,
    isCardActive: options?.isCardActive,
    prepareCard: async (rawCard) => {
      const overrideBlob = options?.blobsByCardId?.get(rawCard.id) ?? null;
      const { card: hashedCard } = await ensureCardContentHashes(rawCard, overrideBlob);
      return {
        card: hashedCard,
        targetRelativePath: buildCardFolderPathSegments(hashedCard).join('/'),
      };
    },
    probeFallbackEntry: async (hashedCard, targetRelPath) => {
      const baseName = sanitizeFilenamePrefix(hashedCard.title).slice(0, 48);
      const targetDir = await getSubdirectoryIfExists(
        rootHandle,
        targetRelPath.split('/').filter(Boolean)
      );
      if (!targetDir) return null;
      try {
        const cardFile = await (
          await targetDir.getFileHandle(`${baseName}.card.json`, { create: false })
        ).getFile();
        const diskMeta = JSON.parse(await cardFile.text()) as Partial<WorkflowCollectionCard>;
        if (diskMeta.id !== hashedCard.id) return null;
        const diskFingerprint =
          diskMeta.contentFingerprint ||
          computeCardContentFingerprint({
            ...hashedCard,
            ...diskMeta,
            imageContentHash: diskMeta.imageContentHash ?? hashedCard.imageContentHash,
            contentFingerprint: undefined,
          } as WorkflowCollectionCard);
        return {
          cardId: hashedCard.id,
          relativePath: targetRelPath,
          contentFingerprint: diskFingerprint,
          imageContentHash: diskMeta.imageContentHash,
          imageByteSize: diskMeta.imageByteSize,
          updatedAt: diskMeta.updatedAt ?? hashedCard.updatedAt,
          syncedAt: Date.now(),
        };
      } catch {
        return null;
      }
    },
    writeCard: async (hashedCard, writeOpts) => {
      const overrideBlob = options?.blobsByCardId?.get(hashedCard.id) ?? null;
      return writeCardToLocalDirectory(rootHandle, hashedCard, overrideBlob, writeOpts);
    },
    buildIndexEntry: (syncedCard, relativePath, writtenImageFileName) => ({
      cardId: syncedCard.id,
      relativePath,
      contentFingerprint: syncedCard.contentFingerprint!,
      imageContentHash: syncedCard.imageContentHash,
      imageByteSize: syncedCard.imageByteSize,
      imageFileName: writtenImageFileName,
      updatedAt: syncedCard.updatedAt,
      syncedAt: syncedCard.lastFolderSyncAt ?? Date.now(),
    }),
    persistIndex: async (entries, deletedTombstones) => {
      await writeFolderSyncIndex(rootHandle, entries, deletedTombstones);
    },
    onProgress: (progress) => {
      options?.onProgress?.(
        progress.done,
        progress.total,
        progress.currentTitle,
        progress.actionLabel,
        progress
      );
    },
  });

  return {
    addedCount: batchResult.addedCount,
    updatedCount: batchResult.updatedCount,
    skippedCount: batchResult.skippedCount,
    succeededIds: batchResult.succeededIds,
    failed: batchResult.failed,
    updatedCardsById: batchResult.updatedCardsById,
    indexEntries: batchResult.entries,
    deletedTombstones: batchResult.deletedTombstones,
  };
}

export interface FolderDeleteResult {
  deletedIds: string[];
  removedFilesCount: number;
  failed: { cardId: string; title: string; error: string }[];
  indexEntries: Record<string, FolderSyncIndexEntry>;
  deletedTombstones: Record<string, DeletedCardTombstone>;
}

export async function deleteCardsFromLocalDirectory(
  rootHandle: FileSystemDirectoryHandle,
  cardsToDelete: WorkflowCollectionCard[],
  options?: {
    extraTombstones?: Record<string, DeletedCardTombstone>;
  }
): Promise<FolderDeleteResult> {
  const { entries: indexEntries, deletedTombstones: diskTombstones } =
    await readFolderSyncIndex(rootHandle);
  const deletedTombstones = options?.extraTombstones
    ? mergeDeletedTombstonesMaps(diskTombstones, options.extraTombstones)
    : { ...diskTombstones };

  const deletedIds: string[] = [];
  const failed: { cardId: string; title: string; error: string }[] = [];
  const unresolvedCards = new Map<string, WorkflowCollectionCard>();
  let removedFilesCount = 0;
  let indexDirty = false;
  const now = Date.now();

  for (const card of cardsToDelete) {
    const entry = indexEntries[card.id];
    const candidateRelPaths = Array.from(
      new Set(
        [
          entry?.relativePath,
          card.folderSyncedPath,
          buildCardFolderPathSegments(card).join('/'),
          buildCardFolderPathSegments({ ...card, isPrivate: !card.isPrivate }).join('/'),
        ].filter((p): p is string => Boolean(p && p.trim()))
      )
    );

    const extraImgs = [entry?.imageFileName, card.imageName].filter((s): s is string =>
      Boolean(s)
    );

    let cardMatched = false;
    try {
      for (const relPath of candidateRelPaths) {
        const res = await removeMatchedCardFilesInDir(
          rootHandle,
          relPath.split('/').filter(Boolean),
          card.id,
          extraImgs
        );
        if (res.matched) {
          cardMatched = true;
          removedFilesCount += res.removedCount;
        }
      }
      if (!cardMatched) {
        unresolvedCards.set(card.id, card);
      } else {
        deletedIds.push(card.id);
      }
    } catch (err) {
      failed.push({
        cardId: card.id,
        title: card.title,
        error: err instanceof Error ? err.message : '删除本地文件失败',
      });
    }

    if (card.id in indexEntries) {
      delete indexEntries[card.id];
      indexDirty = true;
    }

    deletedTombstones[card.id] = {
      cardId: card.id,
      title: card.title,
      deletedAt: now,
      contentFingerprint: card.contentFingerprint || computeCardContentFingerprint(card),
      imageContentHash: card.imageContentHash,
      imageName: card.imageName,
      imageByteSize: card.imageByteSize,
      relativePath: entry?.relativePath || card.folderSyncedPath,
      diskFilesDeleted: cardMatched,
    };
    indexDirty = true;
  }

  // 若卡片此前被重命名/转移过目录而不在预测路径中，执行一次快速遍历精准清理残留 .card.json 及同级文件
  if (unresolvedCards.size > 0) {
    const matchedDirPaths = new Map<string, { segments: string[]; cardIds: string[] }>();

    async function walkFindCards(
      dirHandle: FileSystemDirectoryHandle,
      relSegments: string[],
      depth: number
    ): Promise<void> {
      if (depth > 8 || unresolvedCards.size === 0) return;
      const subDirs: { name: string; handle: FileSystemDirectoryHandle }[] = [];
      const iter = (
        dirHandle as unknown as {
          values: () => AsyncIterable<FileSystemHandle>;
        }
      ).values();

      for await (const handle of iter) {
        const name = handle.name;
        const lower = name.toLowerCase();
        if (handle.kind === 'directory') {
          if (name.startsWith('.') || lower === 'node_modules') continue;
          subDirs.push({ name, handle: handle as FileSystemDirectoryHandle });
        } else if (handle.kind === 'file' && lower.endsWith('.card.json')) {
          try {
            const rawMeta = JSON.parse(
              await (await (handle as FileSystemFileHandle).getFile()).text()
            ) as Partial<WorkflowCollectionCard>;
            if (rawMeta.id && unresolvedCards.has(rawMeta.id)) {
              const key = relSegments.join('/');
              const bucket = matchedDirPaths.get(key) ?? {
                segments: relSegments,
                cardIds: [],
              };
              bucket.cardIds.push(rawMeta.id);
              matchedDirPaths.set(key, bucket);
            }
          } catch {
            // ignore corrupt .card.json
          }
        }
      }

      for (const sub of subDirs) {
        await walkFindCards(sub.handle, [...relSegments, sub.name], depth + 1);
      }
    }

    await walkFindCards(rootHandle, [], 0);

    for (const bucket of matchedDirPaths.values()) {
      for (const cardId of bucket.cardIds) {
        const card = unresolvedCards.get(cardId);
        if (!card) continue;
        const res = await removeMatchedCardFilesInDir(
          rootHandle,
          bucket.segments,
          cardId,
          card.imageName ? [card.imageName] : undefined
        );
        if (res.matched) {
          removedFilesCount += res.removedCount;
        }
        unresolvedCards.delete(cardId);
        deletedIds.push(cardId);
        if (deletedTombstones[cardId]) {
          deletedTombstones[cardId] = {
            ...deletedTombstones[cardId],
            diskFilesDeleted: true,
          };
        }
      }
    }

    // 其余在磁盘上本就不存在的卡片也标记为磁盘已无残留
    for (const [cardId] of unresolvedCards.entries()) {
      deletedIds.push(cardId);
      if (deletedTombstones[cardId]) {
        deletedTombstones[cardId] = {
          ...deletedTombstones[cardId],
          diskFilesDeleted: true,
        };
      }
    }
  }

  if (indexDirty) {
    await writeFolderSyncIndex(rootHandle, indexEntries, deletedTombstones);
  }

  return {
    deletedIds,
    removedFilesCount,
    failed,
    indexEntries,
    deletedTombstones,
  };
}

export async function writeCardsBatchToLocalDirectory(
  rootHandle: FileSystemDirectoryHandle,
  cards: WorkflowCollectionCard[],
  options?: {
    blobsByCardId?: Map<string, Blob>;
    onProgress?: (done: number, total: number, currentTitle: string) => void;
  }
): Promise<{
  succeededIds: string[];
  failed: { cardId: string; title: string; error: string }[];
  addedCount: number;
  updatedCount: number;
  skippedCount: number;
  updatedCardsById: Map<string, WorkflowCollectionCard>;
}> {
  const res = await syncCardsIncrementalToLocalDirectory(rootHandle, cards, {
    blobsByCardId: options?.blobsByCardId,
    onProgress: (done, total, currentTitle) => {
      options?.onProgress?.(done, total, currentTitle);
    },
  });
  return {
    succeededIds: res.succeededIds,
    failed: res.failed,
    addedCount: res.addedCount,
    updatedCount: res.updatedCount,
    skippedCount: res.skippedCount,
    updatedCardsById: res.updatedCardsById,
  };
}

export interface IncomingCardWithBlob {
  card: WorkflowCollectionCard;
  imageBlob?: Blob | null;
  mimeType?: string;
  sourceLabel?: string;
  relativeFolderPath?: string;
  fileModifiedAt?: number;
  fromCollectionJson?: boolean;
}

export interface DedupeMergeStats {
  totalIncoming: number;
  addedCount: number;
  updatedCount: number;
  skippedDuplicateCount: number;
  skippedTombstoneCount: number;
  totalSkippedCount: number;
  restoredImageBlobsCount: number;
}

export interface DedupeMergeResult {
  mergedCards: WorkflowCollectionCard[];
  addedCards: WorkflowCollectionCard[];
  updatedCards: WorkflowCollectionCard[];
  skippedDuplicates: { fileName: string; reason: string; existingTitle: string }[];
  skippedTombstones: { fileName: string; reason: string; title: string; cardId: string }[];
  reintroducedFromTombstone: {
    fileName: string;
    title: string;
    cardId: string;
    reason: string;
  }[];
  clearedTombstoneIds: string[];
  restoredImageBlobsCount: number;
  blobsToSave: { cardId: string; record: StoredCardImageRecord }[];
  stats: DedupeMergeStats;
}

function findMatchingTombstone(
  tombstones: Record<string, DeletedCardTombstone> | undefined,
  card: WorkflowCollectionCard,
  incomingHash?: string
): DeletedCardTombstone | null {
  if (!tombstones) return null;
  if (tombstones[card.id]) return tombstones[card.id];
  const fp = card.contentFingerprint;
  for (const t of Object.values(tombstones)) {
    if (incomingHash && t.imageContentHash && t.imageContentHash === incomingHash) {
      return t;
    }
    if (fp && t.contentFingerprint && t.contentFingerprint === fp) {
      return t;
    }
  }
  return null;
}

export async function dedupeAndMergeIncomingCards(
  existingCards: WorkflowCollectionCard[],
  incomingItems: IncomingCardWithBlob[],
  options?: {
    storedImageIds?: Set<string>;
    preferIncomingOnSameIdUpdate?: boolean;
    markAsFolderSynced?: boolean;
    tombstones?: Record<string, DeletedCardTombstone>;
    sourceMode?: 'folder-scan' | 'manual-import';
  }
): Promise<DedupeMergeResult> {
  const storedIds =
    options?.storedImageIds ??
    (isIndexedDbSupported() ? await listStoredCardImageIds() : new Set<string>());

  const workingCards = existingCards.map((c) => ({ ...c }));
  const cardIndexById = new Map<string, number>();
  const cardIndexByContentHash = new Map<string, number>();
  const cardIndexByImageHash = new Map<string, number>();
  const cardIndicesByNameSize = new Map<string, number[]>();
  const cardIndexByWorkflowSig = new Map<string, number>();

  const registerCardIndex = (idx: number, card: WorkflowCollectionCard) => {
    cardIndexById.set(card.id, idx);
    const contentHash = card.contentFingerprint || computeCardContentFingerprint(card);
    if (!cardIndexByContentHash.has(contentHash)) {
      cardIndexByContentHash.set(contentHash, idx);
    }
    if (card.imageContentHash) {
      cardIndexByImageHash.set(card.imageContentHash, idx);
    }
    if (card.imageName && card.imageByteSize) {
      const key = `${card.imageName.trim().toLowerCase()}::${card.imageByteSize}`;
      const list = cardIndicesByNameSize.get(key) ?? [];
      if (!list.includes(idx)) list.push(idx);
      cardIndicesByNameSize.set(key, list);
    }
    if (!card.imageContentHash && !card.hasOriginalImageBlob && !card.thumbnailDataUrl) {
      const sig = `${card.title.trim().toLowerCase()}::${computeWorkflowSignature(card)}`;
      cardIndexByWorkflowSig.set(sig, idx);
    }
  };

  workingCards.forEach((c, idx) => registerCardIndex(idx, c));

  const addedCards: WorkflowCollectionCard[] = [];
  const updatedCards: WorkflowCollectionCard[] = [];
  const skippedDuplicates: { fileName: string; reason: string; existingTitle: string }[] = [];
  const skippedTombstones: { fileName: string; reason: string; title: string; cardId: string }[] = [];
  const reintroducedFromTombstone: {
    fileName: string;
    title: string;
    cardId: string;
    reason: string;
  }[] = [];
  const clearedTombstoneIdsSet = new Set<string>();
  const blobsToSave: { cardId: string; record: StoredCardImageRecord }[] = [];
  let restoredImageBlobsCount = 0;

  const prependedNewCards: WorkflowCollectionCard[] = [];
  const sourceMode = options?.sourceMode ?? 'manual-import';

  for (let i = 0; i < incomingItems.length; i++) {
    const item = incomingItems[i];
    const sourceLabel =
      item.sourceLabel || item.card.imageName || item.card.workflowFileName || item.card.title;

    let incomingBlob = item.imageBlob ?? null;
    if (!incomingBlob && item.card.originalImageDataUrl) {
      try {
        incomingBlob = decodeDataUrlToBlob(item.card.originalImageDataUrl);
      } catch {
        incomingBlob = null;
      }
    }

    let incomingHash = item.card.imageContentHash;
    const incomingByteSize = item.card.imageByteSize ?? incomingBlob?.size;
    if (!incomingHash && incomingBlob) {
      incomingHash = await computeBlobContentHash(incomingBlob);
    }

    const normalizedIncoming: WorkflowCollectionCard = {
      ...item.card,
      imageContentHash: incomingHash,
      imageByteSize: incomingByteSize,
      hasOriginalImageBlob: Boolean(
        incomingBlob || item.card.hasOriginalImageBlob || item.card.originalImageDataUrl
      ),
      originalImageDataUrl:
        isIndexedDbSupported() && incomingBlob ? undefined : item.card.originalImageDataUrl,
      thumbnailDataUrl:
        isIndexedDbSupported() && incomingBlob ? '' : item.card.thumbnailDataUrl,
    };
    const incomingContentHash = computeCardContentFingerprint(normalizedIncoming);
    normalizedIncoming.contentFingerprint = incomingContentHash;

    // 1. 去重校验：优先按卡片 ID 匹配，其次按内容哈希 (contentFingerprint) 与原图哈希 (imageContentHash) 匹配
    let matchedIdx = cardIndexById.get(normalizedIncoming.id);
    let matchBasis = matchedIdx !== undefined ? '卡片 ID 相同' : '';

    if (matchedIdx === undefined) {
      matchedIdx = cardIndexByContentHash.get(incomingContentHash);
      if (matchedIdx !== undefined) {
        matchBasis = '内容哈希一致';
      }
    }

    if (matchedIdx === undefined && incomingHash) {
      matchedIdx = cardIndexByImageHash.get(incomingHash);
      if (matchedIdx !== undefined) {
        matchBasis = '原图哈希一致';
      } else if (normalizedIncoming.imageName && incomingByteSize) {
        const nameSizeKey = `${normalizedIncoming.imageName
          .trim()
          .toLowerCase()}::${incomingByteSize}`;
        const candidates = cardIndicesByNameSize.get(nameSizeKey) ?? [];
        for (const candIdx of candidates) {
          const cand = workingCards[candIdx];
          if (!cand.imageContentHash) {
            const { card: enrichedCand } = await ensureCardContentHashes(cand);
            workingCards[candIdx] = enrichedCand;
            if (enrichedCand.imageContentHash) {
              cardIndexByImageHash.set(enrichedCand.imageContentHash, candIdx);
            }
            if (enrichedCand.contentFingerprint) {
              cardIndexByContentHash.set(enrichedCand.contentFingerprint, candIdx);
            }
          }
          if (workingCards[candIdx].imageContentHash === incomingHash) {
            matchedIdx = candIdx;
            matchBasis = '原图哈希一致';
            break;
          }
        }
      }
    }

    if (
      matchedIdx === undefined &&
      !incomingHash &&
      !normalizedIncoming.hasOriginalImageBlob
    ) {
      const sig = `${normalizedIncoming.title
        .trim()
        .toLowerCase()}::${computeWorkflowSignature(normalizedIncoming)}`;
      matchedIdx = cardIndexByWorkflowSig.get(sig);
      if (matchedIdx !== undefined) {
        matchBasis = '工作流内容一致';
      }
    }

    // 检查是否与同批次中刚新增的卡片重复（ID / 内容哈希 / 原图哈希 / 工作流签名）
    if (matchedIdx === undefined) {
      const dupInBatch = prependedNewCards.find((p) => {
        if (p.id === normalizedIncoming.id) return true;
        if (p.contentFingerprint && p.contentFingerprint === incomingContentHash) {
          return true;
        }
        if (incomingHash && p.imageContentHash && p.imageContentHash === incomingHash) {
          return true;
        }
        if (
          !incomingHash &&
          !p.imageContentHash &&
          p.title.trim().toLowerCase() === normalizedIncoming.title.trim().toLowerCase() &&
          computeWorkflowSignature(p) === computeWorkflowSignature(normalizedIncoming)
        ) {
          return true;
        }
        return false;
      });
      if (dupInBatch) {
        skippedDuplicates.push({
          fileName: sourceLabel,
          reason: `与本批已导入卡片「${dupInBatch.title}」重复（ID 或内容哈希相同），已跳过`,
          existingTitle: dupInBatch.title,
        });
        continue;
      }

      // 2. 已删除卡片墓碑校验：防止目录扫描或旧备份 JSON 将已删除卡片复活
      const matchedTombstone = findMatchingTombstone(
        options?.tombstones,
        normalizedIncoming,
        incomingHash
      );
      if (matchedTombstone) {
        if (sourceMode === 'folder-scan') {
          const modifiedAfterDelete =
            (item.fileModifiedAt ?? 0) > matchedTombstone.deletedAt + 2000;
          const replacedAfterDiskDelete = matchedTombstone.diskFilesDeleted;
          if (!modifiedAfterDelete && !replacedAfterDiskDelete) {
            skippedTombstones.push({
              cardId: normalizedIncoming.id,
              title: normalizedIncoming.title,
              fileName: sourceLabel,
              reason: `该卡片已于此前删除（本地旧文件未清理），已按删除记录跳过以防复活`,
            });
            continue;
          }
          clearedTombstoneIdsSet.add(matchedTombstone.cardId);
          reintroducedFromTombstone.push({
            cardId: normalizedIncoming.id,
            title: normalizedIncoming.title,
            fileName: sourceLabel,
            reason: '检测到本地文件夹中重新放入了曾删除的同名/同源新文件，已重新收录',
          });
        } else {
          if (
            item.fromCollectionJson &&
            normalizedIncoming.updatedAt <= matchedTombstone.deletedAt
          ) {
            skippedTombstones.push({
              cardId: normalizedIncoming.id,
              title: normalizedIncoming.title,
              fileName: sourceLabel,
              reason: `该卡片已被用户删除（此 JSON 为删除前旧备份），已跳过以防复活`,
            });
            continue;
          }
          clearedTombstoneIdsSet.add(matchedTombstone.cardId);
          reintroducedFromTombstone.push({
            cardId: normalizedIncoming.id,
            title: normalizedIncoming.title,
            fileName: sourceLabel,
            reason: '曾被删除的卡片已通过手动导入重新收录并清除删除记录',
          });
        }
      }

      // 全新卡片：入库
      const finalNewCard: WorkflowCollectionCard = options?.markAsFolderSynced
        ? {
            ...normalizedIncoming,
            folderSyncedPath:
              item.relativeFolderPath ??
              buildCardFolderPathSegments(normalizedIncoming).join('/'),
            folderSyncedFingerprint: normalizedIncoming.contentFingerprint,
            folderSyncedImageHash: normalizedIncoming.imageContentHash,
            lastFolderSyncAt: normalizedIncoming.lastFolderSyncAt ?? Date.now(),
          }
        : normalizedIncoming;

      prependedNewCards.push(finalNewCard);
      addedCards.push(finalNewCard);

      if (incomingBlob && isIndexedDbSupported()) {
        blobsToSave.push({
          cardId: finalNewCard.id,
          record: {
            blob: incomingBlob,
            mimeType:
              item.mimeType ||
              finalNewCard.originalImageMime ||
              incomingBlob.type ||
              'image/png',
            width: finalNewCard.originalImageWidth,
            height: finalNewCard.originalImageHeight,
            byteSize: incomingBlob.size,
            updatedAt: finalNewCard.updatedAt,
          },
        });
        storedIds.add(finalNewCard.id);
      }
      continue;
    }

    // 已命中现有卡片：判断是「无变化跳过」还是「缺失原图恢复 / 内容更新覆盖」
    const existing = workingCards[matchedIdx];
    const existingFingerprint =
      existing.contentFingerprint ||
      (await ensureCardContentHashes(existing)).card.contentFingerprint!;
    const incomingFingerprint = normalizedIncoming.contentFingerprint!;

    const missingIdbBlob =
      Boolean(incomingBlob) &&
      isIndexedDbSupported() &&
      !storedIds.has(existing.id) &&
      !existing.originalImageDataUrl;

    const sameId = existing.id === normalizedIncoming.id;
    const isIncomingModified =
      sameId &&
      existingFingerprint !== incomingFingerprint &&
      (options?.preferIncomingOnSameIdUpdate ??
        normalizedIncoming.updatedAt > existing.updatedAt);

    if (!isIncomingModified && !missingIdbBlob) {
      // 幂等跳过，但若旧卡片缺少 hash/同步标记可静默补齐
      if (
        (incomingHash && !existing.imageContentHash) ||
        (options?.markAsFolderSynced && !existing.folderSyncedFingerprint)
      ) {
        workingCards[matchedIdx] = {
          ...existing,
          imageContentHash: existing.imageContentHash ?? incomingHash,
          imageByteSize: existing.imageByteSize ?? incomingByteSize,
          contentFingerprint: existingFingerprint,
          ...(options?.markAsFolderSynced
            ? {
                folderSyncedPath:
                  item.relativeFolderPath ??
                  buildCardFolderPathSegments(existing).join('/'),
                folderSyncedFingerprint: existingFingerprint,
                folderSyncedImageHash: existing.imageContentHash ?? incomingHash,
                lastFolderSyncAt: existing.lastFolderSyncAt ?? Date.now(),
              }
            : {}),
        };
      }
      skippedDuplicates.push({
        fileName: sourceLabel,
        reason: `工作台已存在相同卡片「${existing.title}」（${matchBasis || '内容哈希一致'}），跳过重复`,
        existingTitle: existing.title,
      });
      continue;
    }

    if (missingIdbBlob && incomingBlob && !isIncomingModified) {
      blobsToSave.push({
        cardId: existing.id,
        record: {
          blob: incomingBlob,
          mimeType:
            item.mimeType ||
            existing.originalImageMime ||
            incomingBlob.type ||
            'image/png',
          width: existing.originalImageWidth ?? normalizedIncoming.originalImageWidth,
          height: existing.originalImageHeight ?? normalizedIncoming.originalImageHeight,
          byteSize: incomingBlob.size,
          updatedAt: existing.updatedAt,
        },
      });
      storedIds.add(existing.id);
      restoredImageBlobsCount += 1;
      const repaired: WorkflowCollectionCard = {
        ...existing,
        hasOriginalImageBlob: true,
        imageByteSize: existing.imageByteSize ?? incomingBlob.size,
        imageContentHash: existing.imageContentHash ?? incomingHash,
        originalImageWidth:
          existing.originalImageWidth ?? normalizedIncoming.originalImageWidth,
        originalImageHeight:
          existing.originalImageHeight ?? normalizedIncoming.originalImageHeight,
        contentFingerprint: existingFingerprint,
        ...(options?.markAsFolderSynced
          ? {
              folderSyncedPath:
                item.relativeFolderPath ??
                buildCardFolderPathSegments(existing).join('/'),
              folderSyncedFingerprint: existingFingerprint,
              folderSyncedImageHash: existing.imageContentHash ?? incomingHash,
              lastFolderSyncAt: Date.now(),
            }
          : {}),
      };
      workingCards[matchedIdx] = repaired;
      updatedCards.push(repaired);
      continue;
    }

    // 覆盖更新同 ID 卡片
    const updatedCard: WorkflowCollectionCard = {
      ...existing,
      ...normalizedIncoming,
      id: existing.id,
      lastRunAt: existing.lastRunAt,
      lastPromptId: existing.lastPromptId,
      ...(options?.markAsFolderSynced
        ? {
            folderSyncedPath:
              item.relativeFolderPath ??
              buildCardFolderPathSegments(normalizedIncoming).join('/'),
            folderSyncedFingerprint: incomingFingerprint,
            folderSyncedImageHash: incomingHash,
            lastFolderSyncAt: Date.now(),
          }
        : {}),
    };
    workingCards[matchedIdx] = updatedCard;
    updatedCards.push(updatedCard);

    if (
      incomingBlob &&
      isIndexedDbSupported() &&
      (!storedIds.has(existing.id) || existing.imageContentHash !== incomingHash)
    ) {
      blobsToSave.push({
        cardId: existing.id,
        record: {
          blob: incomingBlob,
          mimeType:
            item.mimeType ||
            updatedCard.originalImageMime ||
            incomingBlob.type ||
            'image/png',
          width: updatedCard.originalImageWidth,
          height: updatedCard.originalImageHeight,
          byteSize: incomingBlob.size,
          updatedAt: updatedCard.updatedAt,
        },
      });
      storedIds.add(existing.id);
    }
  }

  if (blobsToSave.length > 0 && isIndexedDbSupported()) {
    await saveCardImageBlobsBatch(blobsToSave);
  }

  return {
    mergedCards: [...prependedNewCards, ...workingCards],
    addedCards,
    updatedCards,
    skippedDuplicates,
    skippedTombstones,
    reintroducedFromTombstone,
    clearedTombstoneIds: Array.from(clearedTombstoneIdsSet),
    restoredImageBlobsCount,
    blobsToSave,
    stats: {
      totalIncoming: incomingItems.length,
      addedCount: addedCards.length,
      updatedCount: updatedCards.length,
      skippedDuplicateCount: skippedDuplicates.length,
      skippedTombstoneCount: skippedTombstones.length,
      totalSkippedCount: skippedDuplicates.length + skippedTombstones.length,
      restoredImageBlobsCount,
    },
  };
}

export async function findDuplicateCardForSingleDraft(
  existingCards: WorkflowCollectionCard[],
  params: {
    imageFile?: File | null;
    imageContentHash?: string;
    rawWorkflowJson: string;
    apiPromptJson?: string;
    extractedPositive: string;
    extractedNegative: string;
  }
): Promise<WorkflowCollectionCard | null> {
  const wfSig = computeWorkflowSignature({
    rawWorkflowJson: params.rawWorkflowJson,
    apiPromptJson: params.apiPromptJson,
    extractedPositive: params.extractedPositive,
    extractedNegative: params.extractedNegative,
  });

  let draftImageHash = params.imageContentHash;
  if (!draftImageHash && params.imageFile) {
    draftImageHash = await computeBlobContentHash(params.imageFile);
  }

  for (const existing of existingCards) {
    const existingWfSig = computeWorkflowSignature(existing);
    if (existingWfSig !== wfSig) continue;

    if (!draftImageHash && !existing.hasOriginalImageBlob && !existing.thumbnailDataUrl) {
      return existing;
    }
    if (draftImageHash) {
      const hash =
        existing.imageContentHash ?? (await ensureCardContentHashes(existing)).card.imageContentHash;
      if (hash && hash === draftImageHash) {
        return existing;
      }
    }
  }
  return null;
}

export interface LocalFolderScanMergeResult extends DedupeMergeResult {
  scannedFilesCount: number;
  discoveredCardsCount: number;
  indexEntries: Record<string, FolderSyncIndexEntry>;
  tombstones: Record<string, DeletedCardTombstone>;
}

const IMAGE_FILE_EXT_RE = /\.(png|jpe?g|webp)$/i;

export async function scanLocalDirectoryAndMerge(
  rootHandle: FileSystemDirectoryHandle,
  existingCards: WorkflowCollectionCard[],
  options?: {
    tombstones?: Record<string, DeletedCardTombstone>;
    onProgress?: (scannedCount: number, currentPath: string) => void;
  }
): Promise<LocalFolderScanMergeResult> {
  const { entries: existingIndexEntries, deletedTombstones: diskTombstones } =
    await readFolderSyncIndex(rootHandle);
  const effectiveTombstones = mergeDeletedTombstonesMaps(
    diskTombstones,
    options?.tombstones ?? {}
  );

  const incomingItems: IncomingCardWithBlob[] = [];
  let scannedFilesCount = 0;

  async function walkDir(
    dirHandle: FileSystemDirectoryHandle,
    relSegments: string[],
    depth: number
  ): Promise<void> {
    if (depth > 8) return;
    const subDirs: { name: string; handle: FileSystemDirectoryHandle }[] = [];
    const cardJsonHandles: FileSystemFileHandle[] = [];
    const workflowJsonHandles: FileSystemFileHandle[] = [];
    const imageHandles: FileSystemFileHandle[] = [];

    const iter = (
      dirHandle as unknown as {
        values: () => AsyncIterable<FileSystemHandle>;
      }
    ).values();

    for await (const handle of iter) {
      const name = handle.name;
      const lower = name.toLowerCase();
      if (handle.kind === 'directory') {
        // 显式保留 _私密区，仅忽略 .git/.vscode 等点开头系统目录与 node_modules
        if (name.startsWith('.') || lower === 'node_modules') continue;
        subDirs.push({ name, handle: handle as FileSystemDirectoryHandle });
      } else if (handle.kind === 'file') {
        if (lower === FOLDER_SYNC_INDEX_FILENAME || name.startsWith('.')) continue;
        if (lower.endsWith('.card.json')) {
          cardJsonHandles.push(handle as FileSystemFileHandle);
        } else if (lower.endsWith('.workflow.json') || lower.endsWith('.json')) {
          workflowJsonHandles.push(handle as FileSystemFileHandle);
        } else if (IMAGE_FILE_EXT_RE.test(lower)) {
          imageHandles.push(handle as FileSystemFileHandle);
        }
      }
    }

    const relFolderPath = relSegments.join('/');
    const underPrivateDir = relSegments.includes('_私密区');

    if (cardJsonHandles.length > 0) {
      for (const cardHandle of cardJsonHandles) {
        scannedFilesCount += 1;
        options?.onProgress?.(
          scannedFilesCount,
          relFolderPath ? `${relFolderPath}/${cardHandle.name}` : cardHandle.name
        );

        try {
          const cardFile = await cardHandle.getFile();
          const rawMeta = JSON.parse(await cardFile.text()) as Partial<WorkflowCollectionCard>;
          if (!rawMeta || typeof rawMeta !== 'object') continue;

          const baseName = cardHandle.name.replace(/\.card\.json$/i, '');
          const baseLower = baseName.toLowerCase();

          // 匹配同级工作流 JSON
          const matchedWfHandle =
            workflowJsonHandles.find(
              (h) =>
                h.name.toLowerCase() === `${baseLower}.workflow.json` ||
                h.name.toLowerCase() === `${baseLower}.json`
            ) ??
            (cardJsonHandles.length === 1 && workflowJsonHandles.length === 1
              ? workflowJsonHandles[0]
              : undefined);

          let rawWorkflowText =
            typeof rawMeta.rawWorkflowJson === 'string' ? rawMeta.rawWorkflowJson : '';
          if (matchedWfHandle) {
            try {
              rawWorkflowText = await (await matchedWfHandle.getFile()).text();
            } catch {
              // ignore
            }
          }

          // 匹配同级原图文件
          const matchedImgHandle =
            imageHandles.find((h) => {
              const stem = h.name.replace(IMAGE_FILE_EXT_RE, '').toLowerCase();
              return stem === baseLower;
            }) ??
            (rawMeta.imageName
              ? imageHandles.find(
                  (h) => h.name.toLowerCase() === rawMeta.imageName!.toLowerCase()
                )
              : undefined) ??
            (cardJsonHandles.length === 1 && imageHandles.length === 1
              ? imageHandles[0]
              : undefined);

          let imgFile: File | null = null;
          let dims: { width?: number; height?: number } = {};
          let imgHash = rawMeta.imageContentHash;
          if (matchedImgHandle) {
            imgFile = await matchedImgHandle.getFile();
            dims = await readImageDimensions(imgFile);
            imgHash = await computeBlobContentHash(imgFile);
          }

          let parsedFallback: ParsedWorkflowSource | null = null;
          if (
            rawWorkflowText &&
            rawWorkflowText.trim() !== '{}' &&
            (!Array.isArray(rawMeta.nodeCandidates) ||
              rawMeta.nodeCandidates.length === 0 ||
              !rawMeta.apiPromptJson)
          ) {
            try {
              parsedFallback = parseComfyWorkflowSource({ rawJsonText: rawWorkflowText });
            } catch {
              parsedFallback = null;
            }
          }

          const normalizedList = normalizeWorkflowCards([
            {
              ...rawMeta,
              id:
                typeof rawMeta.id === 'string' && rawMeta.id
                  ? rawMeta.id
                  : `wf-card-disk-${computeFastDigest64(
                      `${relFolderPath}/${cardHandle.name}`
                    ).slice(-10)}`,
              isPrivate:
                typeof rawMeta.isPrivate === 'boolean'
                  ? rawMeta.isPrivate || underPrivateDir
                  : underPrivateDir,
              imageName: rawMeta.imageName || imgFile?.name || '',
              originalImageMime:
                rawMeta.originalImageMime || imgFile?.type || 'image/png',
              originalImageWidth: rawMeta.originalImageWidth ?? dims.width,
              originalImageHeight: rawMeta.originalImageHeight ?? dims.height,
              hasOriginalImageBlob: Boolean(imgFile || rawMeta.hasOriginalImageBlob),
              imageByteSize: imgFile?.size ?? rawMeta.imageByteSize,
              imageContentHash: imgHash,
              workflowFileName:
                rawMeta.workflowFileName ||
                matchedWfHandle?.name ||
                `${baseName}.workflow.json`,
              workflowFormat:
                rawMeta.workflowFormat ?? parsedFallback?.workflowFormat ?? 'unknown',
              rawWorkflowJson: rawWorkflowText || parsedFallback?.rawWorkflowJson || '{}',
              apiPromptJson: rawMeta.apiPromptJson ?? parsedFallback?.apiPromptJson,
              extractedPositive:
                rawMeta.extractedPositive ?? parsedFallback?.extractedPositive ?? '',
              extractedNegative:
                rawMeta.extractedNegative ?? parsedFallback?.extractedNegative ?? '',
              fineTunedPositive:
                rawMeta.fineTunedPositive ??
                rawMeta.extractedPositive ??
                parsedFallback?.extractedPositive ??
                '',
              fineTunedNegative:
                rawMeta.fineTunedNegative ??
                rawMeta.extractedNegative ??
                parsedFallback?.extractedNegative ??
                '',
              positiveNodeId:
                rawMeta.positiveNodeId !== undefined
                  ? rawMeta.positiveNodeId
                  : parsedFallback?.positiveNodeId ?? null,
              negativeNodeId:
                rawMeta.negativeNodeId !== undefined
                  ? rawMeta.negativeNodeId
                  : parsedFallback?.negativeNodeId ?? null,
              nodeCandidates:
                Array.isArray(rawMeta.nodeCandidates) && rawMeta.nodeCandidates.length > 0
                  ? rawMeta.nodeCandidates
                  : parsedFallback?.nodeCandidates ?? [],
            },
          ]);

          if (normalizedList.length > 0) {
            const restoredCard = normalizedList[0];
            restoredCard.contentFingerprint =
              computeCardContentFingerprint(restoredCard);
            const fileModifiedAt = Math.max(
              cardFile.lastModified || 0,
              imgFile?.lastModified || 0
            );
            incomingItems.push({
              card: restoredCard,
              imageBlob: imgFile,
              mimeType: imgFile?.type || restoredCard.originalImageMime,
              sourceLabel: relFolderPath
                ? `${relFolderPath}/${cardHandle.name}`
                : cardHandle.name,
              relativeFolderPath: relFolderPath,
              fileModifiedAt,
            });
          }
        } catch {
          // 跳过损坏的 .card.json，继续扫描其余目录
        }

        if (scannedFilesCount % 5 === 0) {
          await new Promise((r) => setTimeout(r, 0));
        }
      }
    }

    for (const sub of subDirs) {
      await walkDir(sub.handle, [...relSegments, sub.name], depth + 1);
    }
  }

  await walkDir(rootHandle, [], 0);

  const mergeResult = await dedupeAndMergeIncomingCards(existingCards, incomingItems, {
    preferIncomingOnSameIdUpdate: false,
    markAsFolderSynced: true,
    tombstones: effectiveTombstones,
    sourceMode: 'folder-scan',
  });

  // 清除已重新放入文件夹的墓碑记录
  const nextTombstones = { ...effectiveTombstones };
  let indexUpdated = mergeResult.skippedTombstones.length > 0;
  for (const clearedId of mergeResult.clearedTombstoneIds) {
    if (clearedId in nextTombstones) {
      delete nextTombstones[clearedId];
      indexUpdated = true;
    }
  }

  const skippedTombstoneIdSet = new Set(
    mergeResult.skippedTombstones.map((s) => s.cardId)
  );
  const discoveredActiveIds = new Set<string>();
  const indexEntries = { ...existingIndexEntries };

  for (const item of incomingItems) {
    if (skippedTombstoneIdSet.has(item.card.id)) continue;
    discoveredActiveIds.add(item.card.id);
    const fp =
      item.card.contentFingerprint || computeCardContentFingerprint(item.card);
    const existingEntry = indexEntries[item.card.id];
    if (
      !existingEntry ||
      existingEntry.contentFingerprint !== fp ||
      existingEntry.relativePath !== (item.relativeFolderPath ?? '')
    ) {
      indexEntries[item.card.id] = {
        cardId: item.card.id,
        relativePath:
          item.relativeFolderPath ?? buildCardFolderPathSegments(item.card).join('/'),
        contentFingerprint: fp,
        imageContentHash: item.card.imageContentHash,
        imageByteSize: item.card.imageByteSize,
        imageFileName: item.card.imageName || undefined,
        updatedAt: item.card.updatedAt,
        syncedAt: Date.now(),
      };
      indexUpdated = true;
    }
  }

  // 清理磁盘上已实际不存在的过期索引条目，防止幽灵记录残留
  for (const indexedId of Object.keys(indexEntries)) {
    if (!discoveredActiveIds.has(indexedId)) {
      delete indexEntries[indexedId];
      indexUpdated = true;
    }
  }

  if (indexUpdated) {
    await writeFolderSyncIndex(rootHandle, indexEntries, nextTombstones);
  }

  return {
    ...mergeResult,
    scannedFilesCount,
    discoveredCardsCount: incomingItems.length,
    indexEntries,
    tombstones: nextTombstones,
  };
}

export async function loadFolderSyncIndexSnapshot(
  rootHandle: FileSystemDirectoryHandle
): Promise<Record<string, FolderSyncIndexEntry>> {
  const { entries } = await readFolderSyncIndex(rootHandle);
  return entries;
}

export async function loadFolderSyncStateSnapshot(
  rootHandle: FileSystemDirectoryHandle
): Promise<{
  entries: Record<string, FolderSyncIndexEntry>;
  deletedTombstones: Record<string, DeletedCardTombstone>;
}> {
  const { entries, deletedTombstones } = await readFolderSyncIndex(rootHandle);
  return { entries, deletedTombstones };
}


