import type { EnvironmentId } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import type { SidebarThreadSummary } from "../../types";
import { CHATS_ROOT, initialWorkModeData, useWorkModeStore } from "../../workModeStore";
import {
  applyWorkThreadMenuAction,
  buildWorkThreadMenuItems,
  groupChatsThreads,
} from "./workChats.logic";

const environmentId = "env-1" as EnvironmentId;
const createdAt = "2026-09-01T00:00:00.000Z";
const folders = [
  { id: "f1", name: "Clients", parentId: null, createdAt },
  { id: "f2", name: "Acme", parentId: "f1", createdAt },
];

function thread(id: string, overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    id: ThreadId.make(id),
    environmentId,
    title: id,
    archivedAt: null,
    createdAt,
    updatedAt: createdAt,
    latestUserMessageAt: null,
    ...overrides,
  } as SidebarThreadSummary;
}

afterEach(() => {
  useWorkModeStore.setState({ ...initialWorkModeData, editingFolderId: null });
});

describe("groupChatsThreads", () => {
  it("keeps project threads out and shows unknown folders at the top of Chats", () => {
    const groups = groupChatsThreads(
      [thread("a"), thread("b"), thread("c"), thread("d", { archivedAt: createdAt })],
      {
        folders,
        threadFolderByKey: { "env-1:a": "f2", "env-1:b": "gone", "env-1:d": CHATS_ROOT },
      },
      "updated_at",
    );
    expect(groups.byFolderId.get("f2")?.map((entry) => entry.id)).toEqual(["a"]);
    expect(groups.root.map((entry) => entry.id)).toEqual(["b"]);
  });
});

describe("buildWorkThreadMenuItems", () => {
  it("offers Move to Chats for project threads", () => {
    const items = buildWorkThreadMenuItems({ folders, threadFolderByKey: {} }, ["env-1:a"]);
    expect(items.map((item) => item.label)).toEqual(["Move to Chats", "Move to folder"]);
    expect(items[1]?.children?.map((item) => item.label.trim())).toEqual([
      "Clients",
      "Acme",
      "New folder",
    ]);
  });

  it("offers leaving a folder and returning to the project for filed threads", () => {
    const items = buildWorkThreadMenuItems({ folders, threadFolderByKey: { "env-1:a": "f2" } }, [
      "env-1:a",
    ]);
    expect(items.map((item) => item.label)).toEqual([
      "Move to folder",
      "Move out of folder",
      "Move back to project",
    ]);
    expect(items[0]?.children?.map((item) => item.label.trim())).toEqual(["Clients", "New folder"]);
  });

  it("offers one Move to Chats entry for a mixed selection", () => {
    const items = buildWorkThreadMenuItems({ folders, threadFolderByKey: { "env-1:a": "f2" } }, [
      "env-1:a",
      "env-1:b",
    ]);
    expect(items.map((item) => item.label)).toEqual(["Move to Chats", "Move to folder"]);
  });

  it("offers a new folder directly when none exist", () => {
    const items = buildWorkThreadMenuItems({ folders: [], threadFolderByKey: {} }, ["env-1:a"]);
    expect(items.map((item) => item.label)).toEqual(["Move to Chats", "Move to new folder"]);
  });
});

describe("applyWorkThreadMenuAction", () => {
  it("moves threads and ignores ids that are not Work entries", () => {
    useWorkModeStore.setState({ folders });
    expect(applyWorkThreadMenuAction("rename", ["env-1:a"])).toBe(false);
    expect(applyWorkThreadMenuAction("work:folder:f1", ["env-1:a"])).toBe(true);
    expect(useWorkModeStore.getState().threadFolderByKey).toEqual({ "env-1:a": "f1" });
    applyWorkThreadMenuAction("work:chats-root", ["env-1:a"]);
    expect(useWorkModeStore.getState().threadFolderByKey).toEqual({ "env-1:a": CHATS_ROOT });
    applyWorkThreadMenuAction("work:project", ["env-1:a"]);
    expect(useWorkModeStore.getState().threadFolderByKey).toEqual({});
  });

  it("creates a folder, files the threads, and starts renaming it", () => {
    applyWorkThreadMenuAction("work:new-folder", ["env-1:a"]);
    const state = useWorkModeStore.getState();
    expect(state.folders).toHaveLength(1);
    expect(state.threadFolderByKey["env-1:a"]).toBe(state.folders[0]?.id);
    expect(state.editingFolderId).toBe(state.folders[0]?.id);
  });
});
