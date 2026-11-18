# Label Definitions and Rules

Label definitions (names, descriptions, colors) are maintained by
`docs/specs/workflow/script-label-setup.md`. This file documents the rules for label usage.

## Mutually Exclusive Categories

An issue must have exactly one label within each of these categories:

| Category     | Labels                                             |
| ------------ | -------------------------------------------------- |
| **Type**     | `task:implement`, `task:refinement`                |
| **Status**   | All `status:*` labels                              |
| **Priority** | `priority:high`, `priority:medium`, `priority:low` |

When changing a label within a mutually exclusive category, remove the old label and add the new one
in a single command:

```
gh issue edit <number> --remove-label "status:in-progress" --add-label "status:review"
```

## Valid Status Transitions

| From                      | To                        |
| ------------------------- | ------------------------- |
| `status:pending`          | `status:in-progress`      |
| `status:in-progress`      | `status:blocked`          |
| `status:in-progress`      | `status:needs-refinement` |
| `status:in-progress`      | `status:review`           |
| `status:blocked`          | `status:unblocked`        |
| `status:needs-refinement` | `status:unblocked`        |
| `status:unblocked`        | `status:in-progress`      |
| `status:review`           | `status:approved`         |
| `status:review`           | `status:needs-changes`    |
| `status:needs-changes`    | `status:in-progress`      |

## Status Labels

- `status:pending` -- Not yet started
- `status:in-progress` -- Actively being worked
- `status:blocked` -- Waiting on non-spec blocker
- `status:needs-refinement` -- Blocked on spec issue
- `status:unblocked` -- Previously blocked, ready to resume
- `status:review` -- PR submitted, awaiting review
- `status:needs-changes` -- Review rejected
- `status:approved` -- Ready to merge
