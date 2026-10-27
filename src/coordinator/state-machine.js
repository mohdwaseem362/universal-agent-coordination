'use strict';

/**
 * Documented Task Lifecycle State Machine for Universal Agent Coordination.
 *
 * Primary Happy Path:
 *   OPEN -> CLAIMED -> IN_PROGRESS -> REVIEW -> VERIFYING -> DONE
 *
 * Exception & Recovery Paths:
 *   - Any active state (CLAIMED, IN_PROGRESS, REVIEW, VERIFYING) can transition to BLOCKED, FAILED, or CANCELLED.
 *   - CLAIMED or IN_PROGRESS can return to OPEN when a lease expires or an agent explicitly releases the task.
 *   - REVIEW can go directly to VERIFYING (or IN_PROGRESS if review requests changes).
 *   - IN_PROGRESS can go directly to VERIFYING when require_independent_review = false.
 *   - VERIFYING can return to IN_PROGRESS or FAILED if verification gates fail.
 *   - BLOCKED can resume to CLAIMED or IN_PROGRESS once blockers are resolved.
 *   - FAILED can transition back to OPEN or IN_PROGRESS if retry_count < max_retries.
 */

const TASK_STATES = Object.freeze({
  OPEN: 'OPEN',
  CLAIMED: 'CLAIMED',
  IN_PROGRESS: 'IN_PROGRESS',
  REVIEW: 'REVIEW',
  VERIFYING: 'VERIFYING',
  DONE: 'DONE',
  BLOCKED: 'BLOCKED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED'
});

const VALID_PRIORITIES = Object.freeze(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

const PERMITTED_TRANSITIONS = Object.freeze({
  OPEN: new Set(['CLAIMED', 'CANCELLED']),
  CLAIMED: new Set(['IN_PROGRESS', 'BLOCKED', 'OPEN', 'FAILED', 'CANCELLED']),
  IN_PROGRESS: new Set(['REVIEW', 'VERIFYING', 'BLOCKED', 'FAILED', 'OPEN', 'CANCELLED']),
  REVIEW: new Set(['VERIFYING', 'IN_PROGRESS', 'BLOCKED', 'FAILED', 'CANCELLED']),
  VERIFYING: new Set(['DONE', 'IN_PROGRESS', 'REVIEW', 'BLOCKED', 'FAILED', 'CANCELLED']),
  BLOCKED: new Set(['CLAIMED', 'IN_PROGRESS', 'OPEN', 'FAILED', 'CANCELLED']),
  FAILED: new Set(['OPEN', 'CLAIMED', 'IN_PROGRESS', 'CANCELLED']),
  DONE: new Set([]), // Terminal state unless explicitly reopened via new task
  CANCELLED: new Set(['OPEN'])
});

class LifecycleError extends Error {
  constructor(message, code = 'INVALID_STATE_TRANSITION', details = {}) {
    super(message);
    this.name = 'LifecycleError';
    this.code = code;
    this.details = details;
  }
}

function isValidState(state) {
  return Object.prototype.hasOwnProperty.call(TASK_STATES, state);
}

function canTransition(fromState, toState) {
  if (!isValidState(fromState) || !isValidState(toState)) {
    return false;
  }
  if (fromState === toState) {
    return true;
  }
  const allowed = PERMITTED_TRANSITIONS[fromState];
  return Boolean(allowed && allowed.has(toState));
}

function assertTransition(task, toState, options = {}) {
  const fromState = task.status;
  if (!isValidState(toState)) {
    throw new LifecycleError(`Unknown target task state: ${toState}`, 'UNKNOWN_STATE', {
      fromState,
      toState
    });
  }
  if (fromState === toState) {
    return true;
  }
  if (!canTransition(fromState, toState)) {
    throw new LifecycleError(
      `Invalid task state transition from ${fromState} to ${toState} for task ${task.task_id}`,
      'INVALID_STATE_TRANSITION',
      { taskId: task.task_id, fromState, toState }
    );
  }

  // Enforce retry limit when recovering from FAILED
  if (fromState === TASK_STATES.FAILED && (toState === TASK_STATES.IN_PROGRESS || toState === TASK_STATES.CLAIMED || toState === TASK_STATES.OPEN)) {
    if (task.retry_count >= task.max_retries && !options.forceEscalationOverride) {
      throw new LifecycleError(
        `Task ${task.task_id} has exhausted max retries (${task.retry_count}/${task.max_retries}). Escalation required.`,
        'MAX_RETRIES_EXCEEDED',
        { taskId: task.task_id, retryCount: task.retry_count, maxRetries: task.max_retries }
      );
    }
  }

  // Direct transition to DONE is never permitted without passing through VERIFYING or verify_completion
  if (toState === TASK_STATES.DONE && !options.verifiedByGate) {
    throw new LifecycleError(
      `Task ${task.task_id} cannot transition to DONE without passing completion verification gates (verify_completion).`,
      'COMPLETION_GATE_REQUIRED',
      { taskId: task.task_id, fromState, toState }
    );
  }

  return true;
}

module.exports = {
  TASK_STATES,
  VALID_PRIORITIES,
  PERMITTED_TRANSITIONS,
  LifecycleError,
  isValidState,
  canTransition,
  assertTransition
};
