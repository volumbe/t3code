import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveDockChatTitle, listDockChatCandidates } from "./DockChatPanel";
import { groupThreadsByFolder } from "./WorkSidebar";

const environmentId = "env-1" as EnvironmentId;

function shell(
  id: string,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  return {
    id: ThreadId.make(id),
    environmentId,
    title: id,
    archivedAt: null,
    updatedAt: "2026-09-20T00:00:00.000Z",
    latestUserMessageAt: null,
    ...overrides,
  } as EnvironmentThreadShell;
}

describe("deriveDockChatTitle", () => {
  it("uses the first line and truncates long titles", () => {
    expect(deriveDockChatTitle("  Plan the offsite\nwith details")).toBe("Plan the offsite");
    expect(deriveDockChatTitle("x".repeat(80))).toHaveLength(60);
    expect(deriveDockChatTitle("   ")).toBe("New chat");
  });
});

describe("listDockChatCandidates", () => {
  it("drops the host and archived chats, most recent first", () => {
    const threads = [
      shell("host"),
      shell("old", { latestUserMessageAt: "2026-09-01T00:00:00.000Z" }),
      shell("new", { latestUserMessageAt: "2026-09-23T00:00:00.000Z" }),
      shell("archived", { archivedAt: "2026-09-22T00:00:00.000Z" }),
    ];
    const candidates = listDockChatCandidates(
      threads,
      scopeThreadRef(environmentId, ThreadId.make("host")),
    );
    expect(candidates.map((thread) => thread.id)).toEqual(["new", "old"]);
  });
});

describe("groupThreadsByFolder", () => {
  it("files threads by folder and treats unknown folders as unfiled", () => {
    const folders = [
      { id: "f1", name: "Clients", parentId: null, createdAt: "2026-09-01T00:00:00.000Z" },
    ];
    const { byFolderId, unfiled } = groupThreadsByFolder(
      [
        shell("a"),
        shell("b"),
        shell("c"),
        shell("gone", { archivedAt: "2026-09-02T00:00:00.000Z" }),
      ],
      {
        folders,
        threadFolderByKey: { "env-1:a": "f1", "env-1:b": "missing" },
      },
    );
    expect(byFolderId.get("f1")?.map((thread) => thread.id)).toEqual(["a"]);
    expect(unfiled.map((thread) => thread.id).toSorted()).toEqual(["b", "c"]);
  });
});
