import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DOCK_OTHER_CHATS_LIMIT, sectionDockChatCandidates } from "./DockChatPanel.logic";

const mac = EnvironmentId.make("env-mac");
const ubuntu = EnvironmentId.make("env-ubuntu");

function thread(
  environmentId: EnvironmentId,
  id: string,
  projectId: string,
  updatedAt: string,
  archivedAt: string | null = null,
): EnvironmentThreadShell {
  return {
    environmentId,
    id: ThreadId.make(id),
    projectId,
    title: id,
    updatedAt,
    latestUserMessageAt: null,
    archivedAt,
  } as unknown as EnvironmentThreadShell;
}

const hostThreadRef = scopeThreadRef(mac, ThreadId.make("host"));
const keyOf = (shell: EnvironmentThreadShell) =>
  scopedThreadKey(scopeThreadRef(shell.environmentId, shell.id));

describe("sectionDockChatCandidates", () => {
  it("orders Work project, then repo, then everything else, each chat once", () => {
    const filedOnUbuntu = thread(ubuntu, "filed-ubuntu", "other-repo", "2026-09-25T10:00:00Z");
    const filedInRepo = thread(mac, "filed-repo", "repo", "2026-09-25T09:00:00Z");
    const repoChat = thread(mac, "repo-chat", "repo", "2026-09-25T11:00:00Z");
    const sameIdOtherMachine = thread(ubuntu, "repo-chat-2", "repo", "2026-09-25T08:00:00Z");
    const archived = thread(
      mac,
      "archived",
      "repo",
      "2026-09-25T12:00:00Z",
      "2026-09-25T12:30:00Z",
    );
    const host = thread(mac, "host", "repo", "2026-09-25T13:00:00Z");

    const sections = sectionDockChatCandidates({
      threads: [filedOnUbuntu, filedInRepo, repoChat, sameIdOtherMachine, archived, host],
      hostThreadRef,
      hostProjectId: "repo",
      repoTitle: "machine",
      workProject: {
        name: "Affil Ops",
        threadKeys: new Set([keyOf(filedOnUbuntu), keyOf(filedInRepo)]),
      },
    });

    expect(sections.map((section) => [section.title, section.threads.map((t) => t.id)])).toEqual([
      ["In Affil Ops", ["filed-ubuntu", "filed-repo"]],
      ["In machine", ["repo-chat"]],
      ["Other chats", ["repo-chat-2"]],
    ]);
  });

  it("drops empty sections and caps other chats", () => {
    const others = Array.from({ length: DOCK_OTHER_CHATS_LIMIT + 5 }, (_, index) =>
      thread(
        ubuntu,
        `other-${index}`,
        "elsewhere",
        `2026-09-${String((index % 28) + 1).padStart(2, "0")}T00:00:00Z`,
      ),
    );
    const sections = sectionDockChatCandidates({
      threads: others,
      hostThreadRef,
      hostProjectId: "repo",
      repoTitle: "machine",
      workProject: null,
    });
    expect(sections.map((section) => section.id)).toEqual(["other"]);
    expect(sections[0]?.threads).toHaveLength(DOCK_OTHER_CHATS_LIMIT);
  });
});
