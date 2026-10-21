import { isNearBottom } from '../stickBottom';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { api, ApiError, getIsAdmin } from '../api';
import MaintenanceBanner from '../components/MaintenanceBanner';
import { maintenanceView } from '../maintenance';
import { type Artifact, ArtifactContext } from '../artifacts';
import EphemeralBanner, { EphemeralBadge } from '../components/EphemeralBanner';
import { isEphemeralId, isRemoteProviderUrl } from '../ephemeral';
import { endEphemeral } from '../ephemeralActions';
import { setDevice, useDevice } from '../deviceSettings';
import { confirmDialog } from '../ui/confirm';
import ArtifactPanel from '../components/ArtifactPanel';
import CodePreviewPanel from '../components/CodePreviewPanel';
import { useCodePreviewFs } from '../useCodePreview';
import { isPinned, regenerate, sendUser, setPinned, switchBranch } from '../chatActions';
import { AttachButton, AttachChips } from '../components/AttachmentBar';
import { useChips, getChips, readyAttachmentIds, sendAccepted, setVisionOverrides, stageSendAttachments } from '../attachmentState';
import { canSendAttachments, codeSendBlocked } from '../attachments';
import { wsSend } from '../socket';
import { useDraftText } from '../drafts';
import { onRestoreDraft } from '../contextState';
import { onComposerInsert, takePendingInsert } from '../tips/composerBus';
import ContextBar, { OverflowBanner } from '../components/ContextBar';
import { ModelLoadStatus, useModelLoadBusy } from '../components/ModelLoadStatus';
import CheckpointsBar from '../components/CheckpointsBar';
import { ApprovalModeSwitch, FullAccessDialog, useApprovalMode } from '../components/ApprovalModeSwitch';
import { approvalModeOfAction } from '../approvalMode';
import { isAgentBridgeKind } from '../codeGroups';
import { takePendingCodeStart } from '../vscodeBridge';
import LatencyBadge from '../components/LatencyBadge';
import DebugSheet from '../components/DebugSheet';
import type { DebugTab } from '../components/DebugSheet';
import EffortChip from '../components/EffortChip';
import SearchChip from '../components/SearchChip';
import ComposerDevChips from '../components/ComposerDevChips';
import Icon from '../components/Icon';
import MessageView from '../components/MessageView';
import PetOverlay from '../components/PetOverlay';
import SlashMenu from '../components/SlashMenu';
import SystemCard from '../components/SystemCard';
import { useMessageJump } from '../components/useMessageJump';
import ModelPicker, { modelLabel, selectedModelInfo, useModelGroups } from '../ModelPicker';
import type { Effort, Message, ResponseFormat, SearchMode } from '../protocol';
import type { SysCard } from '../slashCards';
import { isTypedCommand, parseSlashCommand } from '../slashCommands';
import type { ModelCandidate, ParsedSlash } from '../slashCommands';
import { runSlashCommand, takeCarriedChat } from '../slashRun';
import { activeProviders, applyUpsert, destroyEphemeralLocal, noteMaintenanceBlocked, setLastSel, useStore } from '../store';
import type { ModelSel } from '../store';
import { useT } from '../i18n';
import { useAppearance, useTheme, useThemeDef } from '../theme';
import { Brackets, FourStar } from '../ui/decor';
import { pressStyle, Tag } from '../ui/skin';
import EmptyHint from '../components/EmptyHint';
import FirstRunCard from '../components/FirstRunCard';
import { buildTree, siblingsOf, visiblePath } from '../tree';
import { buildSlashEntries, extractVars, fillVars, filterSlash, searchModeOf } from '../templates';
import type { SlashEntry } from '../templates';
import { Btn, Field, Sheet, useV3, webNoOutline } from '../ui/kit';
import WorkspacePicker from '../components/WorkspacePicker';
import { useBridges } from '../useBridges';
import { changeDevice, codeDevices, cwdToSend, pickerAvailable, workspaceOptions } from '../codeWorkspace';
import type { WorkspaceChoice } from '../codeWorkspace';
import { toast } from '../ui/toast';
import { useLayoutEpoch } from '../ui/layoutEpoch';
import { BACK_PRIORITY } from '../backHandler';
import { useBack } from '../ui/useBack';
import { createFreshTracker } from '../ui/msgFresh';

interface Props {
  convId: string; // may be a draft id not yet on the server
  /** project a not-yet-created conversation will belong to */
  draftProjectId: string | null;
  /** chat / code of a not-yet-created conversation */
  draftMode?: 'chat' | 'code';
  showMenu: boolean;
  onMenu: () => void;
  onCreated: (id: string) => void;
  onSettings: () => void;
  /** slash action `/new`: start a fresh chat */
  onNewChat: () => void;
  /** slash action /usage card button and the usage command: open the Usage screen */
  onOpenUsage: () => void;
  /** opens Settings > Models (the first-run card); falls back to onSettings */
  onOpenModels?: () => void;
}

export default function ChatScreen({ convId, draftProjectId, draftMode = 'chat', showMenu, onMenu, onCreated, onSettings, onNewChat, onOpenUsage, onOpenModels }: Props) {
  const t = useTheme();
  const th = useThemeDef();
  const themed = th.def.id !== 'simple';
  const ef = th.def.variants.tabs === 'tag';
  const pillSend = th.def.variants.button === 'pill';
  const { messageWidth } = useAppearance();
  const tr = useT();
  const v3 = useV3();
  const conv = useStore((s) => s.conversations[convId]);
  /** maintenance mode: banner always; a general user's send is blocked (an admin's is not) */
  const maintView = maintenanceView(useStore((s) => s.maintenance), getIsAdmin() === true);
  /** ephemeral chat: nothing is kept (see docs/EPHEMERAL.md); id prefix eph_ */
  const eph = isEphemeralId(convId);
  const ephBannerSeen = useDevice((s) => s.ephemeralBannerSeen);
  const msgMap = useStore((s) => s.messages[convId]);
  const providersMap = useStore((s) => s.providers);
  const projectsMap = useStore((s) => s.projects);
  const templatesMap = useStore((s) => s.templates);
  const connected = useStore((s) => s.connected);
  const lastSel = useStore((s) => s.lastSel);
  const providers = useMemo(() => activeProviders(providersMap), [providersMap]);
  const projectId = conv ? conv.projectId ?? null : draftProjectId;
  const project = projectId ? projectsMap[projectId] : undefined;

  const tree = useMemo(() => buildTree(Object.values(msgMap || {}).filter((m) => !(m as any).deleted)), [msgMap]);
  const path = useMemo(() => visiblePath(tree, conv?.headId), [tree, conv?.headId]);
  const streaming = tree.list.find((m) => m.status === 'streaming' && m.role === 'assistant');

  const [text, setText] = useDraftText(convId, !!conv);
  const settings = useStore((s) => s.settings);
  const chipCount = useChips().length;
  // v7 attachments: the per-model image overrides follow the server settings
  useEffect(() => { setVisionOverrides(settings?.modelVision); }, [settings?.modelVision]);
  const idleMinutes = settings?.ephemeralIdleMinutes ?? 30;
  const [err, setErr] = useState('');
  const [pending, setPending] = useState<ModelSel | null>(null);
  const [oneShot, setOneShot] = useState<Effort | null>(null);
  const [draftEffort, setDraftEffort] = useState<Effort | null>(null);
  const [draftSearch, setDraftSearch] = useState<SearchMode | null>(null);
  const [oneShotRF, setOneShotRF] = useState<ResponseFormat | null>(null);
  const [debug, setDebug] = useState<{ id: string; tab: DebugTab } | null>(null);
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const artifactCtx = useMemo(() => ({ open: setArtifact }), []);
  const { width } = useWindowDimensions();
  const wide = width >= 900;
  // foldables: after a fold/unfold the native layout of some rows can stay computed for the old size; remount the list once the size settles
  const layoutEpoch = useLayoutEpoch(width);
  const panelWidth = Math.min(640, Math.max(380, Math.round(width * 0.44)));
  const { groups } = useModelGroups();
  const scroller = useRef<ScrollView>(null);
  /** true while the user is at/near the bottom; scrolling up pauses auto-follow during streaming */
  const stick = useRef(true);
  useEffect(() => { stick.current = true; }, [convId]);
  useEffect(() => { if (path[path.length - 1]?.role === 'user') stick.current = true; }, [path.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const jump = useMessageJump({ convId, path, tree, scroller });
  /** which messages arrived while this chat was open (entry animation; see ui/msgFresh.ts) */
  const freshTracker = useRef(createFreshTracker()).current;

  const textRef = useRef(text);
  textRef.current = text;
  useEffect(() => onRestoreDraft((cid, content) => { if (cid === convId && !textRef.current.trim()) setText(content); }), [convId, setText]);
  // Tips sheet "Insert into message box": an empty or slash-only draft is replaced, other text is kept after the insert
  useEffect(() => {
    const apply = (s: string) => { const cur = textRef.current; setText(!cur.trim() || cur.startsWith('/') ? s : s + cur); };
    const pending = takePendingInsert();
    if (pending !== null) apply(pending);
    return onComposerInsert(apply);
  }, [setText]);
  useEffect(() => { setErr(''); setPending(null); setOneShot(null); setDraftEffort(null); setDraftSearch(null); setOneShotRF(null); }, [convId]);
  // a /clear carries search mode and effort into the new draft (declared after the reset above, so it wins)
  useEffect(() => {
    const carry = takeCarriedChat();
    if (carry && !conv) { setDraftSearch(carry.search); setDraftEffort(carry.effort); }
  }, [convId]);
  useEffect(() => { setArtifact(null); }, [convId]);
  // Code preview: hook stays above every early return (lint:hooks).
  const [previewOpen, setPreviewOpen] = useState(false);
  const codePreview = useCodePreviewFs(convId, previewOpen);
  useEffect(() => { setPreviewOpen(false); }, [convId]);

  // slash command result cards: local only, newest last, at most 4; cleared when the chat changes
  const [cardState, setCardState] = useState<{ cid: string; list: SysCard[] }>({ cid: convId, list: [] });
  useEffect(() => { setCardState({ cid: convId, list: [] }); }, [convId]);
  const cards = cardState.cid === convId ? cardState.list : [];
  const [pickerToken, setPickerToken] = useState(0);
  const approvalCtl = useApprovalMode(conv);

  const sel: ModelSel | null = useMemo(() => {
    if (conv) return conv.providerId ? { providerId: conv.providerId, model: conv.model } : null;
    if (pending) return pending;
    if (project?.defaultProviderId && providers.some((p) => p.id === project.defaultProviderId)) {
      return { providerId: project.defaultProviderId, model: project.defaultModel };
    }
    if (!conv && draftMode === 'code') {
      const bridge = providers.find((p) => isAgentBridgeKind(p.kind));
      if (bridge) {
        const g = groups?.find((x) => x.providerId === bridge.id);
        return { providerId: bridge.id, model: g?.defaultModel ?? g?.models[0]?.id ?? (bridge.model || null) };
      }
    }
    const lastP = lastSel ? providers.find((p) => p.id === lastSel.providerId) : undefined;
    if (lastSel && lastP && (draftMode === 'code') === isAgentBridgeKind(lastP.kind)) return lastSel;
    const p = (draftMode === 'code' ? providers[0] : providers.find((x) => !isAgentBridgeKind(x.kind))) ?? providers[0];
    if (!p) return null;
    const g = groups?.find((x) => x.providerId === p.id);
    return { providerId: p.id, model: g?.defaultModel ?? g?.models[0]?.id ?? (p.model || null) };
  }, [conv, pending, project, lastSel, providers, groups, draftMode]);
  const provider = providers.find((p) => p.id === sel?.providerId) || null;
  // Code: device badge and the workspace picker of a new chat (docs/design/CODE-WORKSPACES.md)
  const isCode = conv ? conv.mode === 'code' : draftMode === 'code';
  const bridges = useBridges(isCode);
  const convsMap = useStore((s) => s.conversations);
  const devices = useMemo(() => codeDevices(providers, bridges), [providers, bridges]);
  const device = devices.find((d) => d.providerId === sel?.providerId);
  const wsOptions = useMemo(
    () => (isCode && device ? workspaceOptions(device.name, bridges, Object.values(convsMap), providersMap, device.kind) : []),
    [isCode, device, bridges, convsMap, providersMap],
  );
  const [draftCwd, setDraftCwd] = useState<string | null>(null);
  useEffect(() => { setDraftCwd(null); }, [convId]);
  // Code tab "VS Code" section: a tapped workspace starts this draft on that PC (vscode-bridge provider) in that folder
  useEffect(() => {
    if (conv || draftMode !== 'code') return;
    const start = takePendingCodeStart();
    if (!start) return;
    const p = providers.find((x) => x.id === start.providerId);
    if (!p) return;
    setPending({ providerId: p.id, model: p.model || null });
    setDraftCwd(start.cwd);
  }, [convId]); // eslint-disable-line react-hooks/exhaustive-deps
  /** an ephemeral chat sent to a provider outside the local network: the provider may keep the text */
  // a shared provider has no URL here: it runs on the server for someone else, so it counts as remote
  const ephRemote = eph && !!provider && (provider.baseUrl ? isRemoteProviderUrl(provider.baseUrl) : provider.readOnly === true);
  const linear = isAgentBridgeKind(provider?.kind);
  const canBranch = v3 && !linear;
  const unsupported = selectedModelInfo(groups, sel, provider?.model)?.effort === 'unsupported';
  const chatEffort = conv ? conv.effort ?? null : draftEffort;

  /** picking another PC for a new Code chat: its default model; the folder stays only if that PC offers it */
  const chooseDevice = (providerId: string) => {
    const p = providers.find((x) => x.id === providerId);
    const g = groups?.find((x) => x.providerId === providerId);
    const d = devices.find((x) => x.providerId === providerId);
    const opts = d ? workspaceOptions(d.name, bridges, Object.values(convsMap), providersMap, d.kind) : [];
    const next: WorkspaceChoice = changeDevice({ providerId: sel?.providerId ?? null, cwd: draftCwd }, providerId, opts);
    setDraftCwd(next.cwd);
    void choose({ providerId, model: g?.defaultModel ?? g?.models[0]?.id ?? (p?.model || null) });
  };

  const choose = async (next: ModelSel) => {
    setLastSel(next);
    if (!conv) { setPending(next); return; }
    try {
      applyUpsert({ conversations: [await api.putConversation(convId, { providerId: next.providerId, model: next.model })] });
    } catch (e: any) { setErr(e.message); }
  };

  const pinEffort = async (e: Effort | null) => {
    if (!conv) { setDraftEffort(e); return; }
    try { applyUpsert({ conversations: [await api.putConversation(convId, { effort: e })] }); } catch (x: any) { toast(x.message || tr('chat.effortSaveFailed'), 'error'); }
  };

  const chatSearch: SearchMode | null = conv ? conv.searchMode ?? null : draftSearch;
  const pinSearch = async (m: SearchMode | null) => {
    if (!conv) { setDraftSearch(m); return; }
    try { applyUpsert({ conversations: [await api.putConversation(convId, { searchMode: m })] }); } catch (x: any) { toast(x.message || tr('chat.searchSaveFailed'), 'error'); }
  };

  /** Creates the draft conversation on the server. Returns false when an ephemeral chat was not created as ephemeral (nothing may be sent). */
  const ensureConv = async (): Promise<boolean> => {
    if (conv) return true;
    const body: any = { providerId: sel?.providerId ?? null, model: sel?.model ?? null, mode: draftMode };
    if (v3 && draftProjectId) body.projectId = draftProjectId;
    if (v3 && draftEffort) body.effort = draftEffort;
    if (v3 && draftSearch) body.searchMode = draftSearch;
    if (eph) body.ephemeral = true;
    const created = await api.putConversation(convId, body);
    if (eph && created.ephemeral !== true) {
      // the server did not keep it ephemeral: never send into it; drop it everywhere and leave
      api.endEphemeral(convId).catch(() => {});
      destroyEphemeralLocal(convId);
      toast(tr('eph.gone'), 'error');
      onNewChat();
      return false;
    }
    applyUpsert({ conversations: [created] });
    onCreated(convId);
    return true;
  };

  /** regenerate of an assistant message (MessageView's button and /retry) */
  const regenerateFrom = (m: Message) => {
    const e = regenerate({ convId, message: m, tree, effort: unsupported ? null : oneShot, responseFormat: oneShotRF });
    if (e) setErr(e); else { setOneShot(null); setOneShotRF(null); }
  };
  const modelCandidates = useMemo<ModelCandidate[]>(
    () => (groups || []).flatMap((g) => g.models.map((m) => ({ providerId: g.providerId, model: m.id, label: `${g.providerName}: ${m.name}` }))),
    [groups],
  );
  const pushCard = (card: SysCard) => setCardState((s) => ({ cid: convId, list: [...(s.cid === convId ? s.list : []), card].slice(-4) }));
  const replaceCard = (id: string, card: SysCard) => setCardState((s) => ({ cid: s.cid, list: s.list.map((c) => (c.id === id ? card : c)) }));
  const dismissCard = (id: string) => setCardState((s) => ({ cid: s.cid, list: s.list.filter((c) => c.id !== id) }));
  /** runs a slash command locally; its text is never sent to the model */
  const runSlash = (cmd: ParsedSlash) => runSlashCommand(cmd, {
    convId, conv, eph, mode: conv?.mode ?? draftMode, streaming: !!streaming, tr, settings, sel,
    modelName: sel ? modelLabel(groups, sel, provider?.model) || null : null,
    chatSearch, chatEffort, candidates: modelCandidates, path, regenerate: regenerateFrom,
    pushCard, replaceCard, newChat: onNewChat, openUsage: onOpenUsage, chooseModel: choose, pinEffort,
    setPinned, openModelPicker: () => setPickerToken((n) => n + 1),
    putTitle: async (title) => { applyUpsert({ conversations: [await api.putConversation(convId, { title })] }); },
  });

  const loadBusy = useModelLoadBusy(convId);
  // Code conversations: images and audio are not sent (docs/design/ATTACHMENTS.md, "Code / DSH での添付").
  const attachCode = conv ? conv.mode === 'code' : draftMode === 'code';
  const send = async () => {
    // a slash command runs first (the send button and Enter both come here); unknown '/xxx' stays normal text
    const cmd = parseSlashCommand(text);
    if (cmd) { setText(''); await runSlash(cmd); return; }
    const content = text.trim();
    const atts = readyAttachmentIds();
    if ((!content && !atts.length) || streaming || loadBusy || maintView.blocksSend || !canSendAttachments(getChips()) || codeSendBlocked(getChips(), attachCode)) return;
    setErr('');
    try {
      if (!(await ensureConv())) return;
      stageSendAttachments(atts);
      const cwd = !conv ? cwdToSend({ providerId: sel?.providerId ?? null, cwd: draftCwd }, device, wsOptions) : undefined;
      const e = sendUser({ convId, content, lastVisibleId: path.length ? path[path.length - 1].id : null, effort: unsupported ? null : oneShot, responseFormat: oneShotRF, ...(cwd ? { cwd } : {}) });
      if (e) { stageSendAttachments([]); setErr(e); return; }
      sendAccepted();
      setText('');
      setOneShot(null);
      setOneShotRF(null);
    } catch (e: any) {
      if (eph && e instanceof ApiError && e.status === 429) { toast(tr('eph.limit'), 'error'); return; }
      // refused by maintenance mode (HTTP 503): the banner shows it; the text stays in the composer
      if (e instanceof ApiError && e.code === 'maintenance') { noteMaintenanceBlocked(e.message); return; }
      // PROTOCOL-v7: the model is not allowed for this user; the text stays in the composer
      if (e instanceof ApiError && e.code === 'model_not_allowed') { toast(tr('shared.modelNotAllowed'), 'error'); return; }
      setErr(e.message || String(e));
    }
  };

  /** "End and delete": erases the ephemeral chat on the server and in memory, then starts a fresh normal chat. */
  const endChat = async () => {
    if (!(await confirmDialog(tr('eph.endConfirmTitle'), tr('eph.endConfirmBody'), tr('eph.endConfirmOk')))) return;
    try { await endEphemeral(convId); } catch (e: any) { toast(e?.message || tr('eph.gone'), 'error'); }
    onNewChat();
  };

  const sendLabel = streaming ? tr('common.stop') : tr('common.send');
  const stop = () => { if (streaming && !wsSend({ type: 'stop', messageId: streaming.id })) toast(tr('chat.notConnected'), 'error'); };
  const last = path.length ? path[path.length - 1] : null;

  // ---- slash menu: composer text that starts with '/' (single line) ----
  const [slashIdx, setSlashIdx] = useState(0);
  /** composer text the menu was closed with Escape for; the menu reopens once the text changes */
  const [slashDismissed, setSlashDismissed] = useState<string | null>(null);
  const [varForm, setVarForm] = useState<{ body: string; vars: string[]; values: Record<string, string> } | null>(null);
  const slashQuery = text.startsWith('/') && !text.includes('\n') ? text.slice(1) : null;
  const slashMode = conv?.mode ?? draftMode;
  const allSlash = useMemo(() => buildSlashEntries(Object.values(templatesMap || {}), projectId, tr, { mode: slashMode, ephemeral: eph }), [templatesMap, projectId, tr, slashMode, eph]);
  const slashEntries = useMemo(() => (slashQuery === null ? [] : filterSlash(allSlash, slashQuery)), [allSlash, slashQuery]);
  const slashOpen = slashEntries.length > 0 && slashDismissed !== text;
  useBack(!!artifact, BACK_PRIORITY.PANEL, () => { setArtifact(null); });
  useBack(slashOpen, BACK_PRIORITY.SLASH, () => { setSlashDismissed(text); });
  const slashSel = Math.min(slashIdx, Math.max(0, slashEntries.length - 1));
  useEffect(() => { setSlashIdx(0); }, [slashQuery]);

  const runAction = (id: string) => {
    setText('');
    if (id === 'new_session') { onNewChat(); return; }
    const mode = searchModeOf(id);
    if (mode) { void pinSearch(mode); toast(tr('chat.searchSet', { mode }), 'ok'); return; }
    // ask|rules are older names of manual|auto
    const am = approvalModeOfAction(id);
    if (am) approvalCtl.requestMode(am);
  };

  const pickSlash = (e: SlashEntry) => {
    setSlashDismissed(null);
    if (e.kind === 'action') { runAction(e.body); return; }
    if (e.kind === 'command' && e.command) {
      // with an argument the command is inserted for the user to finish; otherwise it runs now
      if (e.argHint) { setText(`/${e.command} `); return; }
      setText('');
      void runSlash({ name: e.command, arg: '' });
      return;
    }
    const vars = extractVars(e.body);
    if (vars.length === 0) { setText(e.body); return; }
    setVarForm({ body: e.body, vars, values: {} });
  };

  const insertVars = () => {
    if (!varForm) return;
    setText(fillVars(varForm.body, varForm.values));
    setVarForm(null);
  };

  // IME: the Enter that confirms a conversion must not send. Safari/WebKit (Mac) fires compositionend before the key event, so isComposing is already false there.
  const imeEnd = useRef(0);
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const end = () => { imeEnd.current = Date.now(); };
    document.addEventListener('compositionend', end, true);
    return () => document.removeEventListener('compositionend', end, true);
  }, []);

  const onKeyPress = (e: any) => {
    if (Platform.OS !== 'web') return;
    const k = e.nativeEvent.key;
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229 || (k === 'Enter' && Date.now() - imeEnd.current < 150)) return;
    const shift = e.nativeEvent.shiftKey;
    // the menu takes these keys before the Enter-to-send logic below
    if (slashOpen) {
      if (k === 'ArrowDown' || k === 'ArrowUp') {
        e.preventDefault?.();
        const n = slashEntries.length;
        setSlashIdx((slashSel + (k === 'ArrowDown' ? 1 : n - 1)) % n);
        return;
      }
      if (k === 'Escape') { e.preventDefault?.(); setSlashDismissed(text); return; }
      // Enter after a typed command ('/usage week') sends it as typed instead of re-picking the menu entry
      if (k === 'Tab' || (k === 'Enter' && !shift && !isTypedCommand(text))) { e.preventDefault?.(); pickSlash(slashEntries[slashSel]); return; }
    }
    if (k === 'Enter' && !shift) {
      e.preventDefault?.();
      send();
    }
  };

  // Panel "Use in chat": append to the composer draft; on narrow screens the overlay closes so the composer is visible.
  const useInChat = (txt: string) => {
    setText(text.trim() ? text + '\n\n' + txt : txt);
    if (!wide) setArtifact(null);
  };

  freshTracker.observe(convId, path.map((m) => ({ id: m.id, createdAt: m.createdAt })));

  return (
    <ArtifactContext.Provider value={artifactCtx}>
    <View style={[styles.root, { flexDirection: 'row' }]}>
    <View style={[styles.root, { backgroundColor: 'transparent' }]}>
      <View style={[styles.header, { borderColor: t.border }]}>
        {showMenu && (
          <Pressable onPress={onMenu} hitSlop={8} accessibilityLabel={tr('chat.openConversations')}>
            <Icon name="menu" size={24} color={t.text} />
          </Pressable>
        )}
        <View style={[{ flex: 1 }, themed && { flexDirection: 'row', alignItems: 'center', gap: 8 }]}>
          {themed && ef && wide && <Tag>{tr(conv?.mode === 'code' ? 'sidebar.mode.code' : 'sidebar.mode.chat')}</Tag>}
          {themed && !ef && th.fx && <FourStar size={12} color={t.accent} />}
          <Text numberOfLines={1} style={[styles.title, { color: t.text }, themed && { flexShrink: 1 }]}>{eph ? tr('eph.title') : conv?.title || tr('sidebar.newChat')}</Text>
          {!!project && <Text numberOfLines={1} style={{ color: t.sub, fontSize: 11 }}>{project.name}</Text>}
          {isCode && devices.length > 1 && !!device && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }} accessibilityLabel={`${device.name} ${tr(device.online ? 'code.device.online' : 'code.device.offline')}`}>
              <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: device.online ? t.accent : t.border }} />
              <Text numberOfLines={1} style={{ color: t.sub, fontSize: 11 }}>{device.name}</Text>
            </View>
          )}
        </View>
        {eph && <EphemeralBadge compact={!wide} />}
        {v3 && conv && !eph && (
          <Pressable
            onPress={async () => { try { await setPinned(convId, !isPinned(conv)); } catch (x: any) { toast(x.message || tr('chat.pinFailed'), 'error'); } }}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={isPinned(conv) ? tr('chat.unpin') : tr('chat.pin')}
            accessibilityState={{ checked: isPinned(conv) }}
          >
            <Icon name="pin" size={20} color={isPinned(conv) ? t.accentInk : t.sub} />
          </Pressable>
        )}
        {conv?.mode === 'code' && !eph && codePreview.entries.length > 0 && (
          <Pressable
            onPress={() => { setArtifact(null); setPreviewOpen(true); }}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={tr('code.preview.button')}
          >
            <Text style={{ color: t.accent, fontSize: 13, fontWeight: '600' }}>{tr('code.preview.button')}</Text>
          </Pressable>
        )}
        <LatencyBadge />
        <ModelPicker
          sel={sel}
          providerName={provider?.name || ''}
          fallbackModel={provider?.model}
          hasProviders={providers.length > 0}
          onSelect={choose}
          onAddProvider={onSettings}
          codeMode={conv ? conv.mode === 'code' : draftMode === 'code'}
          openToken={pickerToken}
        />
      </View>
      {conv?.mode === 'code' && !eph && <ApprovalModeSwitch conv={conv} busy={approvalCtl.busy} onSelect={approvalCtl.requestMode} />}
      <FullAccessDialog state={approvalCtl.dialog} onToggle={approvalCtl.toggleCheck} onCancel={approvalCtl.cancel} onConfirm={approvalCtl.confirm} />
      {maintView.show && <MaintenanceBanner view={maintView} />}
      {eph && (
        <View style={[styles.ephBar, { borderColor: t.border }]}>
          {ephRemote && <Text style={[styles.ephWarn, { color: t.warn }]}>{tr('eph.remoteWarn')}</Text>}
          <View style={{ flex: 1 }} />
          <Btn small danger label={tr('eph.end')} onPress={endChat} />
        </View>
      )}
      {eph && !ephBannerSeen && <EphemeralBanner minutes={idleMinutes} onDismiss={() => setDevice({ ephemeralBannerSeen: true })} />}
      {jump.banner}
      <ScrollView
        key={`list-${layoutEpoch}`}
        ref={scroller}
        style={{ flex: 1 }}
        contentContainerStyle={[styles.list, { maxWidth: messageWidth }]}
        scrollEventThrottle={50}
        onScroll={(e) => {
          const n = e.nativeEvent;
          stick.current = isNearBottom({ contentOffsetY: n.contentOffset.y, contentHeight: n.contentSize.height, layoutHeight: n.layoutMeasurement.height });
        }}
        onContentSizeChange={() => { if (!jump.active && stick.current) scroller.current?.scrollToEnd({ animated: false }); }}
        onLayout={() => { if (!jump.active && stick.current) scroller.current?.scrollToEnd({ animated: false }); }}
      >
        {path.length === 0 && providers.length === 0 && connected && !conv ? (
          <FirstRunCard onOpenModels={onOpenModels ?? onSettings} />
        ) : path.length === 0 && (
          <EmptyHint text={connected ? tr('chat.startHint') : tr('chat.connecting')} />
        )}
        {path.map((m, i) => {
          const sibs = siblingsOf(tree, m.id);
          const idx = sibs.indexOf(m.id);
          return jump.wrap(m.id, (
            <MessageView
              key={m.id}
              m={m}
              sibIndex={idx + 1}
              sibTotal={canBranch ? sibs.length : 1}
              onSwitch={(d) => { const target = sibs[idx + d]; if (target) switchBranch(convId, tree, target); }}
              canBranch={canBranch}
              busy={!!streaming}
              onRegenerate={() => regenerateFrom(m)}
              onEditResend={(content) => {
                if (maintView.blocksSend) return;
                const e = sendUser({ convId, content, parentId: tree.parent.get(m.id) ?? null, effort: unsupported ? null : oneShot, responseFormat: oneShotRF });
                if (e) setErr(e); else { setOneShot(null); setOneShotRF(null); }
              }}
              onDebug={(tab) => setDebug({ id: m.id, tab })}
              late={freshTracker.isLate(m.id, m.createdAt)}
            />
          ));
        })}
        {cards.map((c) => (
          <SystemCard key={c.id} card={c} onDismiss={() => dismissCard(c.id)} onOpenUsage={onOpenUsage} />
        ))}
      </ScrollView>
      {!connected && (
        <Text style={[styles.err, { color: t.sub, fontSize: 12 }]}>{tr('chat.disconnected')}</Text>
      )}
      <OverflowBanner />
      {!!err && <Text style={[styles.err, { color: t.danger }]}>{err}</Text>}
      {maintView.blocksSend && <Text accessibilityRole="alert" style={[styles.err, { color: t.warn }]}>{tr('maint.sendBlocked')}</Text>}
      {conv?.mode === 'code' && <CheckpointsBar key={convId} convId={convId} />}
      <ModelLoadStatus conversationId={convId} />
      <View style={[styles.composer, { borderColor: t.border, maxWidth: messageWidth }]}>
        {v3 && (
          <ContextBar
            args={{
              v3, convId, convExists: !!conv, providerId: sel?.providerId ?? null, model: sel?.model ?? null, effort: oneShot ?? chatEffort,
              draft: text, headKey: last ? last.id + ':' + last.status : '', streaming: !!streaming,
              local: {
                settings, projectPrompt: project?.systemPrompt, providerId: sel?.providerId ?? null, model: sel?.model ?? null,
                backendLimit: selectedModelInfo(groups, sel, provider?.model)?.state?.contextLength ?? null, draft: text,
              },
            }}
          />
        )}
        {v3 && (
          <View style={{ paddingHorizontal: 10, paddingTop: 8, flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <EffortChip oneShot={oneShot} chat={chatEffort} unsupported={unsupported} onOneShot={setOneShot} onPin={pinEffort} />
            <SearchChip chat={chatSearch} project={project?.searchMode} onPin={pinSearch} />
            <ComposerDevChips oneShot={oneShotRF} onOneShot={setOneShotRF} draft={text} providerId={sel?.providerId} model={sel?.model ?? provider?.model} />
          </View>
        )}
        {!conv && !eph && draftMode === 'code' && (
          <WorkspacePicker
            devices={devices}
            providerId={sel?.providerId ?? null}
            onDevice={chooseDevice}
            showWorkspaces={pickerAvailable(device) && wsOptions.length > 0}
            options={wsOptions}
            cwd={draftCwd}
            onCwd={setDraftCwd}
          />
        )}
        {slashOpen && <SlashMenu entries={slashEntries} active={slashSel} onPick={pickSlash} />}
        <AttachChips providerId={sel?.providerId} model={sel?.model ?? provider?.model} listed={selectedModelInfo(groups, sel, provider?.model)?.vision} codeMode={attachCode} />
        <View style={styles.inputBar}>
          <AttachButton codeMode={attachCode} />
          <View style={{ flex: 1 }}>
            <TextInput
              style={[styles.input, { color: t.text, borderColor: themed ? t.borderStrong : t.border, backgroundColor: t.input, borderRadius: th.def.variants.button === 'pill' ? th.r(18) : th.r(12) }, webNoOutline]}
              value={text}
              onChangeText={setText}
              onKeyPress={onKeyPress}
              placeholder={tr('chat.placeholder')}
              placeholderTextColor={t.sub}
              multiline
            />
            <Brackets inset={3} />
          </View>
          <Pressable
            onPress={streaming ? stop : send}
            disabled={!streaming && (loadBusy || maintView.blocksSend)}
            accessibilityRole="button"
            accessibilityLabel={sendLabel}
            {...({ title: sendLabel } as any)}
            style={({ pressed }: any) => [
              styles.send, { backgroundColor: streaming ? t.danger : t.accent, opacity: !streaming && (!text.trim() && !chipCount || loadBusy || maintView.blocksSend) ? 0.5 : 1, borderRadius: themed ? 22 : th.r(12) },
              // Frontier: round icon button = thin ring on a dark disc; the ring turns accent when there is something to send
              ef && !streaming && { backgroundColor: t.panel, borderWidth: 1, borderColor: text.trim() ? t.accentInk : t.borderStrong, opacity: 1 },
              ef && streaming && { borderWidth: 1, borderColor: t.borderStrong },
              // Astral: white pill (dark brown on light) with the icon
              pillSend && !streaming && { width: 58, backgroundColor: th.dark ? '#ffffff' : '#564e45' },
              pressStyle(th, pressed),
            ]}
          >
            {ef && !streaming && <View pointerEvents="none" style={[styles.ring, { borderColor: t.border }]} />}
            <Icon name={streaming ? 'stop' : 'send'} size={22} color={streaming ? '#fff' : ef ? (text.trim() ? t.accentInk : t.sub) : pillSend ? (th.dark ? '#2a2827' : '#ffffff') : t.accentText} />
          </Pressable>
        </View>
      </View>
      <Sheet
        visible={!!varForm}
        onClose={() => setVarForm(null)}
        title={tr('chat.variables')}
        width={440}
        footer={<><Btn label={tr('chat.insert')} primary onPress={insertVars} /><Btn label={tr('common.cancel')} onPress={() => setVarForm(null)} /></>}
      >
        {varForm?.vars.map((v, i) => (
          <Field
            key={v}
            label={v}
            value={varForm.values[v] ?? ''}
            autoFocus={i === 0}
            onChangeText={(x) => setVarForm((f) => (f ? { ...f, values: { ...f.values, [v]: x } } : f))}
            onSubmit={insertVars}
          />
        ))}
      </Sheet>
      <DebugSheet messageId={debug?.id ?? null} tab={debug?.tab ?? 'final'} metrics={debug ? msgMap?.[debug.id]?.metrics : null} onClose={() => setDebug(null)} />
      <View pointerEvents="box-none" style={{ position: 'absolute', right: 12, bottom: 110 }}>
        <PetOverlay convId={convId} />
      </View>
    </View>
    {artifact && wide ? (
      <View style={[styles.side, { width: panelWidth, borderLeftColor: t.border, backgroundColor: t.bg }]}>
        <ArtifactPanel artifact={artifact} onClose={() => setArtifact(null)} onUseInChat={useInChat} />
      </View>
    ) : null}
    {artifact && !wide ? (
      <View style={[StyleSheet.absoluteFill, styles.overlay, { backgroundColor: t.bg }]}>
        <ArtifactPanel artifact={artifact} onClose={() => setArtifact(null)} onUseInChat={useInChat} />
      </View>
    ) : null}
    {previewOpen && wide ? (
      <View style={[styles.side, { width: panelWidth, borderLeftColor: t.border, backgroundColor: t.bg }]}>
        <CodePreviewPanel fs={codePreview.fs} entries={codePreview.entries} loading={codePreview.loading} source={codePreview.source} pcReason={codePreview.pcReason} pcLoading={codePreview.pcLoading} onRefresh={codePreview.refresh} onClose={() => setPreviewOpen(false)} />
      </View>
    ) : null}
    {previewOpen && !wide ? (
      <View style={[StyleSheet.absoluteFill, styles.overlay, { backgroundColor: t.bg }]}>
        <CodePreviewPanel fs={codePreview.fs} entries={codePreview.entries} loading={codePreview.loading} source={codePreview.source} pcReason={codePreview.pcReason} pcLoading={codePreview.pcLoading} onRefresh={codePreview.refresh} onClose={() => setPreviewOpen(false)} />
      </View>
    ) : null}
    </View>
    </ArtifactContext.Provider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  title: { fontSize: 16, fontWeight: '600' },
  ephBar: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10, paddingHorizontal: 14, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth },
  ephWarn: { flexShrink: 1, flexGrow: 1, minWidth: 160, fontSize: 12 },
  list: { padding: 14, gap: 6, width: '100%', alignSelf: 'center' },
  err: { paddingHorizontal: 14, paddingBottom: 4 },
  composer: { borderTopWidth: StyleSheet.hairlineWidth, width: '100%', alignSelf: 'center' },
  inputBar: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 10 },
  input: { borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, maxHeight: 160 },
  send: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  ring: { position: 'absolute', top: 3, left: 3, right: 3, bottom: 3, borderRadius: 19, borderWidth: 1 },
  side: { borderLeftWidth: StyleSheet.hairlineWidth, maxWidth: 640, minWidth: 380 },
  overlay: { zIndex: 100, elevation: 100 },
});
