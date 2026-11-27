import React, { useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronRight,
  Copy,
  Dices,
  FileCode2,
  Loader2,
  Lock,
  RefreshCw,
  Send,
  Settings,
  ShieldCheck,
  X,
} from 'lucide-react';
import { COMFY_ARCH_DEFAULTS, DEFAULT_COMFY_SEED } from '../data/presets';
import {
  CharacterConfig,
  ComfyProfile,
  ComfyValidationMap,
  MinimalBackgroundPreset,
  SharedConfig,
  SimplePresetItem,
} from '../types/studio';
import {
  buildCharacterPrompt,
  buildNegativePromptWithMeta,
  getActiveLoaderKeys,
  getPromptStats,
  postProfileToComfyUI,
  splitPromptTags,
} from '../utils/promptBuilder';
import { loadUiCache, patchUiCache } from '../utils/storageCache';

export interface ComfySubmissionStatus {
  state: 'idle' | 'sending' | 'success' | 'error';
  characterName?: string;
  promptId?: string;
  usedModelSummary?: string;
  usedSeed?: number;
  message?: string;
  timestamp?: string;
}

interface OutputSidebarProps {
  shared: SharedConfig;
  activeCharacter: CharacterConfig;
  includeAppearance: boolean;
  customPresets?: SimplePresetItem[];
  customBackgrounds?: MinimalBackgroundPreset[];
  onCopyWorkflowSnippet: () => void;
  copiedSnippet: boolean;
  comfyUrl: string;
  activeProfile: ComfyProfile;
  validation: ComfyValidationMap;
  probingLoaders: boolean;
  onProbeLoaders: () => void;
  onOpenSettings: () => void;
  onUpdateActiveProfile?: (updater: (prev: ComfyProfile) => ComfyProfile) => void;
}

function splitPillTags(text: string, max = 6): { pills: string[]; remaining: number } {
  const arr = splitPromptTags(text);
  return {
    pills: arr.slice(0, max),
    remaining: Math.max(0, arr.length - max),
  };
}

export const OutputSidebar: React.FC<OutputSidebarProps> = ({
  shared,
  activeCharacter,
  includeAppearance,
  customPresets = [],
  customBackgrounds = [],
  onCopyWorkflowSnippet,
  copiedSnippet,
  comfyUrl,
  activeProfile,
  validation,
  probingLoaders,
  onProbeLoaders,
  onOpenSettings,
  onUpdateActiveProfile,
}) => {
  const [posExpanded, setPosExpandedState] = useState<boolean>(
    () => loadUiCache().posExpanded
  );
  const [negExpanded, setNegExpandedState] = useState<boolean>(
    () => loadUiCache().negExpanded
  );

  const setPosExpanded = (updater: boolean | ((prev: boolean) => boolean)) => {
    setPosExpandedState((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      patchUiCache({ posExpanded: next });
      return next;
    });
  };

  const setNegExpanded = (updater: boolean | ((prev: boolean) => boolean)) => {
    setNegExpandedState((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      patchUiCache({ negExpanded: next });
      return next;
    });
  };
  const [copiedPos, setCopiedPos] = useState(false);
  const [copiedNeg, setCopiedNeg] = useState(false);
  const [comfyStatus, setComfyStatus] = useState<ComfySubmissionStatus>({ state: 'idle' });

  const builtPositive = buildCharacterPrompt(shared, activeCharacter, {
    includeAppearance,
    customPresets,
    customBackgrounds,
  });
  const negativeResult = buildNegativePromptWithMeta(shared, activeCharacter, {
    includeAppearance,
    customPresets,
    customBackgrounds,
  });
  const guardAnalysis = negativeResult.guardMeta;
  const sharedNegative = negativeResult.negativePrompt;

  const posStats = getPromptStats(builtPositive.fullText, 6);
  const negStats = getPromptStats(sharedNegative, 6);
  const posPills = splitPillTags(builtPositive.fullText, 6);
  const negPills = splitPillTags(sharedNegative, 6);

  const copyText = async (text: string) => {
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

  const handleCopyPositive = async () => {
    await copyText(builtPositive.fullText);
    setCopiedPos(true);
    window.setTimeout(() => setCopiedPos(false), 1600);
  };

  const handleCopyNegative = async () => {
    await copyText(sharedNegative);
    setCopiedNeg(true);
    window.setTimeout(() => setCopiedNeg(false), 1600);
  };

  const activeLoaderKeys = getActiveLoaderKeys(activeProfile);
  const invalidKeys = activeLoaderKeys.filter(
    (k) => validation[k]?.status === 'invalid'
  );
  const allLoadersGreen =
    activeLoaderKeys.length > 0 &&
    activeLoaderKeys.every((k) => validation[k]?.status === 'valid');

  const gateReason =
    activeLoaderKeys.length === 0
      ? '自定义架构未勾选任何加载节点'
      : invalidKeys.length > 0
      ? validation[invalidKeys[0]].message || '模型不存在'
      : probingLoaders ||
        activeLoaderKeys.some((k) => validation[k]?.status === 'checking')
      ? '正在校验模型列表...'
      : !allLoadersGreen
      ? activeLoaderKeys.some((k) => validation[k]?.status === 'error')
        ? '未连接 ComfyUI，点击「校验」确认模型可用后发送'
        : '模型尚未绿灯校验，请先点击「校验」'
      : null;

  const effectiveLoraCount = (activeProfile.loras ?? []).filter(
    (l) =>
      l.name.trim() &&
      (l.condition !== 'ibuki_only' || Boolean(activeCharacter.enableFourthLora))
  ).length;

  const handleSendToComfy = async () => {
    if (!allLoadersGreen) return;
    setComfyStatus({
      state: 'sending',
      characterName: activeCharacter.name,
      message: '正在推送工作流到 ComfyUI 队列...',
    });

    try {
      const res = await postProfileToComfyUI({
        comfyUrl,
        profile: activeProfile,
        characterName: activeCharacter.name,
        positivePrompt: builtPositive.fullText,
        negativePrompt: sharedNegative,
        enableFourthLora: Boolean(activeCharacter.enableFourthLora),
      });

      const now = new Date().toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      });

      setComfyStatus({
        state: 'success',
        characterName: activeCharacter.name,
        promptId: res.promptId,
        usedModelSummary: res.usedModelSummary,
        usedSeed: res.usedSeed,
        timestamp: now,
        message: '已进入本地 ComfyUI 生成队列',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : '提交失败';
      const isNetworkErr =
        /failed to fetch|networkerror|err_connection/i.test(msg);
      setComfyStatus({
        state: 'error',
        characterName: activeCharacter.name,
        message: isNetworkErr
          ? `${msg}（请确认已启动 ComfyUI 并开启 --enable-cors-header）`
          : msg,
      });
    }
  };

  return (
    <aside className="w-full lg:w-[368px] shrink-0 lg:h-full flex flex-col gap-3">
      {/* 上格：正向输出 */}
      <div className="rounded-[14px] studio-card overflow-hidden flex flex-col">
        <div className="px-4 py-3 flex items-center justify-between gap-2 border-b border-[#EAEAEF]">
          <div className="min-w-0 flex items-center gap-1.5">
            <span className="text-[12.5px] font-semibold text-[#1E2028] whitespace-nowrap">
              正向输出
            </span>
            <span className="text-[11.5px] text-[#8E94A4] truncate">
              · {activeCharacter.name}
              {includeAppearance ? ' · 含外貌' : ''}
            </span>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={onCopyWorkflowSnippet}
              title="复制纯正向+负向工作流片段（无角色名和编号）"
              className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded-[10px] border border-[#EAEAEF] bg-white text-[#5A6072] hover:border-[#7C5CFC]/40 hover:text-[#7C5CFC] transition-colors whitespace-nowrap cursor-pointer"
            >
              {copiedSnippet ? (
                <>
                  <Check className="w-3 h-3 text-emerald-600" />
                  <span className="text-emerald-600">已复制</span>
                </>
              ) : (
                <>
                  <FileCode2 className="w-3 h-3" />
                  <span>片段</span>
                </>
              )}
            </button>
            <button
              type="button"
              onClick={handleCopyPositive}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded-[10px] bg-[#F4F2FF] text-[#6B48F5] hover:bg-[#EBE6FF] transition-colors whitespace-nowrap cursor-pointer"
            >
              {copiedPos ? (
                <>
                  <Check className="w-3 h-3 text-emerald-600" />
                  <span className="text-emerald-600">已复制</span>
                </>
              ) : (
                <>
                  <Copy className="w-3 h-3" />
                  <span>复制</span>
                </>
              )}
            </button>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setPosExpanded((v) => !v)}
          className="w-full px-4 py-3 text-left hover:bg-[#FAFAFC] transition-colors duration-150 cursor-pointer space-y-2"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-[#8E94A4] tabular-nums">
              {posStats.tagCount} tags · {posStats.charCount} chars
            </span>
            <ChevronRight
              className={`w-4 h-4 text-[#949AA8] shrink-0 transition-transform duration-150 ${
                posExpanded ? 'rotate-90 text-[#7C5CFC]' : ''
              }`}
            />
          </div>

          <div className="flex flex-wrap items-center gap-1">
            {posPills.pills.length > 0 ? (
              <>
                {posPills.pills.map((tag, idx) => (
                  <span
                    key={`pos-${idx}`}
                    className="inline-flex items-center px-2 py-0.5 rounded-[6px] bg-[#F2F3F7] text-[#4C5264] text-[11px] leading-tight truncate max-w-[155px]"
                  >
                    {tag}
                  </span>
                ))}
                {posPills.remaining > 0 && (
                  <span className="text-[11px] text-[#949AA8] tabular-nums">
                    +{posPills.remaining}
                  </span>
                )}
              </>
            ) : (
              <span className="text-[11.5px] text-[#A0A6B4]">（暂无正向内容）</span>
            )}
          </div>
        </button>

        {posExpanded && (
          <div className="px-4 pb-3.5 pt-2.5 border-t border-[#EAEAEF] bg-[#FAFAFC] max-h-[200px] overflow-y-auto space-y-2.5 transition-all duration-150">
            <div className="space-y-1.5">
              {builtPositive.segments.map((seg) => (
                <div
                  key={seg.key}
                  className="flex items-start gap-2 text-[11px]"
                >
                  <span
                    className={`w-8 shrink-0 text-right font-medium pt-0.5 ${
                      seg.layer === 'shared' ? 'text-[#8E94A4]' : 'text-[#7C5CFC]'
                    }`}
                  >
                    {seg.label}
                  </span>
                  <span className="flex-1 px-2 py-1 rounded-[6px] bg-white border border-[#EAEAEF] text-[#373C4B] font-mono break-words leading-relaxed">
                    {seg.formatted}
                  </span>
                </div>
              ))}
            </div>
            <div className="pt-2 border-t border-[#EAEAEF] text-[11px] font-mono text-[#686E7E] break-words select-all leading-relaxed">
              {builtPositive.fullText || '（暂无正向内容）'}
            </div>
          </div>
        )}
      </div>

      {/* 自动防串/防同化轻量状态提示（位于共用负向输出上方） */}
      <div
        title={
          guardAnalysis.appendedTags.length > 0
            ? `已自动追加：${guardAnalysis.appendedTags.join(', ')}`
            : '当前规则词均已在基础负向中存在'
        }
        className="rounded-[12px] border border-[#E6E5F0] bg-[#FAF9FF] px-3 py-2 flex flex-wrap items-center justify-between gap-1.5"
      >
        <div className="flex flex-wrap items-center gap-1.5 min-w-0">
          <ShieldCheck className="w-3.5 h-3.5 text-[#7C5CFC] shrink-0" />
          {guardAnalysis.rules.map((rule) => (
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
        </div>
        {guardAnalysis.appendedTags.length > 0 && (
          <span className="text-[10.5px] text-[#8E94A4] tabular-nums whitespace-nowrap">
            +{guardAnalysis.appendedTags.length} 词
          </span>
        )}
      </div>

      {/* 下格：共用负向输出 */}
      <div className="rounded-[14px] studio-card overflow-hidden flex flex-col">
        <div className="px-4 py-3 flex items-center justify-between gap-2 border-b border-[#EAEAEF]">
          <div className="flex items-center gap-1.5">
            <span className="text-[12.5px] font-semibold text-[#1E2028]">
              共用负向输出
            </span>
            <span className="text-[11.5px] text-[#8E94A4]">· 含自动防同化</span>
          </div>

          <button
            type="button"
            onClick={handleCopyNegative}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded-[10px] bg-[#F4F2FF] text-[#6B48F5] hover:bg-[#EBE6FF] transition-colors whitespace-nowrap cursor-pointer"
          >
            {copiedNeg ? (
              <>
                <Check className="w-3 h-3 text-emerald-600" />
                <span className="text-emerald-600">已复制</span>
              </>
            ) : (
              <>
                <Copy className="w-3 h-3" />
                <span>复制</span>
              </>
            )}
          </button>
        </div>

        <button
          type="button"
          onClick={() => setNegExpanded((v) => !v)}
          className="w-full px-4 py-3 text-left hover:bg-[#FAFAFC] transition-colors duration-150 cursor-pointer space-y-2"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-[#8E94A4] tabular-nums">
              {negStats.tagCount} tags · {negStats.charCount} chars
            </span>
            <ChevronRight
              className={`w-4 h-4 text-[#949AA8] shrink-0 transition-transform duration-150 ${
                negExpanded ? 'rotate-90 text-[#7C5CFC]' : ''
              }`}
            />
          </div>

          <div className="flex flex-wrap items-center gap-1">
            {negPills.pills.length > 0 ? (
              <>
                {negPills.pills.map((tag, idx) => (
                  <span
                    key={`neg-${idx}`}
                    className="inline-flex items-center px-2 py-0.5 rounded-[6px] bg-[#F2F3F7] text-[#4C5264] text-[11px] leading-tight truncate max-w-[155px]"
                  >
                    {tag}
                  </span>
                ))}
                {negPills.remaining > 0 && (
                  <span className="text-[11px] text-[#949AA8] tabular-nums">
                    +{negPills.remaining}
                  </span>
                )}
              </>
            ) : (
              <span className="text-[11.5px] text-[#A0A6B4]">（当前未启用负向提示词）</span>
            )}
          </div>
        </button>

        {negExpanded && (
          <div className="px-4 pb-3.5 pt-2.5 border-t border-[#EAEAEF] bg-[#FAFAFC] max-h-[200px] overflow-y-auto transition-all duration-150">
            <p className="text-[11px] font-mono text-[#4C5264] break-words select-all leading-relaxed">
              {sharedNegative || '（当前未启用负向提示词）'}
            </p>
          </div>
        )}
      </div>

      {/* ComfyUI 推送控制台（贴底对齐，保持清晰焦点） */}
      <div className="mt-auto rounded-[14px] studio-card p-4 space-y-2.5">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleSendToComfy}
            disabled={
              comfyStatus.state === 'sending' ||
              !builtPositive.fullText ||
              !allLoadersGreen
            }
            title={gateReason || '发送当前工作流到 ComfyUI'}
            className="flex-1 h-9 inline-flex items-center justify-center gap-1.5 px-3.5 text-[12.5px] font-medium rounded-[10px] bg-gradient-to-b from-[#8A6CFF] to-[#7C5CFC] text-white shadow-[0_2px_10px_rgba(124,92,252,0.28)] hover:brightness-105 active:translate-y-px disabled:opacity-45 disabled:cursor-not-allowed transition-all whitespace-nowrap cursor-pointer"
          >
            {comfyStatus.state === 'sending' ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Send className="w-3.5 h-3.5" />
            )}
            <span className="truncate">
              {comfyStatus.state === 'sending'
                ? '正在提交...'
                : `发送到 ComfyUI · ${activeCharacter.name}`}
            </span>
          </button>

          <button
            type="button"
            onClick={onOpenSettings}
            title="设置 ComfyUI 地址、架构预设、模型与采样参数"
            className="h-9 px-3 inline-flex items-center gap-1 text-[12px] font-medium rounded-[10px] border border-[#EAEAEF] bg-[#FAFAFC] text-[#4C5264] hover:border-[#7C5CFC]/40 hover:text-[#7C5CFC] hover:bg-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Settings className="w-3.5 h-3.5" />
            <span>设置</span>
          </button>
        </div>

        {/* 模型校验门禁状态条 */}
        <div
          className={`flex items-center justify-between gap-2 rounded-[9px] px-2.5 py-1.5 text-[11px] border ${
            allLoadersGreen
              ? 'border-emerald-200/80 bg-emerald-50/60 text-emerald-700'
              : invalidKeys.length > 0
              ? 'border-[#F8C8D2] bg-[#FFF1F3] text-[#C93B58]'
              : 'border-[#EAEAEF] bg-[#FAFAFC] text-[#686E7E]'
          }`}
        >
          <div className="flex items-center gap-1.5 min-w-0">
            <span
              className={`w-2 h-2 rounded-full shrink-0 ${
                allLoadersGreen
                  ? 'bg-emerald-500'
                  : invalidKeys.length > 0
                  ? 'bg-[#E85D75]'
                  : probingLoaders
                  ? 'bg-amber-400 animate-pulse'
                  : 'bg-[#CBD0DC]'
              }`}
            />
            <span className="truncate font-medium">
              {allLoadersGreen
                ? `${COMFY_ARCH_DEFAULTS[activeProfile.architecture].label} 模型校验通过`
                : gateReason}
            </span>
          </div>

          <button
            type="button"
            onClick={onProbeLoaders}
            disabled={probingLoaders}
            className="inline-flex items-center gap-1 font-medium text-[#7C5CFC] hover:underline shrink-0 cursor-pointer disabled:opacity-40"
          >
            <RefreshCw className={`w-3 h-3 ${probingLoaders ? 'animate-spin' : ''}`} />
            <span>校验</span>
          </button>
        </div>

        <div className="flex items-center justify-between gap-2 text-[11px] text-[#8E94A4] tabular-nums">
          <span className="truncate font-mono">
            {activeProfile.sampling.width}×{activeProfile.sampling.height} ·{' '}
            {activeProfile.sampling.steps} steps · CFG {activeProfile.sampling.cfg} ·{' '}
            {activeProfile.sampling.sampler}
          </span>
          <span className="shrink-0 font-medium text-[#6B48F5]">
            {effectiveLoraCount}层 LoRA
          </span>
        </div>

        {/* Seed 固定/随机控制条 */}
        {onUpdateActiveProfile && (
          <div className="flex items-center justify-between gap-1.5 rounded-[9px] border border-[#EAEAEF] bg-[#FAFAFC] px-2.5 py-1.5 text-[11px]">
            <button
              type="button"
              onClick={() =>
                onUpdateActiveProfile((prev) => ({
                  ...prev,
                  sampling: {
                    ...prev.sampling,
                    seedMode:
                      (prev.sampling.seedMode ?? 'fixed') === 'fixed'
                        ? 'random'
                        : 'fixed',
                    seed: prev.sampling.seed ?? DEFAULT_COMFY_SEED,
                  },
                }))
              }
              title="切换固定 Seed（出图一致）或每次随机 Seed"
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-[6px] font-medium border transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                (activeProfile.sampling.seedMode ?? 'fixed') === 'fixed'
                  ? 'border-[#DDD8FA] bg-[#F4F2FF] text-[#6B48F5]'
                  : 'border-[#E0E0E6] bg-white text-[#686E7E]'
              }`}
            >
              {(activeProfile.sampling.seedMode ?? 'fixed') === 'fixed' ? (
                <>
                  <Lock className="w-3 h-3" />
                  <span>固定 Seed</span>
                </>
              ) : (
                <>
                  <Dices className="w-3 h-3" />
                  <span>每次随机</span>
                </>
              )}
            </button>

            {(activeProfile.sampling.seedMode ?? 'fixed') === 'fixed' ? (
              <div className="flex items-center gap-1 min-w-0 flex-1 justify-end">
                <input
                  type="number"
                  min={0}
                  aria-label="固定 Seed 数值"
                  value={activeProfile.sampling.seed ?? DEFAULT_COMFY_SEED}
                  onChange={(e) => {
                    const parsed = parseInt(e.target.value, 10);
                    const nextSeed =
                      Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
                    onUpdateActiveProfile((prev) => ({
                      ...prev,
                      sampling: {
                        ...prev.sampling,
                        seedMode: 'fixed',
                        seed: nextSeed,
                      },
                    }));
                  }}
                  className="w-full max-w-[140px] h-6 px-2 rounded-[6px] border border-[#E0E0E6] bg-white text-[11px] font-mono tabular-nums text-[#1E2028] text-right focus:outline-none focus:border-[#7C5CFC]"
                />
                <button
                  type="button"
                  title="随机换一个固定 Seed"
                  aria-label="随机换一个固定 Seed"
                  onClick={() =>
                    onUpdateActiveProfile((prev) => ({
                      ...prev,
                      sampling: {
                        ...prev.sampling,
                        seedMode: 'fixed',
                        seed: Math.floor(Math.random() * 2147483647),
                      },
                    }))
                  }
                  className="h-6 px-1.5 inline-flex items-center justify-center rounded-[6px] border border-[#E0E0E6] bg-white text-[#686E7E] hover:border-[#7C5CFC]/50 hover:text-[#6B48F5] cursor-pointer shrink-0"
                >
                  <Dices className="w-3 h-3" />
                </button>
              </div>
            ) : (
              <span className="text-[10.5px] text-[#8E94A4] truncate">
                发送时自动随机
              </span>
            )}
          </div>
        )}

        {comfyStatus.state !== 'idle' && (
          <div
            role="status"
            className={`rounded-[10px] border p-3 transition-all duration-150 ${
              comfyStatus.state === 'success'
                ? 'bg-emerald-50/90 border-emerald-200'
                : comfyStatus.state === 'error'
                ? 'bg-[#FFF1F3] border-[#F8C8D2]'
                : 'bg-[#F4F2FF] border-[#DDD6FE]'
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-start gap-2 min-w-0">
                {comfyStatus.state === 'success' && (
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                )}
                {comfyStatus.state === 'error' && (
                  <AlertCircle className="w-4 h-4 text-[#E85D75] shrink-0 mt-0.5" />
                )}
                {comfyStatus.state === 'sending' && (
                  <Loader2 className="w-4 h-4 text-[#7C5CFC] animate-spin shrink-0 mt-0.5" />
                )}

                <div className="min-w-0 space-y-0.5">
                  <div
                    className={`text-[12px] font-semibold leading-snug ${
                      comfyStatus.state === 'success'
                        ? 'text-emerald-800'
                        : comfyStatus.state === 'error'
                        ? 'text-[#B42343]'
                        : 'text-[#5B3DF5]'
                    }`}
                  >
                    {comfyStatus.state === 'success'
                      ? `已提交队列 · ${comfyStatus.characterName}`
                      : comfyStatus.state === 'error'
                      ? `提交失败 · ${comfyStatus.characterName}`
                      : `提交中 · ${comfyStatus.characterName}`}
                  </div>

                  {comfyStatus.state === 'success' ? (
                    <div className="text-[11px] font-mono text-emerald-700 space-y-0.5">
                      <div>
                        任务 ID:{' '}
                        <span className="font-semibold text-emerald-950">
                          {comfyStatus.promptId?.slice(0, 8)}
                        </span>{' '}
                        <span className="text-emerald-600">({comfyStatus.timestamp})</span>
                      </div>
                      <div className="truncate text-emerald-700">
                        模型: {comfyStatus.usedModelSummary}
                        {comfyStatus.usedSeed !== undefined
                          ? ` · Seed: ${comfyStatus.usedSeed}`
                          : ''}
                      </div>
                    </div>
                  ) : (
                    <p className="text-[11px] text-[#4C5264] leading-snug break-words">
                      {comfyStatus.message}
                    </p>
                  )}
                </div>
              </div>

              <button
                type="button"
                onClick={() => setComfyStatus({ state: 'idle' })}
                aria-label="关闭提交提示"
                className="text-[#949AA8] hover:text-[#1E2028] p-0.5 cursor-pointer shrink-0"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
};
