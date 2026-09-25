/**
 * The T3 Work sidebar: a folder tree of chats that is not tied to repositories.
 *
 * Folders live in the client-side work mode store. Every non-archived thread
 * from every connected environment appears exactly once: inside the folder it
 * is filed in, or under "Chats" when unfiled. Threads and folders move with
 * native drag and drop, or with each row's context menu.
 */
import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  ChevronRightIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  MessagesSquareIcon,
  PlusIcon,
  SearchIcon,
  SquarePenIcon,
} from "lucide-react";
import {
  type DragEvent,
  type MouseEvent,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { openCommandPalette } from "~/commandPaletteBus";
import { isElectron } from "~/env";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useThreadActions } from "~/hooks/useThreadActions";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { useProjects, useThreadShells } from "~/state/entities";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "~/threadRoutes";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import type { SidebarThreadSummary } from "~/types";
import { useUiStateStore } from "~/uiStateStore";
import {
  buildWorkFolderTree,
  resolveThreadFolderId,
  useWorkModeStore,
  type WorkFolderNode,
} from "~/workModeStore";
import { resolveThreadStatusPill } from "../Sidebar.logic";
import { SidebarChromeFooter, SidebarChromeHeader } from "../sidebar/SidebarChrome";
import { ThreadStatusLabel } from "../ThreadStatusIndicators";
import { Button } from "../ui/button";
import { Menu, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { SidebarContent } from "../ui/sidebar";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const THREAD_DRAG_TYPE = "application/x-t3work-thread";
const FOLDER_DRAG_TYPE = "application/x-t3work-folder";
const UNFILED_PREVIEW_COUNT = 25;
const INDENT_PX = 12;

type DropTarget = { kind: "folder"; folderId: string } | { kind: "unfiled" };

function threadRecency(thread: SidebarThreadSummary): number {
  return Date.parse(thread.latestUserMessageAt ?? thread.updatedAt) || 0;
}

/** Group visible threads by folder. Unknown folder ids count as unfiled. */
export function groupThreadsByFolder(
  threads: ReadonlyArray<SidebarThreadSummary>,
  folderState: Parameters<typeof resolveThreadFolderId>[0],
): { byFolderId: Map<string, SidebarThreadSummary[]>; unfiled: SidebarThreadSummary[] } {
  const byFolderId = new Map<string, SidebarThreadSummary[]>();
  const unfiled: SidebarThreadSummary[] = [];
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    const folderId = resolveThreadFolderId(
      folderState,
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
    );
    if (folderId === null) {
      unfiled.push(thread);
    } else {
      const list = byFolderId.get(folderId) ?? [];
      list.push(thread);
      byFolderId.set(folderId, list);
    }
  }
  const byRecency = (left: SidebarThreadSummary, right: SidebarThreadSummary) =>
    threadRecency(right) - threadRecency(left);
  for (const list of byFolderId.values()) list.sort(byRecency);
  unfiled.sort(byRecency);
  return { byFolderId, unfiled };
}

function countFolderThreads(
  node: WorkFolderNode,
  byFolderId: ReadonlyMap<string, SidebarThreadSummary[]>,
): number {
  return (
    (byFolderId.get(node.folder.id)?.length ?? 0) +
    node.children.reduce((total, child) => total + countFolderThreads(child, byFolderId), 0)
  );
}

function readDragPayload(event: DragEvent): { kind: "thread" | "folder"; id: string } | null {
  const threadKey = event.dataTransfer.getData(THREAD_DRAG_TYPE);
  if (threadKey) return { kind: "thread", id: threadKey };
  const folderId = event.dataTransfer.getData(FOLDER_DRAG_TYPE);
  if (folderId) return { kind: "folder", id: folderId };
  return null;
}

function isWorkDrag(event: DragEvent): boolean {
  const { types } = event.dataTransfer;
  return types.includes(THREAD_DRAG_TYPE) || types.includes(FOLDER_DRAG_TYPE);
}

function reportFailure(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

export default function WorkSidebar() {
  const navigate = useNavigate();
  const threads = useThreadShells();
  const projects = useProjects();
  const folders = useWorkModeStore((state) => state.folders);
  const threadFolderByKey = useWorkModeStore((state) => state.threadFolderByKey);
  const collapsedFolderIds = useWorkModeStore((state) => state.collapsedFolderIds);
  const defaultProjectKey = useWorkModeStore((state) => state.defaultProjectKey);
  const lastVisitedById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const handleNewThread = useNewThreadHandler();
  const { archiveThread } = useThreadActions();
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [showAllUnfiled, setShowAllUnfiled] = useState(false);

  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const activeThreadKey =
    routeTarget?.kind === "server" ? scopedThreadKey(routeTarget.threadRef) : null;

  const tree = useMemo(() => buildWorkFolderTree(folders), [folders]);
  const { byFolderId, unfiled } = useMemo(
    () => groupThreadsByFolder(threads, { folders, threadFolderByKey }),
    [folders, threadFolderByKey, threads],
  );
  const projectsByKey = useMemo(
    () => new Map(projects.map((project) => [scopedProjectKeyOf(project), project])),
    [projects],
  );
  const activeThread = useMemo(
    () =>
      activeThreadKey
        ? threads.find(
            (thread) =>
              scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === activeThreadKey,
          )
        : undefined,
    [activeThreadKey, threads],
  );
  const newChatProject =
    (defaultProjectKey ? projectsByKey.get(defaultProjectKey) : undefined) ??
    (activeThread
      ? projectsByKey.get(
          scopedProjectKeyOf({
            environmentId: activeThread.environmentId,
            id: activeThread.projectId,
          }),
        )
      : undefined) ??
    projects[0] ??
    null;

  const startNewChat = useCallback(
    async (project: EnvironmentProject | null, folderId: string | null) => {
      if (!project) {
        reportFailure(
          "No project to start a chat in",
          new Error("Add a project in Code mode first."),
        );
        return;
      }
      try {
        const created = await handleNewThread(scopeProjectRef(project.environmentId, project.id));
        if (created && folderId !== null) {
          useWorkModeStore
            .getState()
            .moveThreadsToFolder(
              [scopedThreadKey(scopeThreadRef(project.environmentId, created.threadId))],
              folderId,
            );
        }
      } catch (error) {
        reportFailure("Could not start a chat", error);
      }
    },
    [handleNewThread],
  );

  const createFolder = useCallback((parentId: string | null) => {
    const id = useWorkModeStore.getState().createFolder("New folder", parentId);
    setRenamingFolderId(id);
  }, []);

  const openThread = useCallback(
    (thread: SidebarThreadSummary) => {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
      });
    },
    [navigate],
  );

  const handleDrop = useCallback((event: DragEvent, target: DropTarget) => {
    const payload = readDragPayload(event);
    setDropTarget(null);
    if (!payload) return;
    event.preventDefault();
    const store = useWorkModeStore.getState();
    const folderId = target.kind === "folder" ? target.folderId : null;
    if (payload.kind === "thread") {
      store.moveThreadsToFolder([payload.id], folderId);
    } else {
      store.moveFolder(payload.id, folderId);
    }
  }, []);

  const dropHandlers = useCallback(
    (target: DropTarget) => ({
      onDragOver: (event: DragEvent) => {
        if (!isWorkDrag(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setDropTarget((current) =>
          current?.kind === target.kind &&
          (current.kind === "unfiled" ||
            (target.kind === "folder" && current.folderId === target.folderId))
            ? current
            : target,
        );
      },
      onDragLeave: (event: DragEvent) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDropTarget((current) => (current === null ? current : null));
      },
      onDrop: (event: DragEvent) => handleDrop(event, target),
    }),
    [handleDrop],
  );

  useEffect(() => {
    const clear = () => setDropTarget(null);
    window.addEventListener("dragend", clear);
    return () => window.removeEventListener("dragend", clear);
  }, []);

  const showThreadMenu = useCallback(
    async (event: MouseEvent, thread: SidebarThreadSummary) => {
      event.preventDefault();
      const api = readLocalApi();
      if (!api) return;
      const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      const currentFolderId = resolveThreadFolderId({ folders, threadFolderByKey }, threadKey);
      const folderItems = flattenTree(tree).map(({ folder, depth }) => ({
        id: `move:${folder.id}`,
        label: `${"  ".repeat(depth)}${folder.name}`,
        disabled: folder.id === currentFolderId,
      }));
      const choice = await api.contextMenu.show(
        [
          ...(folderItems.length > 0
            ? [{ id: "move", label: "Move to folder", children: folderItems }]
            : []),
          { id: "new-folder", label: "Move to new folder" },
          ...(currentFolderId !== null ? [{ id: "unfile", label: "Remove from folder" }] : []),
          { id: "archive", label: "Archive", separatorBefore: true },
        ],
        { x: event.clientX, y: event.clientY },
      );
      if (!choice) return;
      const store = useWorkModeStore.getState();
      if (choice.startsWith("move:")) {
        store.moveThreadsToFolder([threadKey], choice.slice("move:".length));
      } else if (choice === "new-folder") {
        const folderId = store.createFolder("New folder", currentFolderId);
        useWorkModeStore.getState().moveThreadsToFolder([threadKey], folderId);
        setRenamingFolderId(folderId);
      } else if (choice === "unfile") {
        store.moveThreadsToFolder([threadKey], null);
      } else if (choice === "archive") {
        const result = await archiveThread(scopeThreadRef(thread.environmentId, thread.id));
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          reportFailure("Could not archive the chat", squashAtomCommandFailure(result));
        }
      }
    },
    [archiveThread, folders, threadFolderByKey, tree],
  );

  const showFolderMenu = useCallback(
    async (event: MouseEvent, node: WorkFolderNode) => {
      event.preventDefault();
      event.stopPropagation();
      const api = readLocalApi();
      if (!api) return;
      const choice = await api.contextMenu.show(
        [
          { id: "new-chat", label: "New chat here" },
          { id: "new-subfolder", label: "New subfolder" },
          { id: "rename", label: "Rename", separatorBefore: true },
          ...(node.folder.parentId !== null
            ? [{ id: "move-top", label: "Move to top level" }]
            : []),
          { id: "delete", label: "Delete folder", destructive: true, separatorBefore: true },
        ],
        { x: event.clientX, y: event.clientY },
      );
      const store = useWorkModeStore.getState();
      switch (choice) {
        case "new-chat":
          void startNewChat(newChatProject, node.folder.id);
          break;
        case "new-subfolder":
          createFolder(node.folder.id);
          break;
        case "rename":
          setRenamingFolderId(node.folder.id);
          break;
        case "move-top":
          store.moveFolder(node.folder.id, null);
          break;
        case "delete": {
          const confirmed = await api.dialogs.confirm(
            `Delete "${node.folder.name}"? Its chats and subfolders move up one level. No chats are deleted.`,
          );
          if (confirmed) store.deleteFolder(node.folder.id);
          break;
        }
      }
    },
    [createFolder, newChatProject, startNewChat],
  );

  const renderThread = (thread: SidebarThreadSummary, depth: number) => {
    const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    return (
      <WorkThreadRow
        key={threadKey}
        thread={thread}
        threadKey={threadKey}
        depth={depth}
        isActive={threadKey === activeThreadKey}
        lastVisitedAt={lastVisitedById[threadKey]}
        projectTitle={
          projectsByKey.get(
            scopedProjectKeyOf({ environmentId: thread.environmentId, id: thread.projectId }),
          )?.title ?? null
        }
        onOpen={openThread}
        onContextMenu={showThreadMenu}
      />
    );
  };

  const renderFolder = (node: WorkFolderNode) => {
    const collapsed = collapsedFolderIds.includes(node.folder.id);
    const folderThreads = byFolderId.get(node.folder.id) ?? [];
    const isDropTarget = dropTarget?.kind === "folder" && dropTarget.folderId === node.folder.id;
    return (
      <div key={node.folder.id} role="treeitem" aria-expanded={!collapsed}>
        <div
          className={cn(
            "group/folder flex h-7 cursor-pointer items-center gap-1 rounded-md pr-1 text-sm text-sidebar-foreground hover:bg-sidebar-accent",
            isDropTarget && "bg-sidebar-accent ring-1 ring-primary/50",
          )}
          style={{ paddingLeft: 4 + node.depth * INDENT_PX }}
          draggable={renamingFolderId !== node.folder.id}
          onDragStart={(event) => {
            event.dataTransfer.setData(FOLDER_DRAG_TYPE, node.folder.id);
            event.dataTransfer.effectAllowed = "move";
          }}
          onClick={() => useWorkModeStore.getState().setFolderCollapsed(node.folder.id, !collapsed)}
          onDoubleClick={() => setRenamingFolderId(node.folder.id)}
          onContextMenu={(event) => void showFolderMenu(event, node)}
          {...dropHandlers({ kind: "folder", folderId: node.folder.id })}
        >
          <ChevronRightIcon
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              !collapsed && "rotate-90",
            )}
          />
          {collapsed ? (
            <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <FolderOpenIcon className="size-4 shrink-0 text-muted-foreground" />
          )}
          {renamingFolderId === node.folder.id ? (
            <FolderNameInput
              initialName={node.folder.name}
              onCommit={(name) => {
                useWorkModeStore.getState().renameFolder(node.folder.id, name);
                setRenamingFolderId(null);
              }}
              onCancel={() => setRenamingFolderId(null)}
            />
          ) : (
            <span className="min-w-0 flex-1 truncate">{node.folder.name}</span>
          )}
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums group-hover/folder:hidden">
            {countFolderThreads(node, byFolderId) || ""}
          </span>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label={`New chat in ${node.folder.name}`}
                  className="hidden group-hover/folder:inline-flex"
                  size="icon-xs"
                  variant="ghost"
                  onClick={(event) => {
                    event.stopPropagation();
                    void startNewChat(newChatProject, node.folder.id);
                  }}
                />
              }
            >
              <PlusIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">New chat here</TooltipPopup>
          </Tooltip>
        </div>
        {collapsed ? null : (
          <div role="group">
            {node.children.map(renderFolder)}
            {folderThreads.map((thread) => renderThread(thread, node.depth + 1))}
            {node.children.length === 0 && folderThreads.length === 0 ? (
              <p
                className="py-1 text-xs text-muted-foreground/70"
                style={{ paddingLeft: 26 + (node.depth + 1) * INDENT_PX }}
              >
                Drag chats here
              </p>
            ) : null}
          </div>
        )}
      </div>
    );
  };

  const visibleUnfiled = showAllUnfiled ? unfiled : unfiled.slice(0, UNFILED_PREVIEW_COUNT);

  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <div className="flex shrink-0 flex-col gap-0.5 px-[var(--sidebar-content-inset,0.5rem)] pb-2">
        <div className="flex items-center gap-1">
          <Button
            className="min-w-0 flex-1 justify-start gap-2"
            size="sm"
            variant="ghost"
            onClick={() => void startNewChat(newChatProject, null)}
          >
            <SquarePenIcon className="size-4" />
            <span className="truncate">New chat</span>
          </Button>
          <NewChatProjectMenu
            projects={projects}
            selectedProject={newChatProject}
            onSelect={(project) =>
              useWorkModeStore.getState().setDefaultProjectKey(scopedProjectKeyOf(project))
            }
          />
        </div>
        <Button
          className="justify-start gap-2"
          size="sm"
          variant="ghost"
          onClick={() => openCommandPalette()}
        >
          <SearchIcon className="size-4" />
          Search
        </Button>
      </div>
      <SidebarContent className="gap-0 px-[var(--sidebar-content-inset,0.5rem)] pb-2">
        <div className="flex h-7 items-center justify-between px-1">
          <span className="text-xs font-medium text-muted-foreground">Folders</span>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label="New folder"
                  size="icon-xs"
                  variant="ghost"
                  onClick={() => createFolder(null)}
                />
              }
            >
              <FolderPlusIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">New folder</TooltipPopup>
          </Tooltip>
        </div>
        <div role="tree" aria-label="Folders">
          {tree.length === 0 ? (
            <p className="px-1 py-1 text-xs text-muted-foreground/70">
              Create a folder, then drag chats into it.
            </p>
          ) : (
            tree.map(renderFolder)
          )}
        </div>
        <div
          className={cn(
            "mt-3 flex h-7 items-center gap-1.5 rounded-md px-1 text-xs font-medium text-muted-foreground",
            dropTarget?.kind === "unfiled" && "bg-sidebar-accent ring-1 ring-primary/50",
          )}
          {...dropHandlers({ kind: "unfiled" })}
        >
          <MessagesSquareIcon className="size-3.5" />
          Chats
        </div>
        <div {...dropHandlers({ kind: "unfiled" })}>
          {visibleUnfiled.map((thread) => renderThread(thread, 0))}
          {unfiled.length > UNFILED_PREVIEW_COUNT ? (
            <button
              type="button"
              className="w-full cursor-pointer rounded-md px-2 py-1 text-left text-xs text-muted-foreground hover:bg-sidebar-accent"
              onClick={() => setShowAllUnfiled((current) => !current)}
            >
              {showAllUnfiled ? "Show less" : `Show ${unfiled.length - UNFILED_PREVIEW_COUNT} more`}
            </button>
          ) : null}
        </div>
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}

function scopedProjectKeyOf(project: Pick<EnvironmentProject, "environmentId" | "id">): string {
  return scopedProjectKey(scopeProjectRef(project.environmentId, project.id));
}

function flattenTree(nodes: ReadonlyArray<WorkFolderNode>): WorkFolderNode[] {
  return nodes.flatMap((node) => [node, ...flattenTree(node.children)]);
}

function NewChatProjectMenu(props: {
  projects: ReadonlyArray<EnvironmentProject>;
  selectedProject: EnvironmentProject | null;
  onSelect: (project: EnvironmentProject) => void;
}) {
  if (props.projects.length < 2) return null;
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  aria-label="Choose the project for new chats"
                  className="max-w-28 gap-1 px-1.5 text-xs text-muted-foreground"
                  size="sm"
                  variant="ghost"
                />
              }
            />
          }
        >
          <span className="truncate">{props.selectedProject?.title ?? "Project"}</span>
        </TooltipTrigger>
        <TooltipPopup side="top">Project for new chats</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" className="max-h-80 w-60">
        <MenuGroupLabel>New chats start in</MenuGroupLabel>
        {props.projects.map((project) => (
          <MenuItem key={scopedProjectKeyOf(project)} onClick={() => props.onSelect(project)}>
            <span
              className={cn(
                "min-w-0 flex-1 truncate",
                props.selectedProject &&
                  scopedProjectKeyOf(props.selectedProject) === scopedProjectKeyOf(project) &&
                  "font-medium",
              )}
            >
              {project.title}
            </span>
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

function FolderNameInput(props: {
  initialName: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const settledRef = useRef(false);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const settle = (commit: boolean) => {
    if (settledRef.current) return;
    settledRef.current = true;
    const value = inputRef.current?.value ?? "";
    if (commit && value.trim().length > 0) props.onCommit(value);
    else props.onCancel();
  };
  return (
    <input
      ref={inputRef}
      aria-label="Folder name"
      className="h-6 min-w-0 flex-1 rounded border border-border bg-background px-1 text-sm outline-none focus:ring-1 focus:ring-ring"
      defaultValue={props.initialName}
      onClick={(event) => event.stopPropagation()}
      onBlur={() => settle(true)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") settle(true);
        if (event.key === "Escape") settle(false);
      }}
    />
  );
}

const WorkThreadRow = memo(function WorkThreadRow(props: {
  thread: SidebarThreadSummary;
  threadKey: string;
  depth: number;
  isActive: boolean;
  lastVisitedAt: string | undefined;
  projectTitle: string | null;
  onOpen: (thread: SidebarThreadSummary) => void;
  onContextMenu: (event: MouseEvent, thread: SidebarThreadSummary) => void;
}) {
  const { thread } = props;
  const status = resolveThreadStatusPill({
    thread: { ...thread, lastVisitedAt: props.lastVisitedAt },
  });
  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      data-active={props.isActive ? "true" : undefined}
      className={cn(
        "group/thread flex h-7 cursor-pointer items-center gap-1.5 rounded-md pr-2 text-sm text-sidebar-foreground/90 outline-none hover:bg-sidebar-accent focus-visible:ring-1 focus-visible:ring-ring",
        props.isActive && "bg-sidebar-accent font-medium text-sidebar-foreground",
      )}
      style={{ paddingLeft: 8 + props.depth * INDENT_PX + (props.depth > 0 ? 14 : 0) }}
      aria-label={props.projectTitle ? `${thread.title}, ${props.projectTitle}` : thread.title}
      onDragStart={(event) => {
        event.dataTransfer.setData(THREAD_DRAG_TYPE, props.threadKey);
        event.dataTransfer.effectAllowed = "move";
      }}
      onClick={() => props.onOpen(thread)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          props.onOpen(thread);
        }
      }}
      onContextMenu={(event) => props.onContextMenu(event, thread)}
    >
      {status ? <ThreadStatusLabel status={status} compact /> : null}
      <span className="min-w-0 flex-1 truncate">{thread.title}</span>
      <span className="shrink-0 text-xs text-muted-foreground/80">
        {formatRelativeTimeLabel(thread.latestUserMessageAt ?? thread.updatedAt)}
      </span>
    </div>
  );
});
