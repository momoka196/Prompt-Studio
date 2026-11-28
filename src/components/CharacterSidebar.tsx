import React, { useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import {
  CharacterConfig,
  ComfyProfile,
  MinimalBackgroundPreset,
  SharedConfig,
  SimplePresetItem,
} from '../types/studio';
import { buildCharacterPrompt, getCharacterHairstyleOptions } from '../utils/promptBuilder';

interface CharacterSidebarProps {
  shared: SharedConfig;
  characters: CharacterConfig[];
  selectedCharId: string;
  includeAppearance: boolean;
  activeProfile?: ComfyProfile;
  customPresets?: SimplePresetItem[];
  customBackgrounds?: MinimalBackgroundPreset[];
  onSelectCharacter: (id: string) => void;
  onAddCharacter: () => void;
  onDeleteCharacter: (id: string) => void;
  onRenameCharacter: (id: string, newName: string) => void;
  onMoveCharacter: (id: string, direction: 'up' | 'down') => void;
}

function getCharacterSubtitle(char: CharacterConfig): string {
  const app = char.appearance.text.toLowerCase();
  if (char.id === 'char-lan' || (app.includes('black hair') && app.includes('low twintails'))) {
    return '黑发低双马尾';
  }
  if (char.id === 'char-yi' || (app.includes('blonde hair') && app.includes('side ponytail'))) {
    const activeHair =
      char.id === 'char-yi' ? getCharacterHairstyleOptions(char).activePreset.zhName : '侧马尾';
    return `金发${activeHair}六件套`;
  }
  if (char.id === 'char-mari' || (app.includes('orange hair') && app.includes('cat ears'))) {
    return '橘发低双马尾';
  }
  if (char.id === 'char-hoshino' || (app.includes('pink hair') && app.includes('heterochromia'))) {
    return '粉发异色瞳';
  }
  const outfitFirst = char.outfit.text.trim().split(',')[0]?.replace(/^\(|\)$/g, '').trim();
  if (outfitFirst) return outfitFirst;
  return char.appearance.text.trim() ? '自定义外貌' : 'LoRA 控制';
}

export function getCharacterAvatarColor(char: CharacterConfig): {
  bg: string;
  ring: string;
  label: string;
} {
  const app = char.appearance.text.toLowerCase();
  const name = char.name.toLowerCase();

  if (char.id === 'char-lan' || app.includes('black hair') || name.includes('蓝')) {
    return { bg: '#283B6B', ring: 'rgba(40, 59, 107, 0.22)', label: '深海蓝' };
  }
  if (char.id === 'char-yi' || app.includes('blonde hair') || name.includes('伊')) {
    return { bg: '#F2C96B', ring: 'rgba(242, 201, 107, 0.35)', label: '奶油金' };
  }
  if (char.id === 'char-mari' || app.includes('orange hair') || name.includes('mari')) {
    return { bg: '#F28B50', ring: 'rgba(242, 139, 80, 0.28)', label: '暖橘' };
  }
  if (char.id === 'char-hoshino' || app.includes('pink hair') || name.includes('hoshino')) {
    return { bg: '#F48FB1', ring: 'rgba(244, 143, 177, 0.32)', label: '樱花粉' };
  }
  if (app.includes('white hair') || app.includes('silver hair')) {
    return { bg: '#B8C0D0', ring: 'rgba(184, 192, 208, 0.3)', label: '银白' };
  }
  if (app.includes('purple hair') || app.includes('lavender hair')) {
    return { bg: '#8B74E8', ring: 'rgba(139, 116, 232, 0.28)', label: '薰衣草紫' };
  }
  return { bg: '#7C5CFC', ring: 'rgba(124, 92, 252, 0.24)', label: '丁香紫' };
}

export const CharacterSidebar: React.FC<CharacterSidebarProps> = ({
  shared,
  characters,
  selectedCharId,
  includeAppearance,
  activeProfile,
  customPresets = [],
  customBackgrounds = [],
  onSelectCharacter,
  onAddCharacter,
  onDeleteCharacter,
  onRenameCharacter,
  onMoveCharacter,
}) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCopyRow = async (e: React.MouseEvent, char: CharacterConfig) => {
    e.stopPropagation();
    const built = buildCharacterPrompt(shared, char, {
      includeAppearance,
      customPresets,
      customBackgrounds,
      activeProfile,
    });
    try {
      await navigator.clipboard.writeText(built.fullText);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = built.fullText;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopiedId(char.id);
    window.setTimeout(() => {
      setCopiedId((prev) => (prev === char.id ? null : prev));
    }, 1500);
  };

  const commitRename = (id: string) => {
    const trimmed = draftName.trim();
    if (trimmed) onRenameCharacter(id, trimmed);
    setEditingId(null);
  };

  return (
    <aside className="w-full lg:w-[248px] shrink-0 lg:h-full rounded-[14px] studio-card flex flex-col overflow-hidden">
      <div className="px-4 py-3 flex items-center justify-between border-b border-[#EAEAEF] shrink-0">
        <span className="text-[12.5px] font-semibold text-[#1E2028]">角色列表</span>
        <span className="text-[11px] text-[#8E94A4] tabular-nums px-2 py-0.5 rounded-[6px] bg-[#F2F3F7]">
          {characters.length} 人
        </span>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {characters.map((char, idx) => {
          const isSelected = char.id === selectedCharId;
          const isEditing = editingId === char.id;
          const isMenuOpen = menuOpenId === char.id;
          const isCopied = copiedId === char.id;
          const subtitle = getCharacterSubtitle(char);
          const avatar = getCharacterAvatarColor(char);

          return (
            <div key={char.id} className="relative group">
              {isEditing ? (
                <div className="h-[40px] px-2.5 rounded-[10px] border border-[#7C5CFC]/60 bg-[#FAFAFC] flex items-center gap-1.5">
                  <input
                    type="text"
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename(char.id);
                      if (e.key === 'Escape') setEditingId(null);
                    }}
                    className="flex-1 min-w-0 bg-transparent text-[13px] font-medium text-[#1E2028] focus:outline-none"
                    autoFocus
                  />
                  <button
                    type="button"
                    onClick={() => commitRename(char.id)}
                    className="p-1 text-emerald-600 hover:bg-emerald-50 rounded-[8px] cursor-pointer"
                    aria-label="确认重命名"
                  >
                    <Check className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingId(null)}
                    className="p-1 text-[#949AA8] hover:text-[#1E2028] rounded-[8px] cursor-pointer"
                    aria-label="取消重命名"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ) : (
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    onSelectCharacter(char.id);
                    setMenuOpenId(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelectCharacter(char.id);
                    }
                  }}
                  className={`relative rounded-[10px] flex items-center justify-between gap-2 cursor-pointer select-none transition-all duration-150 ${
                    isSelected
                      ? 'min-h-[52px] pl-4 pr-2.5 py-2 bg-[#F3F0FF] shadow-[inset_0_0_0_1px_rgba(124,92,252,0.18)]'
                      : 'h-[40px] px-3 hover:bg-[#F7F7FA]'
                  }`}
                >
                  {/* 选中角色的柔和左侧细指示条 */}
                  {isSelected && (
                    <span
                      aria-hidden="true"
                      className="absolute left-1.5 top-2.5 bottom-2.5 w-[3px] rounded-full bg-[#7C5CFC]"
                    />
                  )}

                  <div className="flex items-center gap-2.5 min-w-0 flex-1">
                    <span
                      aria-hidden="true"
                      title={avatar.label}
                      style={{
                        backgroundColor: avatar.bg,
                        boxShadow: isSelected
                          ? `0 0 0 3px ${avatar.ring}`
                          : `0 0 0 1px rgba(0,0,0,0.06)`,
                      }}
                      className="w-2.5 h-2.5 rounded-full shrink-0 transition-shadow duration-150"
                    />
                    <div className="min-w-0 flex-1">
                      <div
                        className={`text-[13px] leading-tight truncate ${
                          isSelected
                            ? 'font-semibold text-[#1E2028]'
                            : 'font-medium text-[#4C5264] group-hover:text-[#1E2028]'
                        }`}
                      >
                        {char.name}
                      </div>
                      {/* 仅选中行展示副标题，未选中行保持清爽单行 */}
                      {isSelected && (
                        <div className="text-[11px] text-[#7C5CFC]/80 truncate mt-0.5 leading-tight">
                          {subtitle}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* 悬停或复制成功时显示操作按钮 */}
                  <div
                    className={`flex items-center gap-0.5 shrink-0 transition-opacity duration-150 ${
                      isMenuOpen || isCopied
                        ? 'opacity-100'
                        : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'
                    }`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      type="button"
                      onClick={(e) => handleCopyRow(e, char)}
                      title="复制此角色正向提示词"
                      className="p-1.5 rounded-[8px] text-[#8E94A4] hover:text-[#7C5CFC] hover:bg-white cursor-pointer transition-colors"
                    >
                      {isCopied ? (
                        <Check className="w-3.5 h-3.5 text-emerald-600" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenuOpenId((prev) => (prev === char.id ? null : char.id));
                      }}
                      title="更多操作"
                      className="p-1.5 rounded-[8px] text-[#8E94A4] hover:text-[#1E2028] hover:bg-white cursor-pointer transition-colors"
                    >
                      <MoreHorizontal className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )}

              {isMenuOpen && !isEditing && (
                <div
                  className="absolute right-2 top-[44px] z-30 w-32 rounded-[10px] border border-[#E0E0E6] bg-white shadow-[0_8px_24px_rgba(18,22,33,0.12)] py-1 text-[12px]"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    disabled={idx === 0}
                    onClick={() => {
                      onMoveCharacter(char.id, 'up');
                      setMenuOpenId(null);
                    }}
                    className="w-full px-3 py-1.5 flex items-center gap-2 text-left text-[#373C4B] hover:bg-[#F5F5F9] disabled:opacity-35 cursor-pointer"
                  >
                    <ArrowUp className="w-3.5 h-3.5 text-[#8E94A4]" />
                    <span>上移</span>
                  </button>
                  <button
                    type="button"
                    disabled={idx === characters.length - 1}
                    onClick={() => {
                      onMoveCharacter(char.id, 'down');
                      setMenuOpenId(null);
                    }}
                    className="w-full px-3 py-1.5 flex items-center gap-2 text-left text-[#373C4B] hover:bg-[#F5F5F9] disabled:opacity-35 cursor-pointer"
                  >
                    <ArrowDown className="w-3.5 h-3.5 text-[#8E94A4]" />
                    <span>下移</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingId(char.id);
                      setDraftName(char.name);
                      setMenuOpenId(null);
                    }}
                    className="w-full px-3 py-1.5 flex items-center gap-2 text-left text-[#373C4B] hover:bg-[#F5F5F9] cursor-pointer"
                  >
                    <Pencil className="w-3.5 h-3.5 text-[#8E94A4]" />
                    <span>重命名</span>
                  </button>
                  <button
                    type="button"
                    disabled={characters.length <= 1}
                    onClick={() => {
                      onDeleteCharacter(char.id);
                      setMenuOpenId(null);
                    }}
                    className="w-full px-3 py-1.5 flex items-center gap-2 text-left text-[#E85D75] hover:bg-[#FFF1F3] disabled:opacity-35 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>删除</span>
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="p-2.5 border-t border-[#EAEAEF] bg-[#FAFAFC] shrink-0">
        <button
          type="button"
          onClick={onAddCharacter}
          className="h-9 w-full inline-flex items-center justify-center gap-1.5 rounded-[10px] border border-dashed border-[#D6D8E2] bg-white text-[12px] font-medium text-[#5A6072] hover:border-[#7C5CFC]/50 hover:text-[#7C5CFC] hover:bg-[#7C5CFC]/[0.04] transition-all cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>新增角色</span>
        </button>
      </div>
    </aside>
  );
};
