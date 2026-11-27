import React from 'react';
import { ChevronRight } from 'lucide-react';
import { clampWeight, formatWeightNumber, getPromptStats } from '../utils/promptBuilder';

interface CompactSlotRowProps {
  label: string;
  text: string;
  weight?: number;
  expanded: boolean;
  onToggleExpand: () => void;
  onTextChange: (text: string) => void;
  onWeightChange?: (weight: number) => void;
  placeholder?: string;
  hideWeight?: boolean;
  emptyHint?: string;
  belowRowContent?: React.ReactNode;
  extraExpandedContent?: React.ReactNode;
}

function getCompletePreviewTags(text: string, maxTags = 3): { tags: string[]; remaining: number } {
  const trimmed = text.trim();
  if (!trimmed) return { tags: [], remaining: 0 };
  const all = trimmed
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // 优先完整展示前几个核心 tag，避免胶囊半截被截断
  const picked: string[] = [];
  let budget = 58;
  for (const tag of all) {
    if (picked.length >= maxTags) break;
    if (picked.length > 0 && tag.length > budget) break;
    picked.push(tag);
    budget -= tag.length + 2;
  }
  return {
    tags: picked,
    remaining: Math.max(0, all.length - picked.length),
  };
}

export const CompactSlotRow: React.FC<CompactSlotRowProps> = ({
  label,
  text,
  weight = 1.0,
  expanded,
  onToggleExpand,
  onTextChange,
  onWeightChange,
  placeholder,
  hideWeight = false,
  emptyHint,
  belowRowContent,
  extraExpandedContent,
}) => {
  const stats = getPromptStats(text, 6);
  const { tags: previewTags, remaining } = getCompletePreviewTags(text, 3);
  const clamped = clampWeight(weight);
  const isWeighted = Math.abs(clamped - 1.0) >= 0.01;

  return (
    <div className="group transition-colors duration-150">
      {/* 44px 呼吸感行高，左右充足留白，右侧权重区整齐对齐 */}
      <div
        role="button"
        tabIndex={0}
        onClick={onToggleExpand}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggleExpand();
          }
        }}
        aria-expanded={expanded}
        className={`min-h-[44px] px-5 py-2 flex items-center gap-4 cursor-pointer select-none transition-colors duration-150 ${
          expanded ? 'bg-[#F3F0FF]/55' : 'hover:bg-[#FAFAFC]'
        }`}
      >
        <div className="flex items-center gap-2.5 w-[104px] shrink-0">
          <span className="text-[12.5px] font-semibold text-[#1E2028] whitespace-nowrap">
            {label}
          </span>
          <span className="text-[11px] text-[#949AA8] tabular-nums whitespace-nowrap">
            {stats.tagCount} 词
          </span>
        </div>

        {/* 完整展示前几个核心 tag 微胶囊，避免硬截断 */}
        <div className="flex-1 min-w-0 flex items-center gap-1.5 overflow-hidden">
          {previewTags.length > 0 ? (
            <>
              {previewTags.map((tag, idx) => (
                <span
                  key={`${tag}-${idx}`}
                  title={tag}
                  className="inline-flex items-center px-2.5 py-0.5 rounded-[6px] bg-[#F2F3F7] text-[#4C5264] text-[11px] leading-tight whitespace-nowrap shrink-0"
                >
                  {tag}
                </span>
              ))}
              {remaining > 0 && (
                <span className="text-[11px] text-[#949AA8] tabular-nums whitespace-nowrap shrink-0 pl-0.5">
                  +{remaining} 项
                </span>
              )}
            </>
          ) : (
            <span className="text-[12px] text-[#A0A6B4] truncate">
              {emptyHint || '暂无内容，点击展开编辑'}
            </span>
          )}
        </div>

        {/* 右侧权重滑块 + 徽章 + 展开箭头整齐对齐 */}
        <div className="flex items-center gap-3 shrink-0 ml-auto">
          {!hideWeight && onWeightChange && (
            <div
              className="flex items-center gap-2.5"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <input
                type="range"
                min={0.5}
                max={2.0}
                step={0.1}
                value={clamped}
                onChange={(e) => onWeightChange(clampWeight(parseFloat(e.target.value)))}
                aria-label={`${label} 权重滑块`}
                className="weight-slider w-16 hidden sm:block"
              />
              <button
                type="button"
                onClick={() => onWeightChange(isWeighted ? 1.0 : 1.4)}
                title="点击切换 1.0（裸标签）与 1.4 推荐权重"
                className={`inline-flex items-center justify-center w-[48px] py-0.5 rounded-full text-[11px] font-medium tabular-nums transition-colors cursor-pointer ${
                  isWeighted
                    ? 'bg-[#7C5CFC]/12 text-[#6B48F5]'
                    : 'bg-[#F2F3F7] text-[#686E7E] hover:bg-[#E8E9F0]'
                }`}
              >
                ×{formatWeightNumber(clamped)}
              </button>
            </div>
          )}

          <ChevronRight
            className={`w-4 h-4 text-[#949AA8] shrink-0 transition-transform duration-150 ${
              expanded ? 'rotate-90 text-[#7C5CFC]' : 'group-hover:text-[#4C5264]'
            }`}
          />
        </div>
      </div>

      {belowRowContent}

      {/* 展开编辑区 */}
      {expanded && (
        <div className="px-5 pb-4 pt-3 bg-[#FAFAFC] border-t border-[#EAEAEF] space-y-2.5 transition-all duration-150">
          <textarea
            value={text}
            onChange={(e) => onTextChange(e.target.value)}
            rows={3}
            spellCheck={false}
            placeholder={placeholder}
            className="w-full max-h-[200px] min-h-[76px] overflow-y-auto rounded-[10px] border border-[#E0E0E6] bg-white px-3.5 py-2.5 text-[12px] font-mono text-[#232630] leading-relaxed placeholder:text-[#A5AAB6] focus:border-[#7C5CFC] focus:ring-2 focus:ring-[#7C5CFC]/10 focus:outline-none resize-y"
          />

          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[#686E7E]">
            {!hideWeight && onWeightChange ? (
              <div className="flex items-center gap-2">
                <span>精确权重</span>
                <input
                  type="number"
                  min={0.5}
                  max={2.0}
                  step={0.05}
                  value={clamped}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    onWeightChange(Number.isNaN(v) ? 1.0 : clampWeight(v));
                  }}
                  aria-label={`${label} 权重数值`}
                  className="w-16 rounded-[8px] border border-[#E0E0E6] bg-white px-2 py-0.5 text-[11px] font-mono text-right text-[#1E2028] tabular-nums focus:border-[#7C5CFC] focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => onWeightChange(1.0)}
                  className="px-2.5 py-0.5 rounded-[8px] bg-white border border-[#E0E0E6] text-[#4C5264] hover:border-[#7C5CFC]/40 hover:text-[#7C5CFC] transition-colors cursor-pointer"
                >
                  1.0 裸标签
                </button>
                <button
                  type="button"
                  onClick={() => onWeightChange(1.4)}
                  className="px-2.5 py-0.5 rounded-[8px] bg-white border border-[#E0E0E6] text-[#4C5264] hover:border-[#7C5CFC]/40 hover:text-[#7C5CFC] transition-colors cursor-pointer"
                >
                  1.4 推荐
                </button>
              </div>
            ) : (
              <span>共 {stats.tagCount} 个标签 · {stats.charCount} 字符</span>
            )}

            {text.trim() && (
              <button
                type="button"
                onClick={() => onTextChange('')}
                className="text-[#949AA8] hover:text-[#E85D75] transition-colors cursor-pointer"
              >
                清空此项
              </button>
            )}
          </div>

          {extraExpandedContent}
        </div>
      )}
    </div>
  );
};
