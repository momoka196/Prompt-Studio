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

export interface ExtractedPngComfyMetadata {
  isPng: boolean;
  workflowJson?: string;
  apiPromptJson?: string;
  chibipromptMeta?: {
    character?: string;
    positive?: string;
    negative?: string;
  };
  rawChunks: Record<string, string>;
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

  let workflowJson: string | undefined;
  let apiPromptJson: string | undefined;
  let chibipromptMeta: ExtractedPngComfyMetadata['chibipromptMeta'];

  if (rawChunks.workflow) {
    try {
      JSON.parse(rawChunks.workflow);
      workflowJson = rawChunks.workflow;
    } catch {
      // ignore invalid JSON
    }
  }
  if (rawChunks.prompt) {
    try {
      JSON.parse(rawChunks.prompt);
      apiPromptJson = rawChunks.prompt;
    } catch {
      // ignore invalid JSON
    }
  }
  if (rawChunks.chibiprompt) {
    try {
      const parsed = JSON.parse(rawChunks.chibiprompt) as Record<string, unknown>;
      chibipromptMeta = {
        character: typeof parsed.character === 'string' ? parsed.character : undefined,
        positive: typeof parsed.positive === 'string' ? parsed.positive : undefined,
        negative: typeof parsed.negative === 'string' ? parsed.negative : undefined,
      };
    } catch {
      // ignore invalid JSON
    }
  }

  return {
    isPng: true,
    workflowJson,
    apiPromptJson,
    chibipromptMeta,
    rawChunks,
  };
}

export async function extractComfyMetadataFromPngFile(
  file: File
): Promise<ExtractedPngComfyMetadata> {
  const buf = await file.arrayBuffer();
  return extractComfyMetadataFromPngBuffer(buf);
}

export async function resizeImageToThumbnail(
  file: File,
  maxDimension = 520
): Promise<string> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('无法解码图片文件'));
      el.src = objectUrl;
    });

    const srcW = img.naturalWidth || img.width || 512;
    const srcH = img.naturalHeight || img.height || 512;

    const renderScaled = (limit: number, quality: number): string => {
      const scale = Math.min(1, limit / Math.max(srcW, srcH));
      const w = Math.max(1, Math.round(srcW * scale));
      const h = Math.max(1, Math.round(srcH * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return '';
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      const webp = canvas.toDataURL('image/webp', quality);
      if (webp.startsWith('data:image/webp')) {
        return webp;
      }
      return canvas.toDataURL('image/jpeg', quality);
    };

    let dataUrl = renderScaled(maxDimension, 0.78);
    if (dataUrl.length > 140_000) {
      dataUrl = renderScaled(380, 0.62);
    }
    return dataUrl;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
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
    if (!positiveNodeId && Array.isArray(node.inputs?.positive)) {
      const refId = String(node.inputs.positive[0]);
      const traced = traceCondNode(refId);
      if (traced) {
        positiveNodeId = traced.nodeId;
        extractedPositive = traced.text;
      }
    }
    if (!negativeNodeId && Array.isArray(node.inputs?.negative)) {
      const refId = String(node.inputs.negative[0]);
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
}): ParsedWorkflowSource {
  const { rawJsonText, apiPromptJsonText, chibipromptMeta } = params;

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
