# Universal Agent Coordination Protocol Specification

## 1. Task Lifecycle State Machine

Tasks follow a strict state machine enforced inside SQLite `BEGIN IMMEDIATE` transactions:

- `OPEN` -> `CLAIMED`, `CANCELLED`
- `CLAIMED` -> `IN_PROGRESS`, `BLOCKED`, `OPEN` (release/expiry), `FAILED`, `CANCELLED`
- `IN_PROGRESS` -> `REVIEW`, `VERIFYING`, `BLOCKED`, `FAILED`, `OPEN`, `CANCELLED`
- `REVIEW` -> `VERIFYING`, `IN_PROGRESS`, `BLOCKED`, `FAILED`, `CANCELLED`
- `VERIFYING` -> `DONE` (only via `verify_completion`), `IN_PROGRESS`, `REVIEW`, `BLOCKED`, `FAILED`, `CANCELLED`
- `BLOCKED` -> `CLAIMED`, `IN_PROGRESS`, `OPEN`, `FAILED`, `CANCELLED`
- `FAILED` -> `OPEN`, `CLAIMED`, `IN_PROGRESS` (only when `retry_count < max_retries`), `CANCELLED`
- `DONE` -> Terminal state

## 2. Optimistic Concurrency and Lease Recovery

- Every task update increments `version`. Passing `expected_version` rejects stale concurrent writes with `STALE_WRITE_CONFLICT`.
- Resource leases (`resource_leases`) carry an explicit `expires_at` timestamp (default 900 seconds).
- On every coordinator transaction, expired resource leases and expired `CLAIMED` task leases are automatically reaped and logged to `ownership_transitions` (`LEASE_EXPIRED`), preventing deadlocks if an IDE crashes.

## 3. Completion Gates

A task can transition to `DONE` only through `verify_completion`, which verifies:

1. **Dependency Gate**: All tasks in `task_dependencies` have `status = 'DONE'`.
2. **Subtask Gate**: All non-cancelled child subtasks have `status = 'DONE'`.
3. **Blocker Gate**: `blocker_reason` is empty and status is not `BLOCKED`.
4. **Test Execution Gate**: At least one `TEST_RESULT` record exists and the latest record has `passed = 1`, `exit_code = 0`, and `failed_count = 0`.
5. **Independent Review Gate**: When `require_independent_review = 1`, an `INDEPENDENT_REVIEW` record with `passed = 1` exists from a `reviewer_agent_id != owner_agent_id`.
