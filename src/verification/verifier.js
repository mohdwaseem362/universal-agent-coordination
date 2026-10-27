'use strict';

/**
 * Verifies whether a task satisfies all configured completion gates before
 * transitioning to DONE.
 *
 * Completion Gates:
 * 1. Dependency Gate: All tasks in `task_dependencies` must have status === 'DONE'.
 * 2. Subtask Gate: All child tasks (`parent_task_id === task.task_id` not CANCELLED) must have status === 'DONE'.
 * 3. Blocker Gate: Task must not have an active `blocker_reason` or unacknowledged `BLOCKER` messages.
 * 4. Test Execution Gate (when `task.require_test_execution === 1`):
 *    - At least one `TEST_RESULT` verification evidence record must exist for the task (or its completed subtasks).
 *    - The latest `TEST_RESULT` record must have `passed === 1` and `exit_code === 0` and `failed_count === 0`.
 * 5. Independent Review Gate (when `task.require_independent_review === 1`):
 *    - At least one `INDEPENDENT_REVIEW` record must exist with `passed === 1`.
 *    - The reviewer `agent_id` MUST differ from `task.owner_agent_id` (an agent cannot self-approve an independent review).
 */

async function evaluateCompletionGates(tx, taskId) {
  const task = await tx.get('SELECT * FROM tasks WHERE task_id = ?', [taskId]);
  if (!task) {
    return {
      passed: false,
      reasons: [`Task ${taskId} does not exist.`],
      summary: {}
    };
  }

  const reasons = [];

  // 1. Check dependencies
  const dependencies = await tx.all(
    `SELECT d.depends_on_task_id, t.title, t.status
     FROM task_dependencies d
     JOIN tasks t ON t.task_id = d.depends_on_task_id
     WHERE d.task_id = ?`,
    [taskId]
  );
  const incompleteDeps = dependencies.filter((d) => d.status !== 'DONE');
  if (incompleteDeps.length > 0) {
    reasons.push(
      `Unmet dependencies: ${incompleteDeps.map((d) => `${d.depends_on_task_id} (${d.status})`).join(', ')}`
    );
  }

  // 2. Check subtasks
  const subtasks = await tx.all(
    `SELECT task_id, title, status, owner_agent_id
     FROM tasks
     WHERE parent_task_id = ? AND status != 'CANCELLED'`,
    [taskId]
  );
  const incompleteSubtasks = subtasks.filter((s) => s.status !== 'DONE');
  if (incompleteSubtasks.length > 0) {
    reasons.push(
      `Incomplete subtasks: ${incompleteSubtasks.map((s) => `${s.task_id} (${s.status})`).join(', ')}`
    );
  }

  // 3. Check blockers
  if (task.status === 'BLOCKED' || (task.blocker_reason && task.blocker_reason.trim() !== '')) {
    reasons.push(`Task has an unresolved blocker: ${task.blocker_reason || 'status is BLOCKED'}`);
  }

  // Collect evidence across this task and its subtasks
  const relevantTaskIds = [taskId, ...subtasks.map((s) => s.task_id)];
  const placeholders = relevantTaskIds.map(() => '?').join(',');
  const evidenceRows = await tx.all(
    `SELECT * FROM verification_evidence
     WHERE task_id IN (${placeholders})
     ORDER BY created_at DESC, rowid DESC`,
    relevantTaskIds
  );

  const testResults = evidenceRows.filter((e) => e.evidence_type === 'TEST_RESULT');
  const reviews = evidenceRows.filter((e) => e.evidence_type === 'INDEPENDENT_REVIEW');

  // 4. Test Execution Gate
  let latestTestResult = testResults.length > 0 ? testResults[0] : null;
  if (task.require_test_execution === 1) {
    if (!latestTestResult) {
      reasons.push('Test execution gate failed: No TEST_RESULT verification evidence recorded.');
    } else if (
      latestTestResult.passed !== 1 ||
      (latestTestResult.exit_code !== null && latestTestResult.exit_code !== 0) ||
      latestTestResult.failed_count > 0
    ) {
      reasons.push(
        `Test execution gate failed: Latest test run (${latestTestResult.evidence_id}) did not pass (passed=${latestTestResult.passed}, exit_code=${latestTestResult.exit_code}, failed_count=${latestTestResult.failed_count}).`
      );
    }
  }

  // 5. Independent Review Gate
  let validIndependentReview = null;
  if (task.require_independent_review === 1) {
    if (reviews.length === 0) {
      reasons.push('Independent review gate failed: No INDEPENDENT_REVIEW evidence submitted.');
    } else {
      const latestReview = reviews[0];
      if (latestReview.passed !== 1) {
        reasons.push(
          `Independent review gate failed: Latest review (${latestReview.evidence_id}) rejected completion.`
        );
      } else if (task.owner_agent_id && latestReview.agent_id === task.owner_agent_id) {
        reasons.push(
          `Independent review gate failed: Reviewer (${latestReview.agent_id}) cannot be the same agent as task owner (${task.owner_agent_id}).`
        );
      } else {
        validIndependentReview = latestReview;
      }
    }
  } else if (reviews.length > 0) {
    validIndependentReview = reviews[0];
  }

  return {
    passed: reasons.length === 0,
    reasons,
    summary: {
      task_id: taskId,
      dependencies_total: dependencies.length,
      dependencies_done: dependencies.length - incompleteDeps.length,
      subtasks_total: subtasks.length,
      subtasks_done: subtasks.length - incompleteSubtasks.length,
      test_runs_recorded: testResults.length,
      latest_test_passed: latestTestResult ? Boolean(latestTestResult.passed) : null,
      latest_test_command: latestTestResult ? latestTestResult.command : null,
      reviews_recorded: reviews.length,
      independent_review_passed: validIndependentReview ? Boolean(validIndependentReview.passed) : null,
      reviewer_agent_id: validIndependentReview ? validIndependentReview.agent_id : null
    }
  };
}

module.exports = {
  evaluateCompletionGates
};
