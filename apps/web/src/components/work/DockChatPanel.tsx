/**
 * A chat shown in the right panel ("dock") beside the main thread.
 *
 * With a thread it mounts the main area's ChatView in embedded mode, so the
 * dock has the same timeline and composer as the main chat. The embedded view
 * answers window-level shortcuts only for events from inside it and never
 * navigates. Until the surface has a thread, the panel lists the project's
 * other chats and offers a new one.
 */
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { type ModelSelection, type ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { MessageSquarePlusIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { composerDraftHasUserContent, useComposerDraftStore } from "~/composerDraftStore";
import { newThreadId } from "~/lib/utils";
import { type ChatSurface, useRightPanelStore } from "~/rightPanelStore";
import {
  useThreadDetail,
  useThreadShell,
  useThreadShellsForProjectRefs,
  useThreadStatus,
} from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { environmentShell } from "~/state/shell";
import { resolveThreadSyncPhase } from "~/threadSync";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { resolveThreadWorkProjectId, useWorkModeStore } from "~/workModeStore";
import ChatView, { type ChatViewEmbedding } from "../ChatView";
import { listDockChatCandidates } from "./DockChatPanel.logic";

export interface DockChatDefaults {
  /** The host thread's model, used for a new chat when its project sets no default. */
  modelSelection: ModelSelection;
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
  const environmentId = project.environmentId;
  const fallbackModelSelection = props.defaults.modelSelection;
  const candidates = useProjectChatCandidates(project, hostThreadRef);
  // Surfaces persisted before new chats reserved an id get one for this mount.
  const [fallbackDraftThreadId] = useState(newThreadId);
  // A new chat keys its composer draft by the reserved id, and its first
  // message creates the thread under that id.
  const draftThreadId = ThreadId.make(surface.draftThreadId ?? fallbackDraftThreadId);
  // A new chat the user already started writing reopens as that chat.
  const [newChatOpen, setNewChatOpen] = useState(() =>
    composerDraftHasUserContent(
      useComposerDraftStore
        .getState()
        .getComposerDraft(scopeThreadRef(environmentId, draftThreadId)),
    ),
  );
  // The thread this panel's new chat created. It stays a new chat until the
  // thread's detail arrives, so the view never drops its first message.
  const [createdThreadId, setCreatedThreadId] = useState<string | null>(null);
  // Only a chat the user just opened takes focus, not one restored on mount.
  const [autoFocus, setAutoFocus] = useState(false);

  const threadId =
    surface.threadId !== null
      ? ThreadId.make(surface.threadId)
      : newChatOpen
        ? draftThreadId
        : null;
  const threadRef = useMemo(
    () => (threadId === null ? null : scopeThreadRef(environmentId, threadId)),
    [environmentId, threadId],
  );
  const threadShell = useThreadShell(threadRef);
  // A new chat's thread does not exist yet; wait for its shell before syncing it.
  const syncThreadRef = threadShell === null ? null : threadRef;
  const threadDetail = useThreadDetail(syncThreadRef);
  const threadStatus = useThreadStatus(syncThreadRef);
  const bootstrapComplete =
    useEnvironmentQuery(environmentShell.stateAtom(environmentId)).data?.snapshot._tag === "Some";
  const isNewChat =
    threadId !== null &&
    threadDetail === null &&
    (surface.threadId === null || surface.threadId === createdThreadId);
  const threadSyncPhase = isNewChat
    ? null
    : resolveThreadSyncPhase({
        detailExists: threadDetail !== null,
        shellExists: threadShell !== null,
        status: threadStatus,
      });

  const selectThread = useCallback(
    (nextThreadId: string) => {
      setAutoFocus(true);
      useRightPanelStore.getState().setChatSurfaceThread(hostThreadRef, surface.id, nextThreadId);
    },
    [hostThreadRef, surface.id],
  );
  const startNewChat = useCallback(() => {
    setAutoFocus(true);
    setNewChatOpen(true);
  }, []);
  const onThreadCreated = useCallback(
    (createdId: ThreadId) => {
      // A chat started beside a thread is filed in the host's Work project, if it has one.
      const workState = useWorkModeStore.getState();
      const workProjectId = resolveThreadWorkProjectId(workState, scopedThreadKey(hostThreadRef));
      if (workProjectId !== null) {
        workState.fileThreads(
          [scopedThreadKey(scopeThreadRef(environmentId, createdId))],
          workProjectId,
        );
      }
      setCreatedThreadId(createdId);
      useRightPanelStore.getState().setChatSurfaceThread(hostThreadRef, surface.id, createdId);
    },
    [environmentId, hostThreadRef, surface.id],
  );
  const onOpenThread = useCallback(
    (openedId: ThreadId) => {
      useRightPanelStore.getState().setChatSurfaceThread(hostThreadRef, surface.id, openedId);
    },
    [hostThreadRef, surface.id],
  );
  // A new chat starts in the host chat's workspace, so it keeps working in the
  // same worktree unless the user picks a new one.
  const hostThreadShell = useThreadShell(hostThreadRef);
  const hostBranch = hostThreadShell?.branch ?? null;
  const hostWorktreePath = hostThreadShell?.worktreePath ?? null;
  const embedding = useMemo<ChatViewEmbedding>(
    () => ({
      hostThreadRef,
      ...(isNewChat
        ? {
            newThread: {
              projectId: project.id,
              fallbackModelSelection,
              workspace: { branch: hostBranch, worktreePath: hostWorktreePath },
            },
          }
        : {}),
      onThreadCreated,
      onOpenThread,
      autoFocus,
    }),
    [
      autoFocus,
      fallbackModelSelection,
      hostBranch,
      hostThreadRef,
      hostWorktreePath,
      isNewChat,
      onOpenThread,
      onThreadCreated,
      project.id,
    ],
  );

  // A chat whose thread is gone once the environment has loaded goes back to the list.
  const threadMissing = !isNewChat && threadShell === null && bootstrapComplete;
  return (
    <div className="relative flex min-h-0 flex-1 flex-col" data-dock-chat>
      {threadId === null || threadMissing ? (
        <DockChatPicker
          candidates={candidates}
          projectTitle={project.title}
          onNewChat={startNewChat}
          onSelect={selectThread}
        />
      ) : (
        <ChatView
          key={threadId}
          environmentId={environmentId}
          threadId={threadId}
          routeKind="server"
          threadSyncPhase={threadSyncPhase}
          embedded={embedding}
        />
      )}
    </div>
  );
}

function DockChatPicker(props: {
  candidates: ReadonlyArray<EnvironmentThreadShell>;
  projectTitle: string;
  onNewChat: () => void;
  onSelect: (threadId: string) => void;
}) {
  const { candidates, projectTitle, onNewChat, onSelect } = props;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-3 pb-3">
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
