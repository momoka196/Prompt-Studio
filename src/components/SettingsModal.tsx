import React, { useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  Dices,
  Download,
  History,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { COMFY_ARCH_DEFAULTS, DEFAULT_COMFY_SEED } from '../data/presets';
import {
  ComfyArchitecture,
  ComfyLoaderKey,
  ComfyLoraItem,
  ComfyProfile,
  ComfySamplingParams,
  ComfyValidationMap,
  HistorySnapshot,
} from '../types/studio';
import {
  clampLoraWeight,
  getActiveLoaderKeys,
  LOADER_NODE_META,
  LORA_WEIGHT_MAX,
  LORA_WEIGHT_MIN,
  MAX_COMFY_LORAS,
} from '../utils/promptBuilder';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  comfyUrl: string;
  onComfyUrlChange: (url: string) => void;
  profiles: ComfyProfile[];
  activeProfile: ComfyProfile;
  validation: ComfyValidationMap;
  probingLoaders: boolean;
  onProbeLoaders: (keys?: ComfyLoaderKey[]) => void;
  onSelectProfile: (profileId: string) => void;
  onUpdateActiveProfile: (updater: (prev: ComfyProfile) => ComfyProfile) => void;
  onCreateProfile: (name?: string) => void;
  onRenameProfile: (profileId: string, newName: string) => void;
  onDeleteProfile: (profileId: string) => void;
  onExportProfile: (profile: ComfyProfile) => void;
  onImportProfile: (file: File) => Promise<string>;
  onExportConfig: () => void;
  onImportConfig: (file: File) => void;
  importError: string | null;
  onResetDefaults: () => void;
  history: HistorySnapshot[];
  onSaveSnapshot: () => void;
  onRollbackHistory: (snapshotId: string) => void;
}

const ARCH_ORDER: ComfyArchitecture[] = [
  'anima',
  'sdxl',
  'illustrious',
  'sd15',
  'custom',
];

const CUSTOM_LOADER_ENABLE_KEY: Record<
  ComfyLoaderKey,
  'enableCheckpoint' | 'enableUnet' | 'enableClip' | 'enableVae'
> = {
  checkpoint: 'enableCheckpoint',
  unet: 'enableUnet',
  clip: 'enableClip',
  vae: 'enableVae',
};

export const SettingsModal: React.FC<SettingsModalProps> = ({
  open,
  onClose,
  comfyUrl,
  onComfyUrlChange,
  profiles,
  activeProfile,
  validation,
  probingLoaders,
  onProbeLoaders,
  onSelectProfile,
  onUpdateActiveProfile,
  onCreateProfile,
  onRenameProfile,
  onDeleteProfile,
  onExportProfile,
  onImportProfile,
  onExportConfig,
  onImportConfig,
  importError,
  onResetDefaults,
  history,
  onSaveSnapshot,
  onRollbackHistory,
}) => {
  const [tab, setTab] = useState<'comfy' | 'backup' | 'history'>('comfy');
  const [renamingProfile, setRenamingProfile] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [profileNotice, setProfileNotice] = useState<{
    type: 'ok' | 'err';
    text: string;
  } | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const profileFileInputRef = useRef<HTMLInputElement | null>(null);

  if (!open) return null;

  const activeLoaderKeys = getActiveLoaderKeys(activeProfile);
  const displayedLoaderKeys: ComfyLoaderKey[] =
    activeProfile.architecture === 'custom'
      ? ['checkpoint', 'unet', 'clip', 'vae']
      : activeLoaderKeys;

  const handleSwitchArchitecture = (arch: ComfyArchitecture) => {
    const preset = COMFY_ARCH_DEFAULTS[arch];
    onUpdateActiveProfile((prev) => {
      const manual = new Set(prev.manualSamplingFields ?? []);
      const nextSampling: ComfySamplingParams = {
        width: manual.has('width') ? prev.sampling.width : preset.defaultSampling.width,
        height: manual.has('height') ? prev.sampling.height : preset.defaultSampling.height,
        steps: manual.has('steps') ? prev.sampling.steps : preset.defaultSampling.steps,
        cfg: manual.has('cfg') ? prev.sampling.cfg : preset.defaultSampling.cfg,
        sampler: manual.has('sampler') ? prev.sampling.sampler : preset.defaultSampling.sampler,
        scheduler: manual.has('scheduler')
          ? prev.sampling.scheduler
          : preset.defaultSampling.scheduler,
        denoise: manual.has('denoise')
          ? prev.sampling.denoise ?? 1.0
          : preset.defaultSampling.denoise ?? 1.0,
        seedMode: manual.has('seedMode')
          ? prev.sampling.seedMode ?? 'fixed'
          : preset.defaultSampling.seedMode ?? 'fixed',
        seed: manual.has('seed')
          ? prev.sampling.seed ?? DEFAULT_COMFY_SEED
          : preset.defaultSampling.seed ?? DEFAULT_COMFY_SEED,
      };
      return {
        ...prev,
        architecture: arch,
        loaders: {
          ...prev.loaders,
          ...preset.defaultLoaders,
        },
        sampling: nextSampling,
      };
    });
  };

  const handleLoaderValueChange = (key: ComfyLoaderKey, value: string) => {
    onUpdateActiveProfile((prev) => ({
      ...prev,
      loaders: {
        ...prev.loaders,
        [key]: value,
      },
    }));
  };

  const handleCustomLoaderToggle = (key: ComfyLoaderKey, enabled: boolean) => {
    const enableProp = CUSTOM_LOADER_ENABLE_KEY[key];
    onUpdateActiveProfile((prev) => ({
      ...prev,
      loaders: {
        ...prev.loaders,
        [enableProp]: enabled,
      },
    }));
  };

  const handleSamplingFieldChange = <K extends keyof ComfySamplingParams>(
    field: K,
    value: ComfySamplingParams[K]
  ) => {
    onUpdateActiveProfile((prev) => {
      const prevManual = prev.manualSamplingFields ?? [];
      const nextManual = prevManual.includes(field)
        ? prevManual
        : [...prevManual, field];
      return {
        ...prev,
        sampling: {
          ...prev.sampling,
          [field]: value,
        },
        manualSamplingFields: nextManual,
      };
    });
  };

  const handleResetSamplingToArch = () => {
    const preset = COMFY_ARCH_DEFAULTS[activeProfile.architecture];
    onUpdateActiveProfile((prev) => ({
      ...prev,
      sampling: { ...preset.defaultSampling },
      manualSamplingFields: [],
    }));
  };

  const handleAddLora = () => {
    onUpdateActiveProfile((prev) => {
      if ((prev.loras ?? []).length >= MAX_COMFY_LORAS) return prev;
      const nextItem: ComfyLoraItem = {
        id: `lora-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
        name: validation.loraAvailable[0] ?? '',
        model: 0.8,
        clip: 0.8,
        condition: null,
        enabled: true,
        triggerWords: '',
        note: '',
      };
      return {
        ...prev,
        loras: [...(prev.loras ?? []), nextItem],
      };
    });
  };

  const handleUpdateLora = (index: number, patch: Partial<ComfyLoraItem>) => {
    const sanitizedPatch: Partial<ComfyLoraItem> = { ...patch };
    if (typeof sanitizedPatch.model === 'number') {
      sanitizedPatch.model = clampLoraWeight(sanitizedPatch.model, 0.8);
    }
    if (typeof sanitizedPatch.clip === 'number') {
      sanitizedPatch.clip = clampLoraWeight(sanitizedPatch.clip, 0.8);
    }
    onUpdateActiveProfile((prev) => ({
      ...prev,
      loras: prev.loras.map((item, idx) =>
        idx === index ? { ...item, ...sanitizedPatch } : item
      ),
    }));
  };

  const handleMoveLora = (index: number, dir: 'up' | 'down') => {
    onUpdateActiveProfile((prev) => {
      const target = dir === 'up' ? index - 1 : index + 1;
      if (target < 0 || target >= prev.loras.length) return prev;
      const next = [...prev.loras];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved);
      return { ...prev, loras: next };
    });
  };

  const handleRemoveLora = (index: number) => {
    onUpdateActiveProfile((prev) => ({
      ...prev,
      loras: prev.loras.filter((_, idx) => idx !== index),
    }));
  };

  const formatTime = (ts: number) =>
    new Date(ts).toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E2028]/30 backdrop-blur-xs p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-[16px] border border-[#E0E0E6] bg-white shadow-[0_20px_50px_rgba(18,22,33,0.16)] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="px-5 py-3.5 border-b border-[#EAEAEF] flex items-center justify-between gap-3 bg-[#FAFAFC]">
          <div className="inline-flex items-center gap-1 rounded-full bg-[#EFEFF4] p-1">
            {(
              [
                { id: 'comfy', label: 'ComfyUI 与模型' },
                { id: 'backup', label: '配置导入 / 重置' },
                { id: 'history', label: `历史回滚 (${history.length})` },
              ] as { id: 'comfy' | 'backup' | 'history'; label: string }[]
            ).map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`px-3 py-1 text-[12px] font-medium rounded-full transition-all cursor-pointer whitespace-nowrap ${
                  tab === t.id
                    ? 'bg-white text-[#6B48F5] shadow-xs'
                    : 'text-[#686E7E] hover:text-[#1E2028]'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="关闭设置"
            className="text-[#8E94A4] hover:text-[#1E2028] hover:bg-[#EFEFF4] rounded-[8px] p-1.5 cursor-pointer transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 内容区 */}
        <div className="p-5 max-h-[76vh] overflow-y-auto space-y-4">
          {tab === 'comfy' && (
            <>
              {/* Profile 方案切换与导入导出 */}
              <div className="rounded-[12px] border border-[#EAEAEF] bg-[#FAFAFC] p-3 space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[11.5px] font-semibold text-[#1E2028]">
                    当前模型方案 (Profile)
                  </span>

                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        onCreateProfile();
                        setProfileNotice({ type: 'ok', text: '已复制当前方案为新 Profile' });
                      }}
                      className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded-[8px] border border-[#E2E3EA] bg-white text-[#4C5264] hover:border-[#7C5CFC]/40 hover:text-[#7C5CFC] cursor-pointer transition-colors"
                    >
                      <Plus className="w-3 h-3" />
                      <span>新建</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => onExportProfile(activeProfile)}
                      className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded-[8px] border border-[#E2E3EA] bg-white text-[#4C5264] hover:border-[#7C5CFC]/40 hover:text-[#7C5CFC] cursor-pointer transition-colors"
                    >
                      <Download className="w-3 h-3" />
                      <span>导出 Profile</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => profileFileInputRef.current?.click()}
                      className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded-[8px] border border-[#E2E3EA] bg-white text-[#4C5264] hover:border-[#7C5CFC]/40 hover:text-[#7C5CFC] cursor-pointer transition-colors"
                    >
                      <Upload className="w-3 h-3" />
                      <span>导入 Profile</span>
                    </button>

                    <input
                      ref={profileFileInputRef}
                      type="file"
                      accept=".json,application/json"
                      className="hidden"
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        if (profileFileInputRef.current) profileFileInputRef.current.value = '';
                        if (!file) return;
                        try {
                          const importedName = await onImportProfile(file);
                          setProfileNotice({
                            type: 'ok',
                            text: `已导入方案「${importedName}」并设为当前方案`,
                          });
                        } catch (err) {
                          setProfileNotice({
                            type: 'err',
                            text: err instanceof Error ? err.message : '导入 Profile 失败',
                          });
                        }
                      }}
                    />
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {renamingProfile ? (
                    <div className="flex-1 flex items-center gap-1.5">
                      <input
                        type="text"
                        value={renameDraft}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && renameDraft.trim()) {
                            onRenameProfile(activeProfile.id, renameDraft);
                            setRenamingProfile(false);
                          }
                        }}
                        autoFocus
                        className="flex-1 rounded-[8px] border border-[#7C5CFC] bg-white px-2.5 py-1.5 text-[12px] text-[#1E2028] focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          if (renameDraft.trim()) {
                            onRenameProfile(activeProfile.id, renameDraft);
                          }
                          setRenamingProfile(false);
                        }}
                        className="px-2.5 py-1.5 rounded-[8px] bg-[#7C5CFC] text-white text-[11px] font-medium cursor-pointer"
                      >
                        <Check className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setRenamingProfile(false)}
                        className="px-2 py-1.5 rounded-[8px] border border-[#E2E3EA] bg-white text-[#686E7E] text-[11px] cursor-pointer"
                      >
                        取消
                      </button>
                    </div>
                  ) : (
                    <>
                      <select
                        value={activeProfile.id}
                        onChange={(e) => onSelectProfile(e.target.value)}
                        aria-label="选择 Profile 方案"
                        className="flex-1 rounded-[10px] border border-[#E2E3EA] bg-white px-3 py-1.5 text-[12px] font-medium text-[#1E2028] focus:border-[#7C5CFC] focus:outline-none"
                      >
                        {profiles.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} ({COMFY_ARCH_DEFAULTS[p.architecture].label})
                          </option>
                        ))}
                      </select>

                      <button
                        type="button"
                        title="重命名当前方案"
                        onClick={() => {
                          setRenameDraft(activeProfile.name);
                          setRenamingProfile(true);
                        }}
                        className="p-1.5 rounded-[8px] border border-[#E2E3EA] bg-white text-[#686E7E] hover:text-[#7C5CFC] hover:border-[#7C5CFC]/40 cursor-pointer transition-colors"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>

                      <button
                        type="button"
                        title="删除当前方案"
                        disabled={profiles.length <= 1}
                        onClick={() => onDeleteProfile(activeProfile.id)}
                        className="p-1.5 rounded-[8px] border border-[#E2E3EA] bg-white text-[#686E7E] hover:text-[#E85D75] hover:border-[#F8C8D2] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </>
                  )}
                </div>

                {profileNotice && (
                  <p
                    className={`text-[11px] px-2.5 py-1.5 rounded-[8px] ${
                      profileNotice.type === 'ok'
                        ? 'bg-emerald-50 text-emerald-700'
                        : 'bg-[#FFF1F3] text-[#C93B58]'
                    }`}
                  >
                    {profileNotice.text}
                  </p>
                )}
              </div>

              {/* ComfyUI 服务地址 + 一键校验 */}
              <div>
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <label className="text-[11.5px] font-medium text-[#5A6072]">
                    本地 ComfyUI 服务地址
                  </label>
                  <button
                    type="button"
                    onClick={() => onProbeLoaders()}
                    disabled={probingLoaders}
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-[#7C5CFC] hover:underline cursor-pointer disabled:opacity-40"
                  >
                    <RefreshCw
                      className={`w-3 h-3 ${probingLoaders ? 'animate-spin' : ''}`}
                    />
                    <span>{probingLoaders ? '校验中...' : '校验全部模型'}</span>
                  </button>
                </div>
                <input
                  type="text"
                  value={comfyUrl}
                  onChange={(e) => onComfyUrlChange(e.target.value)}
                  placeholder="http://127.0.0.1:8188"
                  className="w-full rounded-[10px] border border-[#E2E3EA] bg-[#FAFAFC] px-3 py-2 text-[12px] font-mono text-[#1E2028] focus:bg-white focus:border-[#7C5CFC] focus:outline-none"
                />
              </div>

              {/* 改动 1：架构选择器 */}
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11.5px] font-medium text-[#5A6072]">
                    模型架构预设
                  </span>
                  <span className="text-[11px] text-[#8E94A4]">
                    {COMFY_ARCH_DEFAULTS[activeProfile.architecture].desc}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {ARCH_ORDER.map((arch) => {
                    const preset = COMFY_ARCH_DEFAULTS[arch];
                    const selected = activeProfile.architecture === arch;
                    return (
                      <button
                        key={arch}
                        type="button"
                        onClick={() => handleSwitchArchitecture(arch)}
                        className={`px-3.5 py-1.5 text-[12px] font-medium rounded-full border transition-all cursor-pointer ${
                          selected
                            ? 'bg-[#7C5CFC] border-[#7C5CFC] text-white shadow-[0_2px_8px_rgba(124,92,252,0.25)]'
                            : 'bg-[#F4F4F7] border-[#E2E3EA] text-[#4C5264] hover:border-[#7C5CFC]/40 hover:text-[#7C5CFC]'
                        }`}
                      >
                        {preset.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 改动 2：模型加载区 */}
              <div className="pt-3 border-t border-[#EAEAEF] space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11.5px] font-semibold text-[#1E2028]">
                    模型加载节点
                  </span>
                  <span className="text-[11px] text-[#8E94A4]">
                    所有启用节点绿灯通过后即可发送
                  </span>
                </div>

                <div className="space-y-2.5">
                  {displayedLoaderKeys.map((key) => {
                    const meta = LOADER_NODE_META[key];
                    const entry = validation[key];
                    const enableProp = CUSTOM_LOADER_ENABLE_KEY[key];
                    const isCustom = activeProfile.architecture === 'custom';
                    const isEnabled = !isCustom || Boolean(activeProfile.loaders[enableProp]);
                    const val = activeProfile.loaders[key] ?? '';
                    const datalistId = `comfy-options-${key}`;

                    const dotClass = !isEnabled
                      ? 'bg-[#CBD0DC]'
                      : entry.status === 'valid'
                      ? 'bg-emerald-500'
                      : entry.status === 'invalid'
                      ? 'bg-[#E85D75]'
                      : entry.status === 'checking'
                      ? 'bg-amber-400 animate-pulse'
                      : entry.status === 'error'
                      ? 'bg-amber-500'
                      : 'bg-[#CBD0DC]';

                    const statusText = !isEnabled
                      ? '未启用'
                      : entry.status === 'valid'
                      ? '已验证可用'
                      : entry.status === 'checking'
                      ? '校验中...'
                      : entry.status === 'invalid'
                      ? entry.message || `${meta.shortLabel} 不存在`
                      : entry.status === 'error'
                      ? '无法连接 ComfyUI'
                      : '未校验';

                    return (
                      <div
                        key={key}
                        className={`rounded-[10px] border p-2.5 transition-colors ${
                          !isEnabled
                            ? 'border-[#EAEAEF] bg-[#F8F8FA] opacity-65'
                            : entry.status === 'invalid'
                            ? 'border-[#F8C8D2] bg-[#FFF8F9]'
                            : 'border-[#E2E3EA] bg-[#FAFAFC]'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2 mb-1.5">
                          <div className="flex items-center gap-2 min-w-0">
                            {isCustom && (
                              <input
                                type="checkbox"
                                checked={isEnabled}
                                onChange={(e) =>
                                  handleCustomLoaderToggle(key, e.target.checked)
                                }
                                className="w-3.5 h-3.5 accent-[#7C5CFC] rounded cursor-pointer"
                              />
                            )}
                            <span className="text-[12px] font-semibold text-[#1E2028]">
                              {meta.label}
                            </span>
                            <span className="inline-flex items-center gap-1.5 text-[11px] text-[#5A6072]">
                              <span
                                className={`w-2 h-2 rounded-full shrink-0 ${dotClass}`}
                              />
                              <span
                                className={
                                  isEnabled && entry.status === 'invalid'
                                    ? 'text-[#C93B58] font-medium'
                                    : isEnabled && entry.status === 'valid'
                                    ? 'text-emerald-700'
                                    : 'text-[#8E94A4]'
                                }
                              >
                                {statusText}
                              </span>
                            </span>
                          </div>

                          <button
                            type="button"
                            disabled={!isEnabled || probingLoaders}
                            onClick={() => onProbeLoaders([key])}
                            className="text-[11px] font-medium text-[#7C5CFC] hover:underline cursor-pointer disabled:opacity-40 shrink-0"
                          >
                            读取列表
                          </button>
                        </div>

                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            list={datalistId}
                            disabled={!isEnabled}
                            value={val}
                            onChange={(e) => handleLoaderValueChange(key, e.target.value)}
                            placeholder={`输入 ${meta.inputKey} 文件名...`}
                            className="flex-1 rounded-[8px] border border-[#E2E3EA] bg-white px-2.5 py-1.5 text-[12px] font-mono text-[#1E2028] focus:border-[#7C5CFC] focus:outline-none disabled:bg-[#F4F4F7]"
                          />
                          {entry.available.length > 0 && (
                            <>
                              <datalist id={datalistId}>
                                {entry.available.map((opt) => (
                                  <option key={opt} value={opt} />
                                ))}
                              </datalist>
                              <select
                                aria-label={`选择 ${meta.label} 模型`}
                                disabled={!isEnabled}
                                value={entry.available.includes(val) ? val : ''}
                                onChange={(e) => {
                                  if (e.target.value) {
                                    handleLoaderValueChange(key, e.target.value);
                                  }
                                }}
                                className="max-w-[160px] rounded-[8px] border border-[#E2E3EA] bg-white px-2 py-1.5 text-[11px] font-mono text-[#4C5264] focus:border-[#7C5CFC] focus:outline-none"
                              >
                                <option value="">快速选择 ({entry.available.length})</option>
                                {entry.available.map((opt) => (
                                  <option key={opt} value={opt}>
                                    {opt}
                                  </option>
                                ))}
                              </select>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* 改动 3：动态 LoRA 链 */}
              {(() => {
                const enabledLoraCount = activeProfile.loras.filter(
                  (l) => l.enabled !== false && l.name.trim().length > 0
                ).length;
                return (
                  <div className="pt-3 border-t border-[#EAEAEF] space-y-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-[11.5px] font-semibold text-[#1E2028]">
                          LoRA 链（已启用 {enabledLoraCount} 层 · 共 {activeProfile.loras.length}/{MAX_COMFY_LORAS}）
                        </span>
                        <span className="text-[10.5px] text-[#8E94A4]">
                          权重范围 {LORA_WEIGHT_MIN}~{LORA_WEIGHT_MAX}
                        </span>
                      </div>
                      <button
                        type="button"
                        disabled={activeProfile.loras.length >= MAX_COMFY_LORAS}
                        onClick={handleAddLora}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded-[8px] bg-[#F4F2FF] text-[#6B48F5] hover:bg-[#EBE6FF] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors"
                      >
                        <Plus className="w-3 h-3" />
                        <span>添加 LoRA</span>
                      </button>
                    </div>

                    {enabledLoraCount > 6 && (
                      <div className="flex items-center gap-1.5 rounded-[8px] border border-amber-200 bg-amber-50 px-3 py-1.5 text-[11.5px] text-amber-800">
                        <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                        <span>
                          当前已启用 {enabledLoraCount} 层 LoRA，超过 6 层容易增加显存占用并导致细节流失，建议按需取消勾选暂不使用的层
                        </span>
                      </div>
                    )}

                    {validation.loraAvailable.length > 0 && (
                      <datalist id="comfy-lora-options">
                        {validation.loraAvailable.map((opt) => (
                          <option key={opt} value={opt} />
                        ))}
                      </datalist>
                    )}

                    {activeProfile.loras.length === 0 ? (
                      <p className="text-[11.5px] text-[#8E94A4] py-2 text-center rounded-[10px] border border-dashed border-[#E2E3EA]">
                        当前未挂载 LoRA，将直接使用底模出图
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {activeProfile.loras.map((lora, idx) => {
                          const isEnabled = lora.enabled !== false;
                          return (
                            <div
                              key={lora.id || `lora-row-${idx}`}
                              className={`rounded-[10px] border px-2.5 py-2 space-y-1.5 transition-opacity ${
                                isEnabled
                                  ? 'border-[#EAEAEF] bg-[#FAFAFC]'
                                  : 'border-[#E6E7EE] bg-[#F4F4F7] opacity-60'
                              }`}
                            >
                              <div className="flex flex-wrap sm:flex-nowrap items-center gap-1.5">
                                <input
                                  type="checkbox"
                                  checked={isEnabled}
                                  title={isEnabled ? '已启用（点击禁用）' : '已禁用（点击启用）'}
                                  aria-label={`启用第 ${idx + 1} 层 LoRA`}
                                  onChange={(e) =>
                                    handleUpdateLora(idx, { enabled: e.target.checked })
                                  }
                                  className="w-3.5 h-3.5 accent-[#7C5CFC] rounded cursor-pointer shrink-0"
                                />

                                <span className="text-[11px] font-mono text-[#8E94A4] w-5 shrink-0 tabular-nums">
                                  [{idx + 1}]
                                </span>

                                <input
                                  type="text"
                                  list={
                                    validation.loraAvailable.length > 0
                                      ? 'comfy-lora-options'
                                      : undefined
                                  }
                                  value={lora.name}
                                  onChange={(e) =>
                                    handleUpdateLora(idx, { name: e.target.value })
                                  }
                                  placeholder="输入或选择 LoRA 文件名"
                                  className="flex-1 min-w-[130px] rounded-[7px] border border-[#E2E3EA] bg-white px-2 py-1 text-[11.5px] font-mono text-[#1E2028] focus:border-[#7C5CFC] focus:outline-none"
                                />

                                {validation.loraAvailable.length > 0 && (
                                  <select
                                    aria-label={`快速选择第 ${idx + 1} 层 LoRA`}
                                    value={
                                      validation.loraAvailable.includes(lora.name)
                                        ? lora.name
                                        : ''
                                    }
                                    onChange={(e) => {
                                      if (e.target.value) {
                                        handleUpdateLora(idx, { name: e.target.value });
                                      }
                                    }}
                                    className="max-w-[115px] rounded-[7px] border border-[#E2E3EA] bg-white px-1.5 py-1 text-[11px] font-mono text-[#4C5264] focus:border-[#7C5CFC] focus:outline-none"
                                  >
                                    <option value="">列表({validation.loraAvailable.length})</option>
                                    {validation.loraAvailable.map((opt) => (
                                      <option key={opt} value={opt}>
                                        {opt}
                                      </option>
                                    ))}
                                  </select>
                                )}

                                <div className="flex items-center gap-1 shrink-0 tabular-nums">
                                  <input
                                    type="number"
                                    min={LORA_WEIGHT_MIN}
                                    max={LORA_WEIGHT_MAX}
                                    step={0.05}
                                    value={lora.model}
                                    title={`model 权重 (${LORA_WEIGHT_MIN} ~ ${LORA_WEIGHT_MAX})`}
                                    onChange={(e) => {
                                      const parsed = parseFloat(e.target.value);
                                      handleUpdateLora(idx, {
                                        model: Number.isFinite(parsed)
                                          ? clampLoraWeight(parsed, 0)
                                          : 0,
                                      });
                                    }}
                                    className="w-14 rounded-[7px] border border-[#E2E3EA] bg-white px-1.5 py-1 text-[11px] font-mono text-center text-[#1E2028] focus:border-[#7C5CFC] focus:outline-none"
                                  />
                                  <span className="text-[11px] text-[#949AA8]">/</span>
                                  <input
                                    type="number"
                                    min={LORA_WEIGHT_MIN}
                                    max={LORA_WEIGHT_MAX}
                                    step={0.05}
                                    value={lora.clip}
                                    title={`clip 权重 (${LORA_WEIGHT_MIN} ~ ${LORA_WEIGHT_MAX})`}
                                    onChange={(e) => {
                                      const parsed = parseFloat(e.target.value);
                                      handleUpdateLora(idx, {
                                        clip: Number.isFinite(parsed)
                                          ? clampLoraWeight(parsed, 0)
                                          : 0,
                                      });
                                    }}
                                    className="w-14 rounded-[7px] border border-[#E2E3EA] bg-white px-1.5 py-1 text-[11px] font-mono text-center text-[#1E2028] focus:border-[#7C5CFC] focus:outline-none"
                                  />
                                </div>

                                <label className="inline-flex items-center gap-1 text-[11px] text-[#5A6072] shrink-0 cursor-pointer select-none px-1">
                                  <input
                                    type="checkbox"
                                    checked={lora.condition === 'ibuki_only'}
                                    onChange={(e) =>
                                      handleUpdateLora(idx, {
                                        condition: e.target.checked ? 'ibuki_only' : null,
                                      })
                                    }
                                    className="w-3 h-3 accent-[#7C5CFC] rounded"
                                  />
                                  <span>仅伊启用</span>
                                </label>

                                <div className="flex items-center gap-0.5 shrink-0">
                                  <button
                                    type="button"
                                    disabled={idx === 0}
                                    onClick={() => handleMoveLora(idx, 'up')}
                                    title="上移"
                                    className="p-1 rounded-[6px] text-[#686E7E] hover:bg-white hover:text-[#7C5CFC] disabled:opacity-30 cursor-pointer"
                                  >
                                    <ArrowUp className="w-3 h-3" />
                                  </button>
                                  <button
                                    type="button"
                                    disabled={idx === activeProfile.loras.length - 1}
                                    onClick={() => handleMoveLora(idx, 'down')}
                                    title="下移"
                                    className="p-1 rounded-[6px] text-[#686E7E] hover:bg-white hover:text-[#7C5CFC] disabled:opacity-30 cursor-pointer"
                                  >
                                    <ArrowDown className="w-3 h-3" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleRemoveLora(idx)}
                                    title="移除此 LoRA"
                                    className="p-1 rounded-[6px] text-[#686E7E] hover:bg-[#FFF1F3] hover:text-[#E85D75] cursor-pointer"
                                  >
                                    <X className="w-3 h-3" />
                                  </button>
                                </div>
                              </div>

                              <div className="flex flex-wrap sm:flex-nowrap items-center gap-1.5 pl-6">
                                <input
                                  type="text"
                                  value={lora.triggerWords ?? ''}
                                  onChange={(e) =>
                                    handleUpdateLora(idx, { triggerWords: e.target.value })
                                  }
                                  placeholder="可选触发词（英文 tag，启用时自动合并去重）"
                                  className="flex-1 min-w-[160px] rounded-[6px] border border-[#EAEAEF] bg-white px-2 py-1 text-[11px] font-mono text-[#373C4B] focus:border-[#7C5CFC] focus:outline-none"
                                />
                                <input
                                  type="text"
                                  value={lora.note ?? ''}
                                  onChange={(e) =>
                                    handleUpdateLora(idx, { note: e.target.value })
                                  }
                                  placeholder="备注（如画风/光影/角色）"
                                  className="w-full sm:w-[155px] rounded-[6px] border border-[#EAEAEF] bg-white px-2 py-1 text-[11px] text-[#4C5264] focus:border-[#7C5CFC] focus:outline-none"
                                />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* 改动 4：采样参数与恢复默认 */}
              <div className="pt-3 border-t border-[#EAEAEF] space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11.5px] font-semibold text-[#1E2028]">
                    采样参数
                  </span>
                  <button
                    type="button"
                    onClick={handleResetSamplingToArch}
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-[#7C5CFC] hover:underline cursor-pointer"
                  >
                    <RotateCcw className="w-3 h-3" />
                    <span>恢复当前架构默认</span>
                  </button>
                </div>

                <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 tabular-nums">
                  <div>
                    <label className="block text-[11px] text-[#686E7E] mb-1">宽</label>
                    <input
                      type="number"
                      value={activeProfile.sampling.width}
                      onChange={(e) =>
                        handleSamplingFieldChange(
                          'width',
                          Math.max(64, parseInt(e.target.value, 10) || 832)
                        )
                      }
                      className="w-full rounded-[8px] border border-[#E2E3EA] bg-[#FAFAFC] px-2 py-1 text-[12px] font-mono text-[#1E2028] focus:bg-white focus:border-[#7C5CFC] focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-[#686E7E] mb-1">高</label>
                    <input
                      type="number"
                      value={activeProfile.sampling.height}
                      onChange={(e) =>
                        handleSamplingFieldChange(
                          'height',
                          Math.max(64, parseInt(e.target.value, 10) || 1216)
                        )
                      }
                      className="w-full rounded-[8px] border border-[#E2E3EA] bg-[#FAFAFC] px-2 py-1 text-[12px] font-mono text-[#1E2028] focus:bg-white focus:border-[#7C5CFC] focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-[#686E7E] mb-1">Steps</label>
                    <input
                      type="number"
                      value={activeProfile.sampling.steps}
                      onChange={(e) =>
                        handleSamplingFieldChange(
                          'steps',
                          Math.max(1, parseInt(e.target.value, 10) || 28)
                        )
                      }
                      className="w-full rounded-[8px] border border-[#E2E3EA] bg-[#FAFAFC] px-2 py-1 text-[12px] font-mono text-[#1E2028] focus:bg-white focus:border-[#7C5CFC] focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-[#686E7E] mb-1">CFG</label>
                    <input
                      type="number"
                      step={0.1}
                      value={activeProfile.sampling.cfg}
                      onChange={(e) =>
                        handleSamplingFieldChange(
                          'cfg',
                          Math.max(0.5, parseFloat(e.target.value) || 4.5)
                        )
                      }
                      className="w-full rounded-[8px] border border-[#E2E3EA] bg-[#FAFAFC] px-2 py-1 text-[12px] font-mono text-[#1E2028] focus:bg-white focus:border-[#7C5CFC] focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-[#686E7E] mb-1">Sampler</label>
                    <input
                      type="text"
                      value={activeProfile.sampling.sampler}
                      onChange={(e) =>
                        handleSamplingFieldChange('sampler', e.target.value)
                      }
                      className="w-full rounded-[8px] border border-[#E2E3EA] bg-[#FAFAFC] px-2 py-1 text-[12px] font-mono text-[#1E2028] focus:bg-white focus:border-[#7C5CFC] focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-[#686E7E] mb-1">Scheduler</label>
                    <input
                      type="text"
                      value={activeProfile.sampling.scheduler}
                      onChange={(e) =>
                        handleSamplingFieldChange('scheduler', e.target.value)
                      }
                      className="w-full rounded-[8px] border border-[#E2E3EA] bg-[#FAFAFC] px-2 py-1 text-[12px] font-mono text-[#1E2028] focus:bg-white focus:border-[#7C5CFC] focus:outline-none"
                    />
                  </div>
                </div>

                {/* Seed 固定 / 随机设置 */}
                <div className="flex flex-wrap items-center justify-between gap-2.5 rounded-[10px] border border-[#E2E3EA] bg-[#FAFAFC] px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[11.5px] font-medium text-[#4C5264]">
                      Seed 策略
                    </span>
                    <div className="inline-flex rounded-[8px] border border-[#E2E3EA] bg-white p-0.5">
                      <button
                        type="button"
                        onClick={() => handleSamplingFieldChange('seedMode', 'fixed')}
                        className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-[6px] text-[11px] font-medium transition-colors cursor-pointer ${
                          (activeProfile.sampling.seedMode ?? 'fixed') === 'fixed'
                            ? 'bg-[#7C5CFC] text-white'
                            : 'text-[#686E7E] hover:text-[#1E2028]'
                        }`}
                      >
                        <Lock className="w-3 h-3" />
                        <span>固定 Seed</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleSamplingFieldChange('seedMode', 'random')}
                        className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-[6px] text-[11px] font-medium transition-colors cursor-pointer ${
                          (activeProfile.sampling.seedMode ?? 'fixed') === 'random'
                            ? 'bg-[#7C5CFC] text-white'
                            : 'text-[#686E7E] hover:text-[#1E2028]'
                        }`}
                      >
                        <Dices className="w-3 h-3" />
                        <span>每次随机</span>
                      </button>
                    </div>
                  </div>

                  {(activeProfile.sampling.seedMode ?? 'fixed') === 'fixed' ? (
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] text-[#686E7E]">固定值</span>
                      <input
                        type="number"
                        min={0}
                        value={activeProfile.sampling.seed ?? DEFAULT_COMFY_SEED}
                        onChange={(e) => {
                          const val = parseInt(e.target.value, 10);
                          handleSamplingFieldChange(
                            'seed',
                            Number.isFinite(val) && val >= 0 ? val : 0
                          );
                        }}
                        className="w-[165px] rounded-[8px] border border-[#E2E3EA] bg-white px-2.5 py-1 text-[12px] font-mono tabular-nums text-[#1E2028] focus:border-[#7C5CFC] focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          handleSamplingFieldChange(
                            'seed',
                            Math.floor(Math.random() * 2147483647)
                          )
                        }
                        title="随机生成一个新固定 Seed"
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-[8px] border border-[#E2E3EA] bg-white text-[11px] font-medium text-[#4C5264] hover:border-[#7C5CFC]/50 hover:text-[#6B48F5] cursor-pointer"
                      >
                        <Dices className="w-3.5 h-3.5" />
                        <span>换一个</span>
                      </button>
                    </div>
                  ) : (
                    <span className="text-[11px] text-[#8E94A4]">
                      每次发送到 ComfyUI 时自动生成随机整数 Seed
                    </span>
                  )}
                </div>
              </div>
            </>
          )}

          {tab === 'backup' && (
            <div className="space-y-3">
              <p className="text-[12.5px] text-[#5A6072] leading-relaxed">
                整体备份共享层、所有角色、自定义可爱预设、背景预设与所有 Profile 模型配置为{' '}
                <span className="font-mono px-1.5 py-0.5 rounded-[6px] bg-[#F2F3F7] text-[#1E2028]">
                  chibiprompt-config.json
                </span>
                。
              </p>

              <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) onImportConfig(file);
                  if (fileInputRef.current) fileInputRef.current.value = '';
                }}
                className="hidden"
              />

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={onExportConfig}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-[12px] font-medium rounded-[10px] bg-[#F4F2FF] text-[#6B48F5] hover:bg-[#EBE6FF] cursor-pointer transition-colors"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>导出配置 JSON</span>
                </button>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-[12px] font-medium rounded-[10px] border border-[#EAEAEF] bg-white text-[#373C4B] hover:border-[#7C5CFC]/40 hover:text-[#7C5CFC] cursor-pointer transition-colors"
                >
                  <Upload className="w-3.5 h-3.5" />
                  <span>导入配置 JSON</span>
                </button>
                <button
                  type="button"
                  onClick={onResetDefaults}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-[12px] font-medium rounded-[10px] border border-[#F8C8D2] bg-[#FFF1F3] text-[#C93B58] hover:bg-[#FFE4E9] cursor-pointer ml-auto transition-colors"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>恢复默认 4 角色</span>
                </button>
              </div>

              {importError && (
                <p className="text-[12px] text-[#E85D75]">{importError}</p>
              )}
            </div>
          )}

          {tab === 'history' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] text-[#686E7E] flex items-center gap-1.5">
                  <History className="w-3.5 h-3.5" />
                  <span>自动保留最近 20 组修改快照</span>
                </span>
                <button
                  type="button"
                  onClick={onSaveSnapshot}
                  className="text-[12px] font-medium text-[#7C5CFC] hover:underline cursor-pointer"
                >
                  + 手动存为快照
                </button>
              </div>

              {history.length === 0 ? (
                <p className="text-[12px] text-[#8E94A4] py-6 text-center">
                  暂无历史快照
                </p>
              ) : (
                <div className="divide-y divide-[#EAEAEF] border border-[#EAEAEF] rounded-[12px] bg-[#FAFAFC] overflow-hidden">
                  {history.map((snap) => (
                    <div
                      key={snap.id}
                      className="px-3.5 py-2.5 flex items-center justify-between gap-2 bg-white/80 hover:bg-white transition-colors"
                    >
                      <div className="min-w-0">
                        <div className="text-[12px] font-medium text-[#1E2028] truncate">
                          {snap.label}
                        </div>
                        <div className="text-[11px] text-[#8E94A4] tabular-nums">
                          {formatTime(snap.createdAt)} · {snap.config.characters.length} 个角色
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          onRollbackHistory(snap.id);
                          onClose();
                        }}
                        className="px-3 py-1 text-[11px] font-medium rounded-[10px] border border-[#EAEAEF] bg-white text-[#4C5264] hover:border-[#7C5CFC] hover:text-[#7C5CFC] cursor-pointer shrink-0 transition-colors"
                      >
                        回滚
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
