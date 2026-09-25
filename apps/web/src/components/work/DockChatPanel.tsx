/**
 * A compact chat shown in the right panel ("dock") beside the main thread.
 *
 * It deliberately does not mount a second ChatView: ChatView owns window-level
 * shortcuts, the shared composer handle, terminal drawers, and route-driven
 * draft promotion, all of which assume one instance. This panel reads the same
 * server thread and sends turns through the same commands, so the chat stays in
 * sync with its full view in the main area.
 */
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowUpIcon,
  ChevronDownIcon,
  ExternalLinkIcon,
  MessageSquarePlusIcon,
  SquareIcon,
} from "lucide-react";
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { newMessageId, newThreadId } from "~/lib/utils";
import { type RightPanelSurface, useRightPanelStore } from "~/rightPanelStore";
import { useThread, useThreadShell, useThreadShellsForProjectRefs } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { resolveThreadFolderId, useWorkModeStore } from "~/workModeStore";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { cn } from "~/lib/utils";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";

type ChatSurface = Extract<RightPanelSurface, { kind: "chat" }>;

export interface DockChatDefaults {
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
}

const MAX_RENDERED_MESSAGES = 200;
/** A chat created here exists on the client before the server records it; wait for its shell. */
const DOCK_THREAD_OPTIONS = { waitForShell: true } as const;
const TITLE_MAX_LENGTH = 60;

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
  const selectThread = useCallback(
    (threadId: string | null) =>
      useRightPanelStore.getState().setChatSurfaceThread(hostThreadRef, surface.id, threadId),
    [hostThreadRef, surface.id],
  );
  const threadRef = useMemo(
    () =>
      surface.threadId === null
        ? null
        : scopeThreadRef(project.environmentId, surface.threadId as ThreadId),
    [project.environmentId, surface.threadId],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-dock-chat>
      <DockChatHeader
        threadRef={threadRef}
        projectTitle={project.title}
        candidates={candidates}
        onSelect={selectThread}
      />
      {threadRef ? (
        <DockChatTranscript threadRef={threadRef} cwd={project.workspaceRoot} />
      ) : (
        <DockChatPicker
          candidates={candidates}
          projectTitle={project.title}
          onSelect={selectThread}
        />
      )}
      <DockChatComposer
        hostThreadRef={hostThreadRef}
        threadRef={threadRef}
        project={project}
        defaults={props.defaults}
        onThreadCreated={selectThread}
      />
    </div>
  );
}

function DockChatHeader(props: {
  threadRef: ScopedThreadRef | null;
  projectTitle: string;
  candidates: ReadonlyArray<EnvironmentThreadShell>;
  onSelect: (threadId: string | null) => void;
}) {
  const navigate = useNavigate();
  const thread = useThread(props.threadRef, DOCK_THREAD_OPTIONS);
  const title = thread?.title ?? (props.threadRef ? "Loading…" : "New chat");
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/60 px-2">
      <Menu>
        <MenuTrigger
          render={
            <Button
              className="min-w-0 max-w-full justify-start gap-1 px-1.5 font-medium"
              size="xs"
              variant="ghost"
            />
          }
        >
          <span className="truncate">{title}</span>
          <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />
        </MenuTrigger>
        <MenuPopup align="start" className="max-h-80 w-72">
          <MenuItem onClick={() => props.onSelect(null)}>
            <MessageSquarePlusIcon className="size-4" />
            New chat in {props.projectTitle}
          </MenuItem>
          {props.candidates.length > 0 ? <MenuSeparator /> : null}
          {props.candidates.map((candidate) => (
            <MenuItem key={candidate.id} onClick={() => props.onSelect(candidate.id)}>
              <span className="min-w-0 flex-1 truncate">{candidate.title}</span>
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
      <div className="flex-1" />
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
  onSelect: (threadId: string) => void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
      <p className="mb-1 px-1 text-sm font-medium text-foreground">
        New chat in {props.projectTitle}
      </p>
      <p className="mb-4 px-1 text-xs text-muted-foreground">
        Type below to start one, or open an existing chat from this project.
      </p>
      {props.candidates.length === 0 ? null : (
        <div className="flex flex-col gap-0.5">
          {props.candidates.slice(0, 30).map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-accent/60"
              onClick={() => props.onSelect(candidate.id)}
            >
              <span className="min-w-0 flex-1 truncate">{candidate.title}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {formatRelativeTimeLabel(candidate.latestUserMessageAt ?? candidate.updatedAt)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function DockChatTranscript(props: { threadRef: ScopedThreadRef; cwd: string }) {
  const thread = useThread(props.threadRef, DOCK_THREAD_OPTIONS);
  const threadShell = useThreadShell(props.threadRef);
  const scrollRef = useRef<HTMLDivElement>(null);
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
    const node = scrollRef.current;
    if (node && stickToBottomRef.current) node.scrollTop = node.scrollHeight;
  }, [messages.length, lastMessage?.text]);

  const needsAttention = threadShell?.hasPendingApprovals || threadShell?.hasPendingUserInput;

  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 overflow-y-auto px-3 py-3"
      onScroll={(event) => {
        const node = event.currentTarget;
        stickToBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
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
          This chat is waiting for your decision. Open it in the main view to respond.
        </p>
      ) : null}
    </div>
  );
}

function DockChatComposer(props: {
  hostThreadRef: ScopedThreadRef;
  threadRef: ScopedThreadRef | null;
  project: EnvironmentProject;
  defaults: DockChatDefaults;
  onThreadCreated: (threadId: string) => void;
}) {
  const thread = useThread(props.threadRef, DOCK_THREAD_OPTIONS);
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn, { reportFailure: false });
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const running = thread?.session?.status === "running" || thread?.session?.status === "starting";

  const send = useCallback(async () => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || sending) return;
    setSending(true);
    const createdAt = new Date().toISOString();
    const isNewChat = props.threadRef === null;
    const threadId = props.threadRef?.threadId ?? newThreadId();
    const title = deriveDockChatTitle(trimmed);
    const modelSelection =
      thread?.modelSelection ??
      props.project.defaultModelSelection ??
      props.defaults.modelSelection;
    const runtimeMode = thread?.runtimeMode ?? props.defaults.runtimeMode;
    const interactionMode = thread?.interactionMode ?? props.defaults.interactionMode;
    const result = await startTurn({
      environmentId: props.project.environmentId,
      input: {
        threadId,
        message: { messageId: newMessageId(), role: "user", text: trimmed, attachments: [] },
        modelSelection,
        runtimeMode,
        interactionMode,
        ...(isNewChat
          ? {
              titleSeed: title,
              bootstrap: {
                createThread: {
                  projectId: props.project.id,
                  title,
                  modelSelection,
                  runtimeMode,
                  interactionMode,
                  branch: null,
                  worktreePath: null,
                  createdAt,
                },
              },
            }
          : {}),
        createdAt,
      },
    });
    setSending(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not send the message",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
      return;
    }
    setText("");
    if (isNewChat) {
      // A chat started beside a filed thread goes in the same Work folder.
      const workState = useWorkModeStore.getState();
      const folderId = resolveThreadFolderId(workState, scopedThreadKey(props.hostThreadRef));
      if (folderId !== null) {
        workState.moveThreadsToFolder(
          [scopedThreadKey(scopeThreadRef(props.project.environmentId, threadId))],
          folderId,
        );
      }
      props.onThreadCreated(threadId);
    }
  }, [props, sending, startTurn, text, thread]);

  const stop = useCallback(async () => {
    if (!props.threadRef) return;
    await interruptTurn({
      environmentId: props.threadRef.environmentId,
      input: { threadId: props.threadRef.threadId },
    });
  }, [interruptTurn, props.threadRef]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <div className="shrink-0 border-t border-border/60 p-2">
      <div className="relative">
        <Textarea
          aria-label={props.threadRef ? "Message this chat" : "Start a new chat"}
          className="max-h-40 min-h-16 pr-10 text-sm"
          placeholder={props.threadRef ? "Reply…" : `Message a new chat in ${props.project.title}…`}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <Button
          aria-label={running ? "Stop" : "Send"}
          className={cn("absolute right-2 bottom-2")}
          disabled={!running && (sending || text.trim().length === 0)}
          size="icon-xs"
          onClick={() => void (running && text.trim().length === 0 ? stop() : send())}
        >
          {running && text.trim().length === 0 ? (
            <SquareIcon className="size-3" />
          ) : (
            <ArrowUpIcon className="size-3.5" />
          )}
        </Button>
      </div>
    </div>
  );
}
