import {
  MinimalBackgroundPreset,
  PresetCategory,
  SimplePresetItem,
} from '../types/studio';

function makeId(prefix: string, idx: number): string {
  return `${prefix}-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 6)}`;
}

function normalizeCategory(raw: unknown, fallback: PresetCategory): PresetCategory {
  if (raw === 'outfit' || raw === 'pose' || raw === 'expression' || raw === 'hairstyle') {
    return raw;
  }
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (s.includes('hair') || s.includes('发')) return 'hairstyle';
  if (s.includes('outfit') || s.includes('服') || s.includes('衣')) return 'outfit';
  if (s.includes('pose') || s.includes('动')) return 'pose';
  if (s.includes('expr') || s.includes('表')) return 'expression';
  return fallback;
}

function clampImportWeight(val: unknown, fallback = 1.4): number {
  const num = typeof val === 'number' ? val : parseFloat(String(val));
  if (!Number.isFinite(num)) return fallback;
  return Math.min(2.0, Math.max(0.5, Math.round(num * 100) / 100));
}

function extractStringsFromComfyWorkflow(parsed: Record<string, unknown>): {
  title: string;
  text: string;
}[] {
  const nodes = parsed.nodes;
  if (!Array.isArray(nodes)) return [];
  const results: { title: string; text: string }[] = [];

  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    const n = node as Record<string, unknown>;
    const type = String(n.type || '');
    if (type !== 'PrimitiveStringMultiline' && type !== 'CLIPTextEncode') continue;
    const title = String(n.title || type);
    const widgetsValues = Array.isArray(n.widgets_values) ? n.widgets_values : [];
    const textVal =
      typeof widgetsValues[0] === 'string' ? widgetsValues[0].trim() : '';
    if (!textVal) continue;
    // Skip negative blocks if clearly labeled negative
    if (title.includes('负向')) continue;
    results.push({ title, text: textVal });
  }
  return results;
}

export function parseBackgroundPresetsImport(rawText: string): {
  items: MinimalBackgroundPreset[];
  error?: string;
} {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return { items: [], error: '请先输入或上传预设内容' };
  }

  // 1. Try JSON parsing
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;

      // ComfyUI workflow JSON
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        if (Array.isArray(obj.nodes)) {
          const extracted = extractStringsFromComfyWorkflow(obj);
          if (extracted.length > 0) {
            return {
              items: extracted.map((entry, idx) => ({
                id: makeId('custom-bg', idx),
                zhName: entry.title.slice(0, 32),
                note: '从 ComfyUI 工作流节点导入',
                tags: entry.text,
                isCustom: true,
              })),
            };
          }
        }
      }

      const rawArray: unknown[] = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object'
        ? ((parsed as Record<string, unknown>).backgrounds as unknown[]) ??
          ((parsed as Record<string, unknown>).customBackgrounds as unknown[]) ??
          ((parsed as Record<string, unknown>).items as unknown[]) ??
          [parsed]
        : [];

      const items: MinimalBackgroundPreset[] = [];
      rawArray.forEach((entry, idx) => {
        if (typeof entry === 'string' && entry.trim()) {
          items.push({
            id: makeId('custom-bg', idx),
            zhName: `导入背景 #${idx + 1}`,
            note: '自定义导入',
            tags: entry.trim(),
            isCustom: true,
          });
          return;
        }
        if (entry && typeof entry === 'object') {
          const rec = entry as Record<string, unknown>;
          const tags = String(rec.tags ?? rec.prompt ?? rec.text ?? '').trim();
          if (!tags) return;
          const zhName = String(rec.zhName ?? rec.name ?? rec.title ?? `导入背景 #${idx + 1}`).trim();
          const note = String(rec.note ?? rec.description ?? '自定义导入').trim();
          items.push({
            id: makeId('custom-bg', idx),
            zhName,
            note,
            tags,
            isCustom: true,
          });
        }
      });

      if (items.length === 0) {
        return { items: [], error: 'JSON 中未找到有效的背景提示词（需包含 tags 或 prompt 字段）' };
      }
      return { items };
    } catch {
      return { items: [], error: 'JSON 格式解析失败，请检查括号与引号是否完整' };
    }
  }

  // 2. Plain text line-by-line: "名称 | 英文提示词" or direct prompt line
  const lines = trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#') && !l.startsWith('//'));

  const items: MinimalBackgroundPreset[] = [];
  lines.forEach((line, idx) => {
    const sepMatch = line.match(/^([^|\t]+)[|\t](.+)$/);
    if (sepMatch) {
      const zhName = sepMatch[1].trim();
      const tags = sepMatch[2].trim();
      if (tags) {
        items.push({
          id: makeId('custom-bg', idx),
          zhName: zhName || `导入背景 #${idx + 1}`,
          note: '文本导入',
          tags,
          isCustom: true,
        });
      }
    } else {
      items.push({
        id: makeId('custom-bg', idx),
        zhName: `自定义背景 #${idx + 1}`,
        note: '文本导入',
        tags: line,
        isCustom: true,
      });
    }
  });

  if (items.length === 0) {
    return { items: [], error: '未识别到有效的背景提示词行' };
  }
  return { items };
}

export function parseCutePresetsImport(
  rawText: string,
  defaultCategory: PresetCategory
): {
  items: SimplePresetItem[];
  error?: string;
} {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return { items: [], error: '请先输入或上传预设内容' };
  }

  // 1. Try JSON parsing
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;

      // ComfyUI workflow JSON
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        if (Array.isArray(obj.nodes)) {
          const extracted = extractStringsFromComfyWorkflow(obj);
          if (extracted.length > 0) {
            return {
              items: extracted.map((entry, idx) => ({
                id: makeId('custom-preset', idx),
                category: defaultCategory,
                zhName: entry.title.slice(0, 32),
                vibe: '工作流导入',
                tags: entry.text,
                defaultWeight: 1.0,
                isCustom: true,
              })),
            };
          }
        }
      }

      const items: SimplePresetItem[] = [];
      const pushEntry = (
        entry: unknown,
        idx: number,
        catFallback: PresetCategory
      ) => {
        if (typeof entry === 'string' && entry.trim()) {
          items.push({
            id: makeId('custom-preset', idx),
            category: catFallback,
            zhName: `导入预设 #${idx + 1}`,
            vibe: '自定义导入',
            tags: entry.trim(),
            defaultWeight: 1.4,
            isCustom: true,
          });
          return;
        }
        if (entry && typeof entry === 'object') {
          const rec = entry as Record<string, unknown>;
          const tags = String(rec.tags ?? rec.prompt ?? rec.text ?? '').trim();
          if (!tags) return;
          const category = normalizeCategory(rec.category ?? rec.type, catFallback);
          const zhName = String(rec.zhName ?? rec.name ?? rec.title ?? `导入预设 #${idx + 1}`).trim();
          const vibe = String(rec.vibe ?? rec.note ?? '自定义导入').trim();
          const defaultWeight = clampImportWeight(rec.defaultWeight ?? rec.weight, 1.4);
          items.push({
            id: makeId('custom-preset', idx),
            category,
            zhName,
            vibe,
            tags,
            defaultWeight,
            isCustom: true,
          });
        }
      };

      if (Array.isArray(parsed)) {
        parsed.forEach((e, i) => pushEntry(e, i, defaultCategory));
      } else if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>;
        const groupedKeys: { key: string; cat: PresetCategory }[] = [
          { key: 'outfit', cat: 'outfit' },
          { key: 'outfits', cat: 'outfit' },
          { key: 'OUTFIT_PRESETS', cat: 'outfit' },
          { key: 'pose', cat: 'pose' },
          { key: 'poses', cat: 'pose' },
          { key: 'POSE_PRESETS', cat: 'pose' },
          { key: 'expression', cat: 'expression' },
          { key: 'expressions', cat: 'expression' },
          { key: 'EXPRESSION_PRESETS', cat: 'expression' },
          { key: 'hairstyle', cat: 'hairstyle' },
          { key: 'hairstyles', cat: 'hairstyle' },
          { key: 'HAIRSTYLE_PRESETS', cat: 'hairstyle' },
        ];
        let matchedGrouped = false;
        for (const g of groupedKeys) {
          if (Array.isArray(obj[g.key])) {
            matchedGrouped = true;
            (obj[g.key] as unknown[]).forEach((e, i) => pushEntry(e, i, g.cat));
          }
        }
        if (!matchedGrouped) {
          const list =
            (obj.presets as unknown[]) ??
            (obj.customPresets as unknown[]) ??
            (obj.items as unknown[]) ??
            [obj];
          list.forEach((e, i) => pushEntry(e, i, defaultCategory));
        }
      }

      if (items.length === 0) {
        return { items: [], error: 'JSON 中未找到有效预设（需包含 tags 或 prompt 字段）' };
      }
      return { items };
    } catch {
      return { items: [], error: 'JSON 格式解析失败，请检查括号与引号是否完整' };
    }
  }

  // 2. Plain text line-by-line:
  // Supports "名称 | 英文标签" OR "名称 | 权重 | 英文标签" OR direct English tags
  const lines = trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#') && !l.startsWith('//'));

  const items: SimplePresetItem[] = [];
  lines.forEach((line, idx) => {
    const parts = line.split(/[|\t]/).map((p) => p.trim());
    if (parts.length >= 3 && /^[0-9.]+$/.test(parts[1])) {
      const tags = parts.slice(2).join(' | ').trim();
      if (tags) {
        items.push({
          id: makeId('custom-preset', idx),
          category: defaultCategory,
          zhName: parts[0] || `导入预设 #${idx + 1}`,
          vibe: '文本导入',
          tags,
          defaultWeight: clampImportWeight(parts[1], 1.4),
          isCustom: true,
        });
      }
    } else if (parts.length >= 2) {
      const tags = parts.slice(1).join(' | ').trim();
      if (tags) {
        items.push({
          id: makeId('custom-preset', idx),
          category: defaultCategory,
          zhName: parts[0] || `导入预设 #${idx + 1}`,
          vibe: '文本导入',
          tags,
          defaultWeight: 1.4,
          isCustom: true,
        });
      }
    } else {
      items.push({
        id: makeId('custom-preset', idx),
        category: defaultCategory,
        zhName: `自定义预设 #${idx + 1}`,
        vibe: '文本导入',
        tags: line,
        defaultWeight: 1.4,
        isCustom: true,
      });
    }
  });

  if (items.length === 0) {
    return { items: [], error: '未识别到有效的预设行' };
  }
  return { items };
}
