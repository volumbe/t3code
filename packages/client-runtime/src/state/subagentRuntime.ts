/**
 * Subagent status helpers shared by web and mobile, and the runtime shape the
 * web agent rows render.
 */
import * as DateTime from "effect/DateTime";
import type { OrchestrationV2Subagent } from "@t3tools/contracts";
import { isOrchestrationV2WorkActive } from "@t3tools/contracts";

export type RuntimeSubagentStatus =
  | "pending"
  | "running"
  | "waiting"
  | "idle"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface SubagentUsage {
  readonly totalTokens: number;
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningOutputTokens?: number;
  readonly toolUses?: number;
  readonly durationMs?: number;
}

export interface SubagentActivityEntry {
  readonly at: string;
  readonly summary: string;
}

export interface SubagentWorkflowPhase {
  readonly index: number;
  readonly title: string;
}

export interface SubagentRunHandles {
  readonly runId?: string;
  readonly scriptPath?: string;
  readonly transcriptDir?: string;
  readonly sessionUrl?: string;
}

export interface RuntimeSubagent {
  readonly id: string;
  readonly kind: "subagent" | "subagent_batch" | "workflow" | "workflow_agent";
  readonly title: string;
  readonly role: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly status: RuntimeSubagentStatus;
  readonly activationCount: number;
  readonly usage: SubagentUsage | null;
  readonly progress: string | null;
  readonly lastToolName: string | null;
  readonly result: string | null;
  readonly error: string | null;
  readonly outputFile: string | null;
  readonly parentAgentId: string | null;
  readonly agentIndex: number | null;
  readonly phaseIndex: number | null;
  readonly phaseTitle: string | null;
  readonly attempt: number | null;
  readonly workflowName: string | null;
  readonly phases: ReadonlyArray<SubagentWorkflowPhase>;
  readonly runHandles: SubagentRunHandles | null;
  readonly recentActivity: ReadonlyArray<SubagentActivityEntry>;
  /** First retained observation, used as the roster's stable display order. */
  readonly firstSeenAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly updatedAt: string;
}

const TERMINAL_STATUSES: ReadonlySet<RuntimeSubagentStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

export function isTerminalSubagentStatus(status: RuntimeSubagentStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** Active = the user may still need to care while it runs. Idle is settled-ish
 * but resumable; waiting counts as active because it needs the user. */
export function isActiveSubagentStatus(status: RuntimeSubagentStatus): boolean {
  return isOrchestrationV2WorkActive(status);
}

/**
 * Projects orchestration-v2 subagent entities into the runtime shape the web
 * agent rows render.
 */
export function projectedSubagentsToRuntime(
  subagents: ReadonlyArray<{
    readonly id: string;
    readonly title: string | null;
    readonly prompt: string;
    readonly model: string | null;
    readonly status: OrchestrationV2Subagent["status"];
    readonly progress?: string | undefined;
    readonly result: string | null;
    readonly startedAt: DateTime.Utc | null;
    readonly completedAt: DateTime.Utc | null;
    readonly updatedAt: DateTime.Utc;
  }>,
): ReadonlyArray<RuntimeSubagent> {
  return subagents.map((subagent) => {
    const updatedAt = DateTime.formatIso(subagent.updatedAt);
    const startedAt = subagent.startedAt === null ? null : DateTime.formatIso(subagent.startedAt);
    return {
      id: subagent.id,
      kind: "subagent" as const,
      title:
        subagent.title ??
        (subagent.prompt.length > 80 ? `${subagent.prompt.slice(0, 77)}...` : subagent.prompt),
      role: null,
      model: subagent.model,
      effort: null,
      status: subagent.status,
      activationCount: 1,
      usage: null,
      progress: subagent.progress ?? null,
      lastToolName: null,
      result: subagent.result,
      error: subagent.status === "failed" ? (subagent.result ?? null) : null,
      outputFile: null,
      parentAgentId: null,
      agentIndex: null,
      phaseIndex: null,
      phaseTitle: null,
      attempt: null,
      workflowName: null,
      phases: [],
      runHandles: null,
      recentActivity: [],
      firstSeenAt: startedAt ?? updatedAt,
      startedAt,
      completedAt: subagent.completedAt === null ? null : DateTime.formatIso(subagent.completedAt),
      updatedAt,
    } satisfies RuntimeSubagent;
  });
}

/** View model for the fork's Agents right-panel surface. */
export interface AgentPanelWorkflowGroup {
  readonly workflow: RuntimeSubagent;
  readonly phases: ReadonlyArray<{
    readonly index: number;
    readonly title: string;
    readonly members: ReadonlyArray<RuntimeSubagent>;
    readonly state: "pending" | "running" | "done";
    readonly activeCount: number;
    readonly settledCount: number;
  }>;
  readonly unphasedMembers: ReadonlyArray<RuntimeSubagent>;
}

export interface AgentPanelModel {
  readonly workflows: ReadonlyArray<AgentPanelWorkflowGroup>;
  readonly directAgents: ReadonlyArray<RuntimeSubagent>;
  readonly runningCount: number;
  readonly waitingCount: number;
  readonly idleCount: number;
  readonly settledCount: number;
  readonly totalTokens: number;
  readonly hasAgents: boolean;
  readonly liveCount: number;
}

const EMPTY_PANEL_MODEL: AgentPanelModel = {
  workflows: [],
  directAgents: [],
  runningCount: 0,
  waitingCount: 0,
  idleCount: 0,
  settledCount: 0,
  totalTokens: 0,
  hasAgents: false,
  liveCount: 0,
};

export function emptyAgentPanelModel(): AgentPanelModel {
  return EMPTY_PANEL_MODEL;
}

export function deriveAgentPanelModel({
  agents,
  v2Projection,
}: {
  readonly agents: ReadonlyArray<RuntimeSubagent>;
  readonly v2Projection?: ReadonlyArray<RuntimeSubagent> | null;
}): AgentPanelModel {
  const source = v2Projection ?? agents;
  if (source.length === 0) return EMPTY_PANEL_MODEL;
  const workflows = source
    .filter((agent) => agent.kind === "workflow")
    .slice()
    .sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt) || a.id.localeCompare(b.id));
  const workflowIds = new Set(workflows.map((workflow) => workflow.id));
  const members = new Map<string, RuntimeSubagent[]>();
  const direct: RuntimeSubagent[] = [];
  for (const agent of source) {
    if (agent.kind === "workflow") continue;
    if (agent.parentAgentId !== null && workflowIds.has(agent.parentAgentId)) {
      const list = members.get(agent.parentAgentId) ?? [];
      list.push(agent);
      members.set(agent.parentAgentId, list);
    } else direct.push(agent);
  }
  const workflowGroups = workflows.map((workflow) => {
    const workflowMembers = members.get(workflow.id) ?? [];
    const knownPhases =
      workflow.phases.length > 0
        ? workflow.phases
        : (() => {
            const derived = new Map<number, string>();
            for (const member of workflowMembers) {
              if (member.phaseIndex !== null && !derived.has(member.phaseIndex)) {
                derived.set(
                  member.phaseIndex,
                  member.phaseTitle ?? `Phase ${member.phaseIndex + 1}`,
                );
              }
            }
            return Array.from(derived, ([index, title]) => ({ index, title })).sort(
              (a, b) => a.index - b.index,
            );
          })();
    const knownPhaseIndices = new Set(knownPhases.map((phase) => phase.index));
    const phases = knownPhases.map((phase) => {
      const phaseMembers = workflowMembers
        .filter((member) => member.phaseIndex === phase.index)
        .slice()
        .sort((a, b) => (a.agentIndex ?? 0) - (b.agentIndex ?? 0));
      const activeCount = phaseMembers.filter(
        (member) => isActiveSubagentStatus(member.status) || member.status === "idle",
      ).length;
      const settledCount = phaseMembers.filter((member) =>
        isTerminalSubagentStatus(member.status),
      ).length;
      const state: "pending" | "running" | "done" =
        phaseMembers.length === 0
          ? "pending"
          : activeCount > 0
            ? "running"
            : settledCount === phaseMembers.length
              ? "done"
              : "pending";
      return {
        index: phase.index,
        title: phase.title,
        members: phaseMembers,
        state,
        activeCount,
        settledCount,
      };
    });
    const unphasedMembers = workflowMembers
      .filter((member) => member.phaseIndex === null || !knownPhaseIndices.has(member.phaseIndex))
      .slice()
      .sort((a, b) => (a.agentIndex ?? 0) - (b.agentIndex ?? 0));
    return { workflow, phases, unphasedMembers };
  });
  let runningCount = 0;
  let waitingCount = 0;
  let idleCount = 0;
  let settledCount = 0;
  let totalTokens = 0;
  for (const agent of source) {
    if (agent.kind === "workflow" && (members.get(agent.id) ?? []).length > 0) continue;
    if (agent.status === "running" || agent.status === "pending") runningCount += 1;
    else if (agent.status === "waiting") waitingCount += 1;
    else if (agent.status === "idle") idleCount += 1;
    else settledCount += 1;
    totalTokens += agent.usage?.totalTokens ?? 0;
  }
  return {
    workflows: workflowGroups,
    directAgents: direct.sort(
      (a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt) || a.id.localeCompare(b.id),
    ),
    runningCount,
    waitingCount,
    idleCount,
    settledCount,
    totalTokens,
    hasAgents: true,
    liveCount: runningCount + waitingCount,
  };
}

export function formatSubagentModelLabel(
  model: string | null,
  effort: string | null,
): string | null {
  if (!model) return null;
  const compact = model
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-latest$/, "");
  return effort ? `${compact} · ${effort}` : compact;
}

export function formatSubagentTokenCount(totalTokens: number): string {
  if (totalTokens < 1000) return `${totalTokens}`;
  if (totalTokens < 1_000_000) {
    const value = totalTokens / 1000;
    return `${value >= 100 ? Math.round(value) : value.toFixed(1)}k`;
  }
  return `${(totalTokens / 1_000_000).toFixed(1)}M`;
}
