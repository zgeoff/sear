# Agentic Workflow — Phased Implementation Plan

## Dependency Graph

```
#68 ──→ #64 ──→ #65
  └──→ #70

#55 ──→ #56
  ├──→ #57 ──→ #58
  │      └──→ #62
  └──→ #59

#54 ──→ #60
#63 ──→ #66
```

## Phase 1 — Foundations (all independent, fully parallelizable)

Zero blockers. 4 critical-path roots + 8 independent items.

| #       | Title                                                                               | Priority | Unblocks                |
| ------- | ----------------------------------------------------------------------------------- | -------- | ----------------------- |
| **#55** | feat(tui): shared list primitives (headers, alternating rows, truncation)           | high     | #56, #57, #58, #59, #62 |
| **#68** | feat(engine): TypeScript bash validator                                             | high     | #64, #65, #70           |
| **#54** | feat(tui): newline splitting and ring buffer viewport for agent streams             | high     | #60                     |
| **#63** | feat(engine): expose SpecPoller snapshot + initial seed for cache                   | high     | #66                     |
| **#53** | refactor: enforce type safety and assertion patterns                                | medium   | —                       |
| **#67** | fix(engine): re-add dispatched spec paths to deferred buffer on Planner failure     | medium   | —                       |
| **#69** | feat(engine): add changeType field to SpecChange/SpecChangedEvent                   | medium   | —                       |
| **#71** | feat(tui): add resolutionGuidance to TrackedIssue + wire store handlers             | medium   | —                       |
| **#72** | feat(tui): add specCount to AgentCompletedNotification + Planner summary            | medium   | —                       |
| **#73** | fix(engine): accept in-progress status with no running agent in dispatchImplementor | medium   | —                       |
| **#61** | feat(tui): startup notification + notification prepend ordering                     | low      | —                       |
| **#74** | fix(tui): set shuttingDown before sending shutdown command                          | low      | —                       |

**Parallelism:** All 12 items can run concurrently. Prioritize the 4 critical-path roots (#55, #68,
#54, #63) since they gate later phases.

## Phase 2 — First dependents

Each item becomes ready as soon as its specific blocker finishes — no need to wait for all of
Phase 1.

| #       | Title                                                                       | Priority | Blocked By | Available When |
| ------- | --------------------------------------------------------------------------- | -------- | ---------- | -------------- |
| **#56** | feat(tui): dashboard layout with full-viewport panes + confirmation overlay | high     | #55        | #55 done       |
| **#57** | feat(tui): notification indicators, semantic highlighting, timestamp format | medium   | #55        | #55 done       |
| **#59** | feat(tui): integrate list primitives into issue list pane                   | medium   | #55        | #55 done       |
| **#64** | feat(engine): inline agent definition loading with gray-matter              | high     | #68        | #68 done       |
| **#70** | test(workflow): shared test vectors for bash validator equivalence          | medium   | #68        | #68 done       |
| **#60** | feat(tui): detail pane header, scroll windowing, line truncation            | medium   | #54        | #54 done       |
| **#66** | feat(engine): Planner Cache to prevent redundant runs on restart            | medium   | #63        | #63 done       |

**Parallelism:** Up to 7 items can run concurrently. The three #55 dependents (#56, #57, #59) can
all start together once #55 lands.

## Phase 3 — Second-level dependents

| #       | Title                                                                | Priority | Blocked By | Available When |
| ------- | -------------------------------------------------------------------- | -------- | ---------- | -------------- |
| **#65** | feat(engine): resolve repository root via git rev-parse              | high     | #64        | #64 done       |
| **#58** | feat(tui): integrate list primitives into notifications pane         | medium   | #55, #57   | #57 done       |
| **#62** | feat(tui): OSC 8 terminal hyperlinks for issue refs + spec filenames | low      | #57        | #57 done       |

**Parallelism:** #65 is on the engine chain (independent of TUI work). #58 and #62 both gate on #57
and can run together once it lands.

## Suggested Parallel Workstreams

Optimal split for 2–3 workers:

| Worker            | Phase 1                                                        | Phase 2                                                                   | Phase 3                                   |
| ----------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------- |
| **Engine**        | #68 (bash validator), #63 (SpecPoller snapshot), #69, #67, #73 | #64 (agent defs), #70 (test vectors), #66 (Planner cache)                 | #65 (repo root)                           |
| **TUI**           | #55 (list primitives), #54 (ring buffer), #72, #71, #74, #61   | #56 (dashboard), #57 (notifications), #59 (issue list), #60 (detail pane) | #58 (notif integration), #62 (hyperlinks) |
| **Cross-cutting** | #53 (type safety refactor)                                     | —                                                                         | —                                         |

## Critical Path

Longest dependency chain:

**#68 → #64 → #65** (3 issues deep, all high priority)

This engine chain is the schedule bottleneck. If workers are limited, prioritize #68 first to
unblock this chain.
