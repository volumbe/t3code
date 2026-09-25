/**
 * A compact chat shown in the right panel ("dock") beside the main thread.
 *
 * It deliberately does not mount a second ChatView: ChatView owns window-level
 * shortcuts, terminal drawers, and route-driven draft promotion, all of which
 * assume one instance. The panel mounts the same ChatComposer as the main chat
 * through a slim host that derives its props for the dock thread, reads the same
 * server thread, and sends turns through the same commands, so the chat stays in
 * sync with its full view in the main area.
 */
import { useAtomValue } from "@effect/atom-react";
import { derivePendingRequests } from "@t3tools/client-runtime/pending-requests";
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  type ApprovalRequestId,
  type ChatFileAttachment,
  DEFAULT_MODEL,
  type KeybindingCommand,
  type ModelSelection,
  type ProviderApprovalDecision,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ScopedThreadRef,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import { serializeLegacyContextMessage } from "@t3tools/shared/composerContextLegacySend";
import { createModelSelection } from "@t3tools/shared/model";
import { projectScriptCwd } from "@t3tools/shared/projectScripts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useNavigate } from "@tanstack/react-router";
import { ExternalLinkIcon, MessageSquarePlusIcon } from "lucide-react";
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ComposerHandleContext } from "~/composerHandleContext";
import {
  type ComposerSubmissionIntent,
  parseStandaloneComposerSlashCommand,
} from "~/composer-logic";
import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  composerDraftHasUserContent,
  useComposerDraftStore,
} from "~/composerDraftStore";
import { useClientSettingsHydrated, useEnvironmentSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { resolveShortcutCommand } from "~/keybindings";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  releaseDraftAttachments,
  startAttachmentUpload,
} from "~/lib/attachmentUploadQueue";
import { deriveLatestContextWindowSnapshot } from "~/lib/contextWindow";
import { buildMessageContext, terminalContextReference } from "~/lib/composerContextRecords";
import {
  removeInlineContextReference,
  stripInlineContextReferences,
} from "~/lib/composerContextReferences";
import { clampFileAttachmentUploadBytes } from "@t3tools/client-runtime/state/attachments";
import type { TerminalContextDraft } from "~/lib/terminalContext";
import { newMessageId, newThreadId } from "~/lib/utils";
import { resolveAppModelSelectionForInstance } from "~/modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "~/providerInstances";
import { type ChatSurface, useRightPanelStore } from "~/rightPanelStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { type PendingUserInputDraftAnswer } from "~/pendingUserInput";
import { derivePhase, type PendingUserInput } from "~/session-logic";
import { useEnvironment } from "~/state/environments";
import { useThread, useThreadShell, useThreadShellsForProjectRefs } from "~/state/entities";
import { environmentServerConfigsAtom, primaryServerKeybindingsAtom } from "~/state/server";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { DEFAULT_INTERACTION_MODE, type Thread } from "~/types";
import { resolveThreadPlacement, useWorkModeStore } from "~/workModeStore";
import ChatMarkdown from "../ChatMarkdown";
import {
  buildRunningThreadTurnInterruptInput,
  cloneComposerImageForRetry,
  deriveComposerSendState,
  deriveLockedProvider,
  formatOutgoingPrompt,
  getStartedThreadModelChangeBlockReason,
  readFileAsDataUrl,
  resolveComposerInteractionMode,
  resolveComposerProviderSelection,
  resolveThreadMetadataUpdateForNextTurn,
} from "../ChatView.logic";
import { ChatComposer, type ChatComposerHandle } from "../chat/ChatComposer";
import type { ComposerBannerStackItem } from "../chat/ComposerBannerStack";
import { ComposerSurface } from "../chat/ComposerSurface";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "../chat/composerPromptHistory";
import {
  FOCUS_SCOPED_COMPOSER_COMMANDS,
  focusScopedComposerProps,
} from "../chat/composerEventScope";
import { ExpandedImageDialog } from "../chat/ExpandedImageDialog";
import { expandedImageKey, type ExpandedImagePreview } from "../chat/ExpandedImagePreview";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";

export interface DockChatDefaults {
  /** The host thread's model, used for a new chat when its project sets no default. */
  modelSelection: ModelSelection;
}

const MAX_RENDERED_MESSAGES = 200;
/** A chat created here exists on the client before the server records it; wait for its shell. */
const DOCK_THREAD_OPTIONS = { waitForShell: true } as const;
const TITLE_MAX_LENGTH = 60;
const STICK_TO_BOTTOM_THRESHOLD_PX = 48;
const EMPTY_PROVIDERS: ServerProvider[] = [];
const EMPTY_REQUEST_IDS: ApprovalRequestId[] = [];
// Stable empty props keep the memoized composer from re-rendering on every dock render.
const EMPTY_MESSAGES: Thread["messages"] = [];
const EMPTY_BANNER_ITEMS: ComposerBannerStackItem[] = [];
const EMPTY_PENDING_USER_INPUTS: PendingUserInput[] = [];
const EMPTY_PENDING_DRAFT_ANSWERS: Record<string, PendingUserInputDraftAnswer> = {};
const noop = () => {};

/** A short thread title from the first message, as the composer's first line. */
export function deriveDockChatTitle(text: string): string {
  const firstLine = text.trim().split("\n")[0]?.trim() ?? "";
  if (firstLine.length === 0) return "New chat";
  return firstLine.length > TITLE_MAX_LENGTH
    ? `${firstLine.slice(0, TITLE_MAX_LENGTH - 1).trimEnd()}…`
    : firstLine;
}

/** Other chats in the project, most recent first. The host thread is excluded. */
export function listDockChatCandidates(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  hostThreadRef: ScopedThreadRef,
): EnvironmentThreadShell[] {
  const recency = (thread: EnvironmentThreadShell) =>
    Date.parse(thread.latestUserMessageAt ?? thread.updatedAt) || 0;
  return threads
    .filter(
      (thread) =>
        thread.archivedAt === null &&
        !(
          thread.environmentId === hostThreadRef.environmentId &&
          thread.id === hostThreadRef.threadId
        ),
    )
    .toSorted((left, right) => recency(right) - recency(left));
}

function useProjectChatCandidates(
  project: EnvironmentProject,
  hostThreadRef: ScopedThreadRef,
): EnvironmentThreadShell[] {
  const projectRefs = useMemo(
    () => [scopeProjectRef(project.environmentId, project.id)],
    [project.environmentId, project.id],
  );
  const threads = useThreadShellsForProjectRefs(projectRefs);
  return useMemo(() => listDockChatCandidates(threads, hostThreadRef), [hostThreadRef, threads]);
}

export function DockChatPanel(props: {
  hostThreadRef: ScopedThreadRef;
  surface: ChatSurface;
  project: EnvironmentProject;
  defaults: DockChatDefaults;
}) {
  const { hostThreadRef, surface, project } = props;
  const candidates = useProjectChatCandidates(project, hostThreadRef);
  const composerRef = useRef<ChatComposerHandle | null>(null);
  const scrollNodeRef = useRef<HTMLDivElement | null>(null);
  const selectThread = useCallback(
    (threadId: string | null) =>
      useRightPanelStore.getState().setChatSurfaceThread(hostThreadRef, surface.id, threadId),
    [hostThreadRef, surface.id],
  );
  // Surfaces persisted before new chats reserved an id get one for this mount.
  const [fallbackDraftThreadId] = useState(newThreadId);
  const threadRef = useMemo(
    () =>
      surface.threadId === null
        ? null
        : scopeThreadRef(project.environmentId, ThreadId.make(surface.threadId)),
    [project.environmentId, surface.threadId],
  );
  const composerThreadId = ThreadId.make(
    surface.threadId ?? surface.draftThreadId ?? fallbackDraftThreadId,
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-dock-chat>
      <DockChatHeader threadRef={threadRef} />
      {threadRef ? (
        <DockChatTranscript
          threadRef={threadRef}
          cwd={project.workspaceRoot}
          scrollNodeRef={scrollNodeRef}
        />
      ) : (
        <DockChatPicker
          candidates={candidates}
          projectTitle={project.title}
          scrollNodeRef={scrollNodeRef}
          onNewChat={() => composerRef.current?.focusAtEnd()}
          onSelect={selectThread}
        />
      )}
      <DockChatComposer
        hostThreadRef={hostThreadRef}
        project={project}
        threadId={composerThreadId}
        isNewChat={threadRef === null}
        defaults={props.defaults}
        composerRef={composerRef}
        scrollNodeRef={scrollNodeRef}
        onThreadCreated={selectThread}
      />
    </div>
  );
}

function DockChatHeader(props: { threadRef: ScopedThreadRef | null }) {
  const navigate = useNavigate();
  const thread = useThread(props.threadRef, DOCK_THREAD_OPTIONS);
  const title = thread?.title ?? (props.threadRef ? "Loading…" : "New chat");
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/60 ps-3 pe-2">
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
      {props.threadRef ? (
        <Button
          aria-label="Open in main view"
          title="Open in main view"
          size="icon-xs"
          variant="ghost"
          onClick={() => {
            if (!props.threadRef) return;
            void navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(props.threadRef),
            });
          }}
        >
          <ExternalLinkIcon className="size-3.5" />
        </Button>
      ) : null}
    </div>
  );
}

function DockChatPicker(props: {
  candidates: ReadonlyArray<EnvironmentThreadShell>;
  projectTitle: string;
  scrollNodeRef: RefObject<HTMLDivElement | null>;
  onNewChat: () => void;
  onSelect: (threadId: string) => void;
}) {
  const { candidates, projectTitle, scrollNodeRef, onNewChat, onSelect } = props;
  return (
    <div ref={scrollNodeRef} className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
      <button
        type="button"
        className="flex h-9 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm font-medium hover:bg-accent/60"
        onClick={onNewChat}
      >
        <MessageSquarePlusIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">New chat</span>
        <span className="min-w-0 max-w-[45%] shrink truncate text-xs font-normal text-muted-foreground">
          {projectTitle}
        </span>
      </button>
      {candidates.length === 0 ? null : (
        <>
          <p className="mt-3 mb-1 px-2 text-xs font-medium text-muted-foreground">
            Chats in {projectTitle}
          </p>
          <div className="flex flex-col gap-0.5">
            {candidates.slice(0, 30).map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-accent/60"
                onClick={() => onSelect(candidate.id)}
              >
                <span className="min-w-0 flex-1 truncate">{candidate.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatRelativeTimeLabel(candidate.latestUserMessageAt ?? candidate.updatedAt)}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function DockChatTranscript(props: {
  threadRef: ScopedThreadRef;
  cwd: string;
  scrollNodeRef: RefObject<HTMLDivElement | null>;
}) {
  const { scrollNodeRef } = props;
  const thread = useThread(props.threadRef, DOCK_THREAD_OPTIONS);
  const threadShell = useThreadShell(props.threadRef);
  const stickToBottomRef = useRef(true);
  const messages = useMemo(
    () =>
      (thread?.messages ?? [])
        .filter((message) => message.role === "user" || message.role === "assistant")
        .slice(-MAX_RENDERED_MESSAGES),
    [thread?.messages],
  );
  const lastMessage = messages.at(-1);

  useEffect(() => {
    const node = scrollNodeRef.current;
    if (node && stickToBottomRef.current) node.scrollTop = node.scrollHeight;
  }, [messages.length, lastMessage?.text, scrollNodeRef]);

  // Approvals are answered in the composer; questions still need the main view.
  const needsAttention = threadShell?.hasPendingUserInput === true;

  return (
    <div
      ref={scrollNodeRef}
      className="min-h-0 flex-1 overflow-y-auto px-3 py-3"
      onScroll={(event) => {
        const node = event.currentTarget;
        stickToBottomRef.current =
          node.scrollHeight - node.scrollTop - node.clientHeight < STICK_TO_BOTTOM_THRESHOLD_PX;
      }}
    >
      {thread === null ? (
        <p className="text-sm text-muted-foreground">Loading messages…</p>
      ) : messages.length === 0 ? (
        <p className="text-sm text-muted-foreground">No messages yet.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {messages.map((message) =>
            message.role === "user" ? (
              <div
                key={message.id}
                className="ml-8 self-end rounded-lg bg-muted px-3 py-2 text-sm whitespace-pre-wrap"
              >
                {message.text}
              </div>
            ) : (
              <ChatMarkdown
                key={message.id}
                text={message.text}
                cwd={props.cwd}
                threadRef={props.threadRef}
                isStreaming={message.streaming}
                className="text-sm"
              />
            ),
          )}
        </div>
      )}
      {needsAttention ? (
        <p className="mt-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
          This chat is waiting for your answer. Open it in the main view to respond.
        </p>
      ) : null}
    </div>
  );
}

/** The thread a new chat's composer works against until its first message creates it. */
function buildDockDraftThread(input: {
  threadId: ThreadId;
  project: EnvironmentProject;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  createdAt: string;
}): Thread {
  return {
    id: input.threadId,
    environmentId: input.project.environmentId,
    projectId: input.project.id,
    title: "New chat",
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    session: null,
    messages: [],
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    checkpoints: [],
    pullRequests: [],
    activities: [],
    proposedPlans: [],
  };
}

function reportDockChatError(title: string, error: unknown, fallback: string) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : fallback,
    }),
  );
}

/**
 * The main chat's composer, hosted for the dock thread. It mirrors the props
 * ChatView derives for a server thread; features that need ChatView's timeline
 * (queued follow-ups, plan follow-ups, questions, compaction) stay in the main view.
 */
function DockChatComposer(props: {
  hostThreadRef: ScopedThreadRef;
  project: EnvironmentProject;
  /** The chat's thread, or the id a new chat's first message will create. */
  threadId: ThreadId;
  isNewChat: boolean;
  defaults: DockChatDefaults;
  composerRef: RefObject<ChatComposerHandle | null>;
  scrollNodeRef: RefObject<HTMLDivElement | null>;
  onThreadCreated: (threadId: string) => void;
}) {
  const { composerRef, isNewChat, project, scrollNodeRef, threadId: chatThreadId } = props;
  const environmentId = project.environmentId;
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, chatThreadId),
    [environmentId, chatThreadId],
  );
  const composerDraftTarget = threadRef;
  const serverThreadRef = isNewChat ? null : threadRef;
  const serverThread = useThread(serverThreadRef, DOCK_THREAD_OPTIONS);
  const threadShell = useThreadShell(serverThreadRef);
  const settings = useEnvironmentSettings(environmentId);
  const clientSettingsHydrated = useClientSettingsHydrated();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { resolvedTheme } = useTheme();
  const navigate = useNavigate();
  const environment = useEnvironment(environmentId);

  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn, { reportFailure: false });
  const respondToApproval = useAtomCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const setThreadRuntimeMode = useAtomCommand(threadEnvironment.setRuntimeMode, {
    reportFailure: false,
  });
  const setThreadInteractionMode = useAtomCommand(threadEnvironment.setInteractionMode, {
    reportFailure: false,
  });

  const projectSettings = useMemo(
    () => resolveProjectSettings(settings, project.id, project).settings,
    [project, settings],
  );
  const projectDefaultModelSelection = projectSettings.defaultModelSelection;
  const [draftCreatedAt] = useState(() => new Date().toISOString());

  // Granular draft selectors, as in ChatView: the composer draft holds the selections.
  const composerRuntimeMode = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.runtimeMode ?? null,
  );
  const composerInteractionMode = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.interactionMode ?? null,
  );
  const composerActiveProvider = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.activeProvider ?? null,
  );
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
  const addComposerDraftFiles = useComposerDraftStore((store) => store.addFiles);
  const setComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.setTerminalContexts,
  );
  const setComposerDraftModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const setStickyComposerModelSelection = useComposerDraftStore(
    (store) => store.setStickyModelSelection,
  );
  const setComposerDraftRuntimeMode = useComposerDraftStore((store) => store.setRuntimeMode);
  const setComposerDraftInteractionMode = useComposerDraftStore(
    (store) => store.setInteractionMode,
  );
  const clearComposerDraftContent = useComposerDraftStore((store) => store.clearComposerContent);

  const runtimeMode =
    composerRuntimeMode ?? serverThread?.runtimeMode ?? projectSettings.defaultRuntimeMode;
  const draftThread = useMemo(
    () =>
      isNewChat
        ? buildDockDraftThread({
            threadId: chatThreadId,
            project,
            modelSelection: projectDefaultModelSelection ?? props.defaults.modelSelection,
            runtimeMode,
            interactionMode: composerInteractionMode ?? DEFAULT_INTERACTION_MODE,
            createdAt: draftCreatedAt,
          })
        : undefined,
    [
      composerInteractionMode,
      draftCreatedAt,
      isNewChat,
      project,
      projectDefaultModelSelection,
      props.defaults.modelSelection,
      chatThreadId,
      runtimeMode,
    ],
  );
  const activeThread: Thread | undefined = serverThread ?? draftThread;

  // Provider state, as ChatView derives it for the routed thread.
  const serverConfig = environment?.serverConfig ?? null;
  const providerStatuses = serverConfig?.providers ?? EMPTY_PROVIDERS;
  const lockedProvider = deriveLockedProvider({
    thread: activeThread,
    selectedProvider: composerActiveProvider,
    threadProvider:
      activeThread?.modelSelection.instanceId ?? projectDefaultModelSelection?.instanceId ?? null,
    providers: providerStatuses,
  });
  const providerInstanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providerStatuses), settings),
      ),
    [providerStatuses, settings],
  );
  const { selectedProviderEntry } = resolveComposerProviderSelection({
    entries: providerInstanceEntries,
    candidateInstanceIds: [
      composerActiveProvider,
      activeThread?.session?.providerInstanceId,
      activeThread?.modelSelection.instanceId,
      projectDefaultModelSelection?.instanceId,
    ],
    lockedProvider,
    lockedInstanceId:
      activeThread?.session?.providerInstanceId ?? activeThread?.modelSelection.instanceId,
  });
  const { enabled: interactionModeEnabled, interactionMode } = resolveComposerInteractionMode({
    planModeEnabled: settings.planModeEnabled,
    provider: selectedProviderEntry?.snapshot ?? null,
    interactionMode:
      composerInteractionMode ?? activeThread?.interactionMode ?? DEFAULT_INTERACTION_MODE,
  });
  const attachmentUploadsCapabilityKnown = serverConfig !== null;
  const supportsAttachmentUploads =
    serverConfig?.environment.capabilities.attachmentUploads === true;
  const advertisedFileAttachmentBytes =
    serverConfig?.environment.capabilities.fileAttachments?.maxUploadBytes ?? null;
  const maxFileAttachmentBytes =
    advertisedFileAttachmentBytes === null
      ? null
      : clampFileAttachmentUploadBytes(advertisedFileAttachmentBytes);

  const connectionPhase = environment?.connection.phase ?? "available";
  const environmentUnavailable = useMemo(
    () =>
      environment !== null && connectionPhase !== "connected"
        ? { label: environment.label, connection: environment.connection }
        : null,
    [connectionPhase, environment],
  );

  const phase = derivePhase(activeThread?.session ?? null);
  const threadActivities = activeThread?.activities;
  const pendingApprovals = useMemo(
    () => (threadActivities ? derivePendingRequests(threadActivities).approvals : []),
    [threadActivities],
  );
  const activeContextWindow = useMemo(
    () => (threadActivities ? deriveLatestContextWindowSnapshot(threadActivities) : null),
    [threadActivities],
  );
  const threadLoading = !isNewChat && serverThread === null;
  const gitCwd = projectScriptCwd({
    project: { cwd: project.workspaceRoot },
    worktreePath: activeThread?.worktreePath ?? null,
  });

  const promptRef = useRef("");
  const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
  const composerFilesRef = useRef<ComposerFileAttachment[]>([]);
  const composerTerminalContextsRef = useRef<TerminalContextDraft[]>([]);
  const sendInFlightRef = useRef(false);
  const [isSendBusy, setIsSendBusy] = useState(false);
  const [respondingRequestIds, setRespondingRequestIds] =
    useState<ApprovalRequestId[]>(EMPTY_REQUEST_IDS);
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);
  const scopeRef = useRef<HTMLDivElement>(null);

  const focusComposer = useCallback(() => {
    composerRef.current?.focusAtEnd();
  }, [composerRef]);
  const scheduleComposerFocus = useCallback(() => {
    window.requestAnimationFrame(focusComposer);
  }, [focusComposer]);
  // The dock has no thread error banner; errors surface as toasts.
  const setThreadError = useCallback((_threadId: ThreadId | null, error: string | null) => {
    if (error) reportDockChatError("Chat error", null, error);
  }, []);

  const handleRuntimeModeChange = useCallback(
    (mode: RuntimeMode) => {
      if (mode === runtimeMode) return;
      setComposerDraftRuntimeMode(composerDraftTarget, mode);
      scheduleComposerFocus();
    },
    [composerDraftTarget, runtimeMode, scheduleComposerFocus, setComposerDraftRuntimeMode],
  );
  const handleInteractionModeChange = useCallback(
    (mode: ProviderInteractionMode) => {
      if (mode === "plan" && !interactionModeEnabled) return;
      if (mode === interactionMode) return;
      setComposerDraftInteractionMode(composerDraftTarget, mode);
      scheduleComposerFocus();
    },
    [
      composerDraftTarget,
      interactionMode,
      interactionModeEnabled,
      scheduleComposerFocus,
      setComposerDraftInteractionMode,
    ],
  );
  const toggleInteractionMode = useCallback(() => {
    if (!interactionModeEnabled) return;
    handleInteractionModeChange(interactionMode === "plan" ? "default" : "plan");
  }, [handleInteractionModeChange, interactionMode, interactionModeEnabled]);

  const getModelDisabledReason = useCallback(
    (instanceId: ProviderInstanceId, model: string): string | null => {
      if (!activeThread) return null;
      const reason = getStartedThreadModelChangeBlockReason({
        providers: providerStatuses,
        hasStartedSession: activeThread.session !== null,
        currentModelSelection: activeThread.modelSelection,
        currentProviderInstanceId: activeThread.session?.providerInstanceId ?? null,
        nextModelSelection: { instanceId, model },
      });
      return reason ? `${reason.description} Start a new thread to use this model.` : null;
    },
    [activeThread, providerStatuses],
  );
  const onProviderModelSelect = useCallback(
    (instanceId: ProviderInstanceId, model: string) => {
      if (!activeThread) return;
      const entry = providerStatuses.find((snapshot) => snapshot.instanceId === instanceId);
      const resolvedDriverKind = entry?.driver ?? null;
      if (
        lockedProvider !== null &&
        resolvedDriverKind !== null &&
        resolvedDriverKind !== lockedProvider
      ) {
        scheduleComposerFocus();
        return;
      }
      if (lockedProvider !== null && activeThread.session?.providerInstanceId) {
        const currentEntry = providerStatuses.find(
          (snapshot) => snapshot.instanceId === activeThread.session?.providerInstanceId,
        );
        if (
          currentEntry?.continuation?.groupKey &&
          entry?.continuation?.groupKey &&
          currentEntry.continuation.groupKey !== entry.continuation.groupKey
        ) {
          scheduleComposerFocus();
          return;
        }
      }
      const resolvedModel = resolveAppModelSelectionForInstance(
        instanceId,
        settings,
        providerStatuses,
        model,
      );
      if (!resolvedModel) {
        scheduleComposerFocus();
        return;
      }
      const nextModelSelection: ModelSelection = { instanceId, model: resolvedModel };
      const modelChangeBlockReason = getStartedThreadModelChangeBlockReason({
        providers: providerStatuses,
        hasStartedSession: activeThread.session !== null,
        currentModelSelection: activeThread.modelSelection,
        currentProviderInstanceId: activeThread.session?.providerInstanceId ?? null,
        nextModelSelection,
      });
      if (modelChangeBlockReason) {
        toastManager.add({
          type: "warning",
          title: modelChangeBlockReason.title,
          description: modelChangeBlockReason.description,
        });
        scheduleComposerFocus();
        return;
      }
      setComposerDraftModelSelection(composerDraftTarget, nextModelSelection, { explicit: true });
      setStickyComposerModelSelection(nextModelSelection);
      scheduleComposerFocus();
    },
    [
      activeThread,
      composerDraftTarget,
      lockedProvider,
      providerStatuses,
      scheduleComposerFocus,
      setComposerDraftModelSelection,
      setStickyComposerModelSelection,
      settings,
    ],
  );
  const openProviderSetup = useCallback(
    (instanceId: ProviderInstanceId) => {
      void navigate({ to: "/settings/providers", search: { environmentId, instanceId } });
    },
    [environmentId, navigate],
  );

  const canInterrupt = buildRunningThreadTurnInterruptInput(activeThread, phase) !== null;
  const onInterrupt = useCallback(async () => {
    const input = buildRunningThreadTurnInterruptInput(activeThread, phase);
    if (!input) return;
    const result = await interruptTurn({ environmentId, input });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportDockChatError(
        "Could not stop the turn",
        squashAtomCommandFailure(result),
        "Failed to interrupt the current turn.",
      );
    }
  }, [activeThread, environmentId, interruptTurn, phase]);

  const onRespondToApproval = useCallback(
    async (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => {
      if (isNewChat) return;
      setRespondingRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      const result = await respondToApproval({
        environmentId,
        input: { threadId: chatThreadId, requestId, decision },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        reportDockChatError(
          "Could not answer the request",
          squashAtomCommandFailure(result),
          "Failed to submit approval decision.",
        );
      }
      setRespondingRequestIds((existing) => existing.filter((id) => id !== requestId));
      return result;
    },
    [environmentId, isNewChat, chatThreadId, respondToApproval, setRespondingRequestIds],
  );

  /** ChatView's persistThreadSettingsForNextTurn, for the dock's server thread. */
  const persistThreadSettingsForNextTurn = async (input: {
    createdAt: string;
    modelSelection?: ModelSelection;
    runtimeMode: RuntimeMode;
    interactionMode: ProviderInteractionMode;
  }): Promise<AtomCommandResult<void, unknown> | null> => {
    if (!serverThread) return null;
    const metadataUpdate = resolveThreadMetadataUpdateForNextTurn({
      currentModelSelection: serverThread.modelSelection,
      ...(input.modelSelection ? { nextModelSelection: input.modelSelection } : {}),
      currentBranch: serverThread.branch,
    });
    if (metadataUpdate) {
      const result = mapAtomCommandResult(
        await updateThreadMetadata({
          environmentId,
          input: { threadId: serverThread.id, ...metadataUpdate },
        }),
        () => undefined,
      );
      if (result._tag === "Failure") return result;
    }
    if (input.runtimeMode !== serverThread.runtimeMode) {
      const result = mapAtomCommandResult(
        await setThreadRuntimeMode({
          environmentId,
          input: {
            threadId: serverThread.id,
            runtimeMode: input.runtimeMode,
            createdAt: input.createdAt,
          },
        }),
        () => undefined,
      );
      if (result._tag === "Failure") return result;
    }
    if (input.interactionMode !== serverThread.interactionMode) {
      const result = mapAtomCommandResult(
        await setThreadInteractionMode({
          environmentId,
          input: {
            threadId: serverThread.id,
            interactionMode: input.interactionMode,
            createdAt: input.createdAt,
          },
        }),
        () => undefined,
      );
      if (result._tag === "Failure") return result;
    }
    return null;
  };

  /** Files a chat started beside a thread in Chats alongside it; project threads stay put. */
  const fileNewChat = (threadId: ThreadId) => {
    const workState = useWorkModeStore.getState();
    const placement = resolveThreadPlacement(workState, scopedThreadKey(props.hostThreadRef));
    if (placement.kind !== "chats") return;
    workState.moveThreadsToChats(
      [scopedThreadKey(scopeThreadRef(environmentId, threadId))],
      placement.folderId,
    );
  };

  // The server-thread send path of ChatView's onSend, without the timeline-only
  // parts: queued follow-ups, plan follow-ups, feedback, and usage limits.
  const onSend = async (
    event?: { preventDefault: () => void },
    _intent?: ComposerSubmissionIntent,
  ) => {
    event?.preventDefault();
    if (
      !activeThread ||
      isSendBusy ||
      sendInFlightRef.current ||
      threadLoading ||
      !clientSettingsHydrated
    ) {
      return;
    }
    if (environmentUnavailable) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Not connected: message not sent",
          description: "Reconnecting to the environment. Try again once it is connected.",
        }),
      );
      return;
    }
    const sendCtx = composerRef.current?.getSendContext();
    if (!sendCtx?.providerAvailable) return;
    const {
      images,
      files,
      terminalContexts,
      previewAnnotations,
      reviewComments,
      selectedProvider,
      selectedModel,
      selectedProviderModels,
      selectedPromptEffort,
      selectedModelSelection,
      interactionMode: sendInteractionMode,
      interactionModeEnabled: sendInteractionModeEnabled,
    } = sendCtx;
    const promptForSend = promptRef.current;
    const {
      trimmedPrompt: trimmed,
      sendableTerminalContexts,
      hasSendableContent,
    } = deriveComposerSendState({
      prompt: promptForSend,
      imageCount: images.length + files.length,
      terminalContexts,
      elementContextCount: previewAnnotations.length + reviewComments.length,
    });
    const hasNonPromptContent =
      images.length > 0 ||
      files.length > 0 ||
      sendableTerminalContexts.length > 0 ||
      previewAnnotations.length > 0 ||
      reviewComments.length > 0;
    const standaloneSlashCommand =
      sendInteractionModeEnabled && !hasNonPromptContent
        ? parseStandaloneComposerSlashCommand(trimmed)
        : null;
    if (standaloneSlashCommand) {
      handleInteractionModeChange(standaloneSlashCommand);
      promptRef.current = "";
      clearComposerDraftContent(composerDraftTarget);
      composerRef.current?.resetCursorState();
      return;
    }
    if (!hasSendableContent) return;

    // Expired terminal excerpts are not sent; their chips leave the text with them.
    const messageTextForSend = terminalContexts
      .filter((context) => !sendableTerminalContexts.includes(context))
      .reduce(
        (text, context) =>
          removeInlineContextReference(text, terminalContextReference(context).contextId).prompt,
        promptForSend,
      )
      .trim();
    const outgoingMessageText = formatOutgoingPrompt({
      provider: selectedProvider,
      model: selectedModel,
      models: selectedProviderModels,
      effort: selectedPromptEffort,
      text: messageTextForSend || ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
    });
    if (composerRef.current?.validateProviderInput(outgoingMessageText) === false) return;

    sendInFlightRef.current = true;
    setIsSendBusy(true);
    try {
      const attachmentsSnapshot = [...images, ...files];
      // Attachments upload as they are added; the send waits for the last of them.
      if (supportsAttachmentUploads && attachmentsSnapshot.length > 0) {
        for (const attachment of attachmentsSnapshot) {
          startAttachmentUpload({ environmentId, image: attachment, draftTarget: threadRef });
        }
        await awaitAttachmentUploads(attachmentsSnapshot.map((attachment) => attachment.id));
        if (getUploadedAttachments({ environmentId, images: attachmentsSnapshot }) === null) {
          reportDockChatError(
            "Could not send the message",
            null,
            "Retry or remove failed uploads before sending.",
          );
          return;
        }
      }
      let turnAttachments;
      try {
        turnAttachments = await Promise.all(
          attachmentsSnapshot.map(async (attachment) => {
            if (supportsAttachmentUploads) {
              const uploaded = getUploadedAttachments({ environmentId, images: [attachment] })?.[0];
              if (!uploaded) {
                throw new Error(`Attachment '${attachment.name}' did not finish uploading.`);
              }
              return uploaded;
            }
            if (attachment.type !== "image") {
              throw new Error("This server does not support file attachments.");
            }
            return {
              type: "image" as const,
              id: attachment.id,
              name: attachment.name,
              mimeType: attachment.mimeType,
              sizeBytes: attachment.sizeBytes,
              dataUrl: await readFileAsDataUrl(attachment.file),
              ...(attachment.source ? { source: attachment.source } : {}),
            };
          }),
        );
      } catch (error) {
        reportDockChatError("Could not send the message", error, "Failed to attach files.");
        return;
      }
      const messageContext = buildMessageContext({
        terminalContexts: sendableTerminalContexts,
        reviewComments,
        previewAnnotations,
        attachments: attachmentsSnapshot.map((attachment, index) => {
          const sent = turnAttachments[index];
          return {
            attachment,
            attachmentId: sent && "id" in sent && sent.id !== undefined ? sent.id : attachment.id,
          };
        }),
      });
      // Servers from before inline context forward the records as literal text.
      const supportsInlineMessageContext =
        appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment
          .capabilities.inlineMessageContext === true;
      const messageContent =
        messageContext === undefined
          ? {}
          : supportsInlineMessageContext
            ? { context: messageContext }
            : {
                text: serializeLegacyContextMessage({
                  text: outgoingMessageText,
                  records: messageContext.records,
                }),
              };

      const plainPrompt = assistantCitationsToPlainText(
        stripInlineContextReferences(trimmed),
      ).trim();
      const title = plainPrompt
        ? deriveDockChatTitle(plainPrompt)
        : images[0]
          ? deriveDockChatTitle(`Image: ${images[0].name}`)
          : files[0]
            ? deriveDockChatTitle(`File: ${files[0].name}`)
            : "New chat";
      const createdAt = new Date().toISOString();
      const threadId = chatThreadId;

      // Clear the draft now, as ChatView does; a failed send puts it back.
      promptRef.current = "";
      clearComposerDraftContent(composerDraftTarget);
      composerRef.current?.resetCursorState();

      const settingsFailure = isNewChat
        ? null
        : await persistThreadSettingsForNextTurn({
            createdAt,
            ...(selectedModel ? { modelSelection: selectedModelSelection } : {}),
            runtimeMode,
            interactionMode: sendInteractionMode,
          });
      const result =
        settingsFailure ??
        (await startTurn({
          environmentId,
          input: {
            threadId,
            message: {
              messageId: newMessageId(),
              role: "user",
              text: outgoingMessageText,
              attachments: turnAttachments,
              ...messageContent,
            },
            modelSelection: selectedModelSelection,
            titleSeed: title,
            runtimeMode,
            interactionMode: sendInteractionMode,
            ...(isNewChat
              ? {
                  bootstrap: {
                    createThread: {
                      projectId: project.id,
                      title,
                      modelSelection: createModelSelection(
                        selectedModelSelection.instanceId,
                        selectedModel || projectDefaultModelSelection?.model || DEFAULT_MODEL,
                        selectedModelSelection.options,
                      ),
                      runtimeMode,
                      interactionMode: sendInteractionMode,
                      branch: null,
                      worktreePath: null,
                      createdAt,
                    },
                  },
                }
              : {}),
            createdAt,
          },
        }));

      if (result._tag === "Failure") {
        // Put the message back unless the user already started another one.
        const draft = useComposerDraftStore.getState().getComposerDraft(composerDraftTarget);
        if (!composerDraftHasUserContent(draft)) {
          const retryImages = images.map(cloneComposerImageForRetry);
          promptRef.current = messageTextForSend;
          composerImagesRef.current = retryImages;
          composerFilesRef.current = files;
          composerTerminalContextsRef.current = sendableTerminalContexts;
          setComposerDraftPrompt(composerDraftTarget, messageTextForSend);
          addComposerDraftImages(composerDraftTarget, retryImages);
          addComposerDraftFiles(composerDraftTarget, files);
          setComposerDraftTerminalContexts(composerDraftTarget, sendableTerminalContexts);
          composerRef.current?.resetCursorState({
            cursor: messageTextForSend.length,
            prompt: messageTextForSend,
            detectTrigger: true,
          });
        }
        if (!isAtomCommandInterrupted(result)) {
          reportDockChatError(
            "Could not send the message",
            squashAtomCommandFailure(result),
            "An error occurred.",
          );
        }
        return;
      }
      if (supportsAttachmentUploads) releaseDraftAttachments(attachmentsSnapshot);
      const scrollNode = scrollNodeRef.current;
      if (scrollNode) scrollNode.scrollTop = scrollNode.scrollHeight;
      if (isNewChat) {
        fileNewChat(threadId);
        props.onThreadCreated(threadId);
      }
    } finally {
      sendInFlightRef.current = false;
      setIsSendBusy(false);
    }
  };

  // Composer shortcuts that ChatView answers for the main composer act on this
  // one while focus is inside it (ChatView leaves them alone then).
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const scope = scopeRef.current;
      if (!scope || !(event.target instanceof Node) || !scope.contains(event.target)) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: { modelPickerOpen: composerRef.current?.isModelPickerOpen() ?? false },
      });
      if (!command || !FOCUS_SCOPED_COMPOSER_COMMANDS.has(command)) return;
      if (command === "thread.stop") {
        // An unavailable command should not shadow contextual shortcuts such as Escape.
        if (!canInterrupt) return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) void onInterrupt();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (
        event.repeat ||
        command === "composer.branch" ||
        command === "composer.previousWorktree"
      ) {
        return;
      }
      if (command === "modelPicker.toggle") {
        composerRef.current?.toggleModelPicker();
      } else {
        composerRef.current?.openControl(command as KeybindingCommand);
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [canInterrupt, composerRef, keybindings, onInterrupt]);

  const getTimelineScrollableNode = useCallback(() => scrollNodeRef.current, [scrollNodeRef]);
  const isTimelineAtLogicalEnd = useCallback(() => {
    const node = scrollNodeRef.current;
    return (
      node === null ||
      node.scrollHeight - node.scrollTop - node.clientHeight < STICK_TO_BOTTOM_THRESHOLD_PX
    );
  }, [scrollNodeRef]);
  const onPageScrollKeyDown = useCallback(
    (key: "PageUp" | "PageDown") => {
      const node = scrollNodeRef.current;
      if (!node) return;
      const distance = node.clientHeight * 0.85;
      node.scrollBy({ top: key === "PageUp" ? -distance : distance, behavior: "smooth" });
    },
    [scrollNodeRef],
  );
  const onFileOpen = useCallback(
    (attachment: ChatFileAttachment) => {
      useRightPanelStore.getState().openAttachment(props.hostThreadRef, attachment);
    },
    [props.hostThreadRef],
  );

  return (
    <div ref={scopeRef} className="shrink-0 px-2 pt-1 pb-2" {...focusScopedComposerProps}>
      {/* Menus inside this composer return focus to it, not to the main composer. */}
      <ComposerHandleContext value={composerRef}>
        <ComposerSurface.Shell>
          <ComposerSurface.Host>
            <div className="relative z-10">
              <ChatComposer
                composerRef={composerRef}
                composerDraftTarget={composerDraftTarget}
                environmentId={environmentId}
                attachmentUploadsCapabilityKnown={attachmentUploadsCapabilityKnown}
                supportsAttachmentUploads={supportsAttachmentUploads}
                supportsQuestionAttachments={false}
                maxFileAttachmentBytes={maxFileAttachmentBytes}
                routeKind="server"
                routeThreadRef={threadRef}
                draftId={null}
                activeThreadId={chatThreadId}
                activeThreadEnvironmentId={environmentId}
                activeThread={activeThread}
                activeThreadShell={threadShell}
                promptHistoryMessages={serverThread?.messages ?? EMPTY_MESSAGES}
                isServerThread={!isNewChat}
                isLocalDraftThread={isNewChat}
                forceExpandedOnMobile={false}
                projectSelectionRequired={false}
                phase={phase}
                isConnecting={false}
                isSendBusy={isSendBusy}
                sendDisabledReason={threadLoading ? "Messages loading" : null}
                isPreparingWorktree={false}
                bannerItems={EMPTY_BANNER_ITEMS}
                environmentUnavailable={environmentUnavailable}
                activePendingApproval={pendingApprovals[0] ?? null}
                pendingApprovals={pendingApprovals}
                pendingUserInputs={EMPTY_PENDING_USER_INPUTS}
                activePendingProgress={null}
                activePendingResolvedAnswers={null}
                activePendingIsResponding={false}
                activePendingDraftAnswers={EMPTY_PENDING_DRAFT_ANSWERS}
                activePendingQuestionIndex={0}
                respondingRequestIds={respondingRequestIds}
                showPlanFollowUpPrompt={false}
                activeProposedPlan={null}
                activeTasksProgress={null}
                activeTaskSteps={null}
                threadSyncPhase={null}
                runtimeMode={runtimeMode}
                interactionMode={interactionMode}
                lockedProvider={lockedProvider}
                providerStatuses={providerStatuses as ServerProvider[]}
                providerCatalogKnown={serverConfig !== null}
                activeProjectDefaultModelSelection={projectDefaultModelSelection}
                activeThreadModelSelection={activeThread?.modelSelection}
                activeContextWindow={activeContextWindow}
                compactThreadUnavailable
                compactDisabled
                compactDisabledReason="Open this chat in the main view to compact it"
                resolvedTheme={resolvedTheme}
                settings={settings}
                keybindings={keybindings}
                terminalOpen={false}
                gitCwd={gitCwd}
                pullRequestProjectId={null}
                pullRequestRepository={null}
                restingControlsHost={null}
                restingControlsHaveLeadingContext={false}
                onRestingControlsVisibilityChange={noop}
                getTimelineScrollableNode={getTimelineScrollableNode}
                isTimelineAtLogicalEnd={isTimelineAtLogicalEnd}
                // The dock composer never rests: it stays the expanded composer.
                timelineOverflows={false}
                onComposerOverlayHeightChange={noop}
                onRestingChange={noop}
                promptRef={promptRef}
                composerImagesRef={composerImagesRef}
                composerFilesRef={composerFilesRef}
                composerTerminalContextsRef={composerTerminalContextsRef}
                onPageScrollKeyDown={onPageScrollKeyDown}
                onPageScrollKeyUp={noop}
                onPageScrollRelease={noop}
                onCompactContext={noop}
                onSend={onSend}
                onInterrupt={onInterrupt}
                onImplementPlanInNewThread={noop}
                onRespondToApproval={onRespondToApproval}
                onSelectActivePendingUserInputOption={noop}
                onAdvanceActivePendingUserInput={noop}
                onDismissActivePendingUserInput={noop}
                onPreviousActivePendingUserInputQuestion={noop}
                onChangeActivePendingUserInputCustomAnswer={noop}
                onProviderModelSelect={onProviderModelSelect}
                onOpenProviderSetup={openProviderSetup}
                getModelDisabledReason={getModelDisabledReason}
                toggleInteractionMode={toggleInteractionMode}
                handleRuntimeModeChange={handleRuntimeModeChange}
                handleInteractionModeChange={handleInteractionModeChange}
                focusComposer={focusComposer}
                scheduleComposerFocus={scheduleComposerFocus}
                setThreadError={setThreadError}
                onExpandImage={setExpandedImage}
                onFileOpen={onFileOpen}
              />
            </div>
          </ComposerSurface.Host>
        </ComposerSurface.Shell>
      </ComposerHandleContext>
      {expandedImage ? (
        <ExpandedImageDialog
          key={expandedImageKey(expandedImage)}
          preview={expandedImage}
          onClose={() => setExpandedImage(null)}
        />
      ) : null}
    </div>
  );
}
