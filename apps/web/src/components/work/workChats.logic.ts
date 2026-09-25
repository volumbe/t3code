/**
 * Work mode's Chats section: grouping, drag payloads, and the thread context
 * menu entries that move threads between projects, Chats, and folders.
 */
import type { ContextMenuItem } from "@t3tools/contracts";
import type { SidebarThreadSortOrder } from "@t3tools/contracts/settings";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";

import { sortThreads } from "../../lib/threadSort";
import type { SidebarThreadSummary } from "../../types";
import {
  buildWorkFolderTree,
  isWorkModeActive,
  resolveThreadPlacement,
  useWorkModeStore,
  type WorkFolderNode,
  type WorkModeData,
} from "../../workModeStore";

export const WORK_THREAD_DRAG_TYPE = "application/x-t3work-threads";
export const WORK_FOLDER_DRAG_TYPE = "application/x-t3work-folder";
/** Marks a thread drag that includes threads already in Chats; data is not readable during dragover. */
export const WORK_FROM_CHATS_DRAG_TYPE = "application/x-t3work-from-chats";

export interface WorkChatsGroups {
  byFolderId: ReadonlyMap<string, SidebarThreadSummary[]>;
  root: SidebarThreadSummary[];
}

/** Unarchived threads that were moved into Chats, grouped by folder and sorted. */
export function groupChatsThreads(
  threads: ReadonlyArray<SidebarThreadSummary>,
  data: Pick<WorkModeData, "folders" | "threadFolderByKey">,
  sortOrder: SidebarThreadSortOrder,
): WorkChatsGroups {
  const byFolderId = new Map<string, SidebarThreadSummary[]>();
  const root: SidebarThreadSummary[] = [];
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    const placement = resolveThreadPlacement(
      data,
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
    );
    if (placement.kind !== "chats") continue;
    if (placement.folderId === null) {
      root.push(thread);
    } else {
      const list = byFolderId.get(placement.folderId) ?? [];
      list.push(thread);
      byFolderId.set(placement.folderId, list);
    }
  }
  for (const [folderId, list] of byFolderId) {
    byFolderId.set(folderId, sortThreads(list, sortOrder));
  }
  return { byFolderId, root: sortThreads(root, sortOrder) };
}

export function flattenFolderTree(nodes: ReadonlyArray<WorkFolderNode>): WorkFolderNode[] {
  return nodes.flatMap((node) => [node, ...flattenFolderTree(node.children)]);
}

const MENU_CHATS_ROOT = "work:chats-root";
const MENU_NEW_FOLDER = "work:new-folder";
const MENU_PROJECT = "work:project";
const MENU_FOLDER_PREFIX = "work:folder:";

/**
 * Context menu entries for moving threads in Work mode. Empty outside Work
 * mode, so Code mode menus are unchanged.
 */
export function buildWorkThreadMenuItems(
  data: Pick<WorkModeData, "folders" | "threadFolderByKey">,
  threadKeys: ReadonlyArray<string>,
): ContextMenuItem<string>[] {
  if (threadKeys.length === 0) return [];
  const placements = threadKeys.map((threadKey) => resolveThreadPlacement(data, threadKey));
  const anyInProject = placements.some((placement) => placement.kind === "project");
  const anyInFolder = placements.some(
    (placement) => placement.kind === "chats" && placement.folderId !== null,
  );
  const sharedFolderId =
    placements.every((placement) => placement.kind === "chats") &&
    new Set(placements.map((placement) => (placement.kind === "chats" ? placement.folderId : null)))
      .size === 1 &&
    placements[0]?.kind === "chats"
      ? placements[0].folderId
      : undefined;

  const folderItems: ContextMenuItem<string>[] = flattenFolderTree(
    buildWorkFolderTree(data.folders),
  )
    .filter((node) => node.folder.id !== sharedFolderId)
    .map((node) => ({
      id: `${MENU_FOLDER_PREFIX}${node.folder.id}`,
      label: `${"   ".repeat(node.depth)}${node.folder.name}`,
    }));

  const items: ContextMenuItem<string>[] = [];
  if (anyInProject) {
    items.push({ id: MENU_CHATS_ROOT, label: "Move to Chats" });
  }
  items.push(
    folderItems.length > 0
      ? {
          id: "work:folder-submenu",
          label: "Move to folder",
          children: [
            ...folderItems,
            { id: MENU_NEW_FOLDER, label: "New folder", separatorBefore: true },
          ],
        }
      : { id: MENU_NEW_FOLDER, label: "Move to new folder" },
  );
  if (anyInFolder && !anyInProject) {
    items.push({ id: MENU_CHATS_ROOT, label: "Move out of folder" });
  }
  if (!anyInProject) {
    items.push({ id: MENU_PROJECT, label: "Move back to project" });
  }
  return items;
}

/** `buildWorkThreadMenuItems` against the live store, or nothing outside Work mode. */
export function buildWorkThreadMenuItemsForKeys(
  threadKeys: ReadonlyArray<string>,
): ContextMenuItem<string>[] {
  if (!isWorkModeActive()) return [];
  return buildWorkThreadMenuItems(useWorkModeStore.getState(), threadKeys);
}

/** Apply a Work menu entry. Returns false for ids that are not Work entries. */
export function applyWorkThreadMenuAction(
  clicked: string,
  threadKeys: ReadonlyArray<string>,
): boolean {
  const store = useWorkModeStore.getState();
  if (clicked === MENU_CHATS_ROOT) {
    store.moveThreadsToChats(threadKeys, null);
    return true;
  }
  if (clicked === MENU_PROJECT) {
    store.returnThreadsToProjects(threadKeys);
    return true;
  }
  if (clicked === MENU_NEW_FOLDER) {
    const folderId = store.createFolder("New folder", null);
    store.moveThreadsToChats(threadKeys, folderId);
    store.setEditingFolderId(folderId);
    return true;
  }
  if (clicked.startsWith(MENU_FOLDER_PREFIX)) {
    store.moveThreadsToChats(threadKeys, clicked.slice(MENU_FOLDER_PREFIX.length));
    return true;
  }
  return false;
}

export type WorkDragPayload =
  | { readonly kind: "threads"; readonly threadKeys: string[] }
  | { readonly kind: "folder"; readonly folderId: string };

export function isWorkDrag(dataTransfer: DataTransfer): boolean {
  return (
    dataTransfer.types.includes(WORK_THREAD_DRAG_TYPE) ||
    dataTransfer.types.includes(WORK_FOLDER_DRAG_TYPE)
  );
}

export function isWorkDragFromChats(dataTransfer: DataTransfer): boolean {
  return dataTransfer.types.includes(WORK_FROM_CHATS_DRAG_TYPE);
}

export function writeWorkThreadDrag(dataTransfer: DataTransfer, threadKeys: string[]): void {
  dataTransfer.effectAllowed = "move";
  dataTransfer.setData(WORK_THREAD_DRAG_TYPE, JSON.stringify(threadKeys));
  const data = useWorkModeStore.getState();
  if (threadKeys.some((threadKey) => threadKey in data.threadFolderByKey)) {
    dataTransfer.setData(WORK_FROM_CHATS_DRAG_TYPE, "1");
  }
}

export function readWorkDragPayload(dataTransfer: DataTransfer): WorkDragPayload | null {
  const threads = dataTransfer.getData(WORK_THREAD_DRAG_TYPE);
  if (threads) {
    try {
      const parsed: unknown = JSON.parse(threads);
      if (Array.isArray(parsed)) {
        const threadKeys = parsed.filter((key): key is string => typeof key === "string");
        if (threadKeys.length > 0) return { kind: "threads", threadKeys };
      }
    } catch {
      return null;
    }
    return null;
  }
  const folderId = dataTransfer.getData(WORK_FOLDER_DRAG_TYPE);
  return folderId ? { kind: "folder", folderId } : null;
}
