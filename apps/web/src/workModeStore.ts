/**
 * T3 Work client state: the Code/Work mode switch and Work's projects.
 *
 * Work projects are user-created and not tied to a repository. They are a
 * client-side organization layer over server threads: the server still owns
 * every thread and its repository project; this store only records which Work
 * project a thread is filed in, keyed by `scopedThreadKey`. A thread without an
 * entry shows under Chats. Deleting a Work project never deletes threads: its
 * chats move to its parent, or back to Chats.
 *
 * Persisted field names (`folders`, `threadFolderByKey`) predate the
 * "project" naming and are kept so saved data carries over.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";
import { randomUUID } from "./lib/utils";

export type AppMode = "code" | "work";

export interface WorkFolder {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: string;
}

export interface WorkModeData {
  mode: AppMode;
  folders: WorkFolder[];
  threadFolderByKey: Record<string, string>;
  collapsedFolderIds: string[];
  /** Scoped project key that new Work chats start in, or null for the first project. */
  defaultProjectKey: string | null;
}

export const WORK_MODE_STORAGE_KEY = "t3work:work-mode:v1";

export const initialWorkModeData: WorkModeData = {
  mode: "code",
  folders: [],
  threadFolderByKey: {},
  collapsedFolderIds: [],
  defaultProjectKey: null,
};

function normalizeFolderName(name: string): string | null {
  const trimmed = name.trim().replace(/\s+/g, " ");
  return trimmed.length > 0 ? trimmed : null;
}

function folderExists(data: WorkModeData, folderId: string | null): boolean {
  return folderId === null || data.folders.some((folder) => folder.id === folderId);
}

/** The folder and every folder nested below it. */
export function collectFolderSubtreeIds(
  folders: ReadonlyArray<WorkFolder>,
  folderId: string,
): Set<string> {
  const subtree = new Set([folderId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const folder of folders) {
      if (folder.parentId !== null && subtree.has(folder.parentId) && !subtree.has(folder.id)) {
        subtree.add(folder.id);
        grew = true;
      }
    }
  }
  return subtree;
}

export function createFolder(
  data: WorkModeData,
  input: { id: string; name: string; parentId: string | null; createdAt: string },
): WorkModeData {
  const name = normalizeFolderName(input.name);
  if (!name || !folderExists(data, input.parentId)) return data;
  if (data.folders.some((folder) => folder.id === input.id)) return data;
  return {
    ...data,
    folders: [
      ...data.folders,
      { id: input.id, name, parentId: input.parentId, createdAt: input.createdAt },
    ],
    // Opening the parent shows the folder that was just created.
    collapsedFolderIds: data.collapsedFolderIds.filter((id) => id !== input.parentId),
  };
}

export function renameFolder(data: WorkModeData, folderId: string, name: string): WorkModeData {
  const normalized = normalizeFolderName(name);
  if (!normalized) return data;
  let changed = false;
  const folders = data.folders.map((folder) => {
    if (folder.id !== folderId || folder.name === normalized) return folder;
    changed = true;
    return { ...folder, name: normalized };
  });
  return changed ? { ...data, folders } : data;
}

/** Remove a folder. Its subfolders and threads move to the folder's parent. */
export function deleteFolder(data: WorkModeData, folderId: string): WorkModeData {
  const folder = data.folders.find((entry) => entry.id === folderId);
  if (!folder) return data;
  const threadFolderByKey: Record<string, string> = {};
  for (const [threadKey, threadFolderId] of Object.entries(data.threadFolderByKey)) {
    if (threadFolderId !== folderId) {
      threadFolderByKey[threadKey] = threadFolderId;
    } else if (folder.parentId !== null) {
      threadFolderByKey[threadKey] = folder.parentId;
    }
  }
  return {
    ...data,
    folders: data.folders
      .filter((entry) => entry.id !== folderId)
      .map((entry) =>
        entry.parentId === folderId ? { ...entry, parentId: folder.parentId } : entry,
      ),
    threadFolderByKey,
    collapsedFolderIds: data.collapsedFolderIds.filter((id) => id !== folderId),
  };
}

/** Move a folder under another folder, or to the top level. Refuses to create a cycle. */
export function moveFolder(
  data: WorkModeData,
  folderId: string,
  parentId: string | null,
): WorkModeData {
  const folder = data.folders.find((entry) => entry.id === folderId);
  if (!folder || folder.parentId === parentId || !folderExists(data, parentId)) return data;
  if (parentId !== null && collectFolderSubtreeIds(data.folders, folderId).has(parentId)) {
    return data;
  }
  return {
    ...data,
    folders: data.folders.map((entry) => (entry.id === folderId ? { ...entry, parentId } : entry)),
  };
}

/** File threads in a Work project, or return them to Chats with `null`. */
export function fileThreads(
  data: WorkModeData,
  threadKeys: ReadonlyArray<string>,
  projectId: string | null,
): WorkModeData {
  if (!folderExists(data, projectId) || threadKeys.length === 0) return data;
  if (projectId === null && !threadKeys.some((threadKey) => threadKey in data.threadFolderByKey)) {
    return data;
  }
  const threadFolderByKey = { ...data.threadFolderByKey };
  for (const threadKey of threadKeys) {
    if (projectId === null) {
      delete threadFolderByKey[threadKey];
    } else {
      threadFolderByKey[threadKey] = projectId;
    }
  }
  return { ...data, threadFolderByKey };
}

export function setFolderCollapsed(
  data: WorkModeData,
  folderId: string,
  collapsed: boolean,
): WorkModeData {
  const isCollapsed = data.collapsedFolderIds.includes(folderId);
  if (isCollapsed === collapsed) return data;
  return {
    ...data,
    collapsedFolderIds: collapsed
      ? [...data.collapsedFolderIds, folderId]
      : data.collapsedFolderIds.filter((id) => id !== folderId),
  };
}

/** The Work project a thread is filed in, or null when it shows under Chats. */
export function resolveThreadWorkProjectId(
  data: Pick<WorkModeData, "folders" | "threadFolderByKey">,
  threadKey: string,
): string | null {
  const projectId = data.threadFolderByKey[threadKey];
  if (!projectId) return null;
  return data.folders.some((folder) => folder.id === projectId) ? projectId : null;
}

export interface WorkFolderNode {
  folder: WorkFolder;
  depth: number;
  children: WorkFolderNode[];
}

const folderNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Build the folder tree, with siblings sorted by name. */
export function buildWorkFolderTree(folders: ReadonlyArray<WorkFolder>): WorkFolderNode[] {
  const knownIds = new Set(folders.map((folder) => folder.id));
  const childrenByParent = new Map<string | null, WorkFolder[]>();
  for (const folder of folders) {
    // A folder whose parent is missing is shown at the top level instead of disappearing.
    const parentId =
      folder.parentId !== null && knownIds.has(folder.parentId) ? folder.parentId : null;
    const siblings = childrenByParent.get(parentId) ?? [];
    siblings.push(folder);
    childrenByParent.set(parentId, siblings);
  }
  const visited = new Set<string>();
  const build = (parentId: string | null, depth: number): WorkFolderNode[] =>
    (childrenByParent.get(parentId) ?? [])
      .toSorted((left, right) => folderNameCollator.compare(left.name, right.name))
      .flatMap((folder) => {
        if (visited.has(folder.id)) return [];
        visited.add(folder.id);
        return [{ folder, depth, children: build(folder.id, depth + 1) }];
      });
  return build(null, 0);
}

function sanitizePersistedData(value: unknown): WorkModeData {
  if (!value || typeof value !== "object") return initialWorkModeData;
  const raw = value as Partial<Record<keyof WorkModeData, unknown>>;
  const folders = Array.isArray(raw.folders)
    ? raw.folders.filter(
        (folder): folder is WorkFolder =>
          !!folder &&
          typeof folder === "object" &&
          typeof folder.id === "string" &&
          typeof folder.name === "string" &&
          (folder.parentId === null || typeof folder.parentId === "string") &&
          typeof folder.createdAt === "string",
      )
    : [];
  const threadFolderByKey =
    raw.threadFolderByKey && typeof raw.threadFolderByKey === "object"
      ? Object.fromEntries(
          Object.entries(raw.threadFolderByKey).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "",
          ),
        )
      : {};
  return {
    mode: raw.mode === "work" ? "work" : "code",
    folders,
    threadFolderByKey,
    collapsedFolderIds: Array.isArray(raw.collapsedFolderIds)
      ? raw.collapsedFolderIds.filter((id): id is string => typeof id === "string")
      : [],
    defaultProjectKey: typeof raw.defaultProjectKey === "string" ? raw.defaultProjectKey : null,
  };
}

interface WorkModeStore extends WorkModeData {
  /** Work project whose name is being edited inline. Not persisted. */
  editingFolderId: string | null;
  setMode: (mode: AppMode) => void;
  createFolder: (name: string, parentId: string | null) => string;
  renameFolder: (folderId: string, name: string) => void;
  deleteFolder: (folderId: string) => void;
  moveFolder: (folderId: string, parentId: string | null) => void;
  fileThreads: (threadKeys: ReadonlyArray<string>, projectId: string | null) => void;
  setFolderCollapsed: (folderId: string, collapsed: boolean) => void;
  setEditingFolderId: (folderId: string | null) => void;
  setDefaultProjectKey: (projectKey: string | null) => void;
}

const pickData = (state: WorkModeStore): WorkModeData => ({
  mode: state.mode,
  folders: state.folders,
  threadFolderByKey: state.threadFolderByKey,
  collapsedFolderIds: state.collapsedFolderIds,
  defaultProjectKey: state.defaultProjectKey,
});

export const useWorkModeStore = create<WorkModeStore>()(
  persist(
    (set) => ({
      ...initialWorkModeData,
      editingFolderId: null,
      setMode: (mode) => set({ mode }),
      createFolder: (name, parentId) => {
        const id = randomUUID();
        set((state) =>
          createFolder(pickData(state), {
            id,
            name,
            parentId,
            createdAt: new Date().toISOString(),
          }),
        );
        return id;
      },
      renameFolder: (folderId, name) =>
        set((state) => renameFolder(pickData(state), folderId, name)),
      deleteFolder: (folderId) => set((state) => deleteFolder(pickData(state), folderId)),
      moveFolder: (folderId, parentId) =>
        set((state) => moveFolder(pickData(state), folderId, parentId)),
      fileThreads: (threadKeys, projectId) =>
        set((state) => fileThreads(pickData(state), threadKeys, projectId)),
      setFolderCollapsed: (folderId, collapsed) =>
        set((state) => setFolderCollapsed(pickData(state), folderId, collapsed)),
      setEditingFolderId: (editingFolderId) => set({ editingFolderId }),
      setDefaultProjectKey: (defaultProjectKey) => set({ defaultProjectKey }),
    }),
    {
      name: WORK_MODE_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: pickData,
      merge: (persisted, current) => ({ ...current, ...sanitizePersistedData(persisted) }),
    },
  ),
);

export function useAppMode(): AppMode {
  return useWorkModeStore((state) => state.mode);
}

export function useIsWorkMode(): boolean {
  return useWorkModeStore((state) => state.mode === "work");
}

/** Non-reactive read for event handlers that should not re-subscribe on mode changes. */
export function isWorkModeActive(): boolean {
  return useWorkModeStore.getState().mode === "work";
}
