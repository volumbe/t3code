/** Pure helpers for the dock chat panel, kept apart from its ChatView-bound component. */
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ScopedThreadRef } from "@t3tools/contracts";

const TITLE_MAX_LENGTH = 60;

/** A short thread title from the first message, as the composer's first line. */
export function deriveDockChatTitle(text: string): string {
  const firstLine = text.trim().split("\n")[0]?.trim() ?? "";
  if (firstLine.length === 0) return "New chat";
  return firstLine.length > TITLE_MAX_LENGTH
    ? `${firstLine.slice(0, TITLE_MAX_LENGTH - 1).trimEnd()}…`
    : firstLine;
}

/** Other unarchived chats, most recent first. The host thread is excluded. */
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

export interface DockChatSection {
  id: "work-project" | "repo" | "other";
  title: string;
  threads: EnvironmentThreadShell[];
}

/** "Other chats" can span every project, so it lists only the most recent. */
export const DOCK_OTHER_CHATS_LIMIT = 30;

/**
 * Every other chat in up to three sections: the host's Work project, then the
 * host's repository project, then everything else. A chat appears once, in the
 * first section it matches, most recent first. Empty sections are dropped.
 */
export function sectionDockChatCandidates(input: {
  threads: ReadonlyArray<EnvironmentThreadShell>;
  hostThreadRef: ScopedThreadRef;
  hostProjectId: string;
  repoTitle: string;
  /** The host's Work project and the scoped keys of the chats filed in it. */
  workProject: { name: string; threadKeys: ReadonlySet<string> } | null;
}): DockChatSection[] {
  const { hostThreadRef, hostProjectId, repoTitle, workProject } = input;
  const inWorkProject: EnvironmentThreadShell[] = [];
  const inRepo: EnvironmentThreadShell[] = [];
  const other: EnvironmentThreadShell[] = [];
  for (const thread of listDockChatCandidates(input.threads, hostThreadRef)) {
    if (
      workProject?.threadKeys.has(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)))
    ) {
      inWorkProject.push(thread);
    } else if (
      thread.environmentId === hostThreadRef.environmentId &&
      thread.projectId === hostProjectId
    ) {
      inRepo.push(thread);
    } else {
      other.push(thread);
    }
  }
  const sections: DockChatSection[] = [
    { id: "work-project", title: `In ${workProject?.name ?? ""}`, threads: inWorkProject },
    { id: "repo", title: `In ${repoTitle}`, threads: inRepo },
    { id: "other", title: "Other chats", threads: other.slice(0, DOCK_OTHER_CHATS_LIMIT) },
  ];
  return sections.filter((section) => section.threads.length > 0);
}
