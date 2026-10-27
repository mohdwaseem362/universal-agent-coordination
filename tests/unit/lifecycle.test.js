'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TASK_STATES,
  LifecycleError,
  canTransition,
  assertTransition,
  BaseIdeAdapter
} = require('../../src');

test('Task lifecycle permits valid forward and recovery transitions', () => {
  assert.equal(canTransition(TASK_STATES.OPEN, TASK_STATES.CLAIMED), true);
  assert.equal(canTransition(TASK_STATES.CLAIMED, TASK_STATES.IN_PROGRESS), true);
  assert.equal(canTransition(TASK_STATES.IN_PROGRESS, TASK_STATES.REVIEW), true);
  assert.equal(canTransition(TASK_STATES.IN_PROGRESS, TASK_STATES.VERIFYING), true);
  assert.equal(canTransition(TASK_STATES.REVIEW, TASK_STATES.VERIFYING), true);
  assert.equal(canTransition(TASK_STATES.VERIFYING, TASK_STATES.DONE), true);
  assert.equal(canTransition(TASK_STATES.IN_PROGRESS, TASK_STATES.BLOCKED), true);
  assert.equal(canTransition(TASK_STATES.BLOCKED, TASK_STATES.IN_PROGRESS), true);
  assert.equal(canTransition(TASK_STATES.CLAIMED, TASK_STATES.OPEN), true);
});

test('Task lifecycle rejects invalid jumps and unverified DONE transitions', () => {
  assert.equal(canTransition(TASK_STATES.OPEN, TASK_STATES.IN_PROGRESS), false);
  assert.equal(canTransition(TASK_STATES.OPEN, TASK_STATES.DONE), false);
  assert.equal(canTransition(TASK_STATES.DONE, TASK_STATES.IN_PROGRESS), false);

  const mockTask = {
    task_id: 'task_1',
    status: TASK_STATES.VERIFYING,
    retry_count: 0,
    max_retries: 3
  };

  assert.throws(
    () => assertTransition(mockTask, TASK_STATES.DONE, { verifiedByGate: false }),
    (err) => err instanceof LifecycleError && err.code === 'COMPLETION_GATE_REQUIRED'
  );

  assert.equal(assertTransition(mockTask, TASK_STATES.DONE, { verifiedByGate: true }), true);
});

test('Task lifecycle enforces bounded retry limits when recovering from FAILED', () => {
  const exhaustedTask = {
    task_id: 'task_retry',
    status: TASK_STATES.FAILED,
    retry_count: 3,
    max_retries: 3
  };

  assert.throws(
    () => assertTransition(exhaustedTask, TASK_STATES.IN_PROGRESS),
    (err) => err instanceof LifecycleError && err.code === 'MAX_RETRIES_EXCEEDED'
  );

  const recoverableTask = {
    task_id: 'task_retry_ok',
    status: TASK_STATES.FAILED,
    retry_count: 2,
    max_retries: 3
  };
  assert.equal(assertTransition(recoverableTask, TASK_STATES.IN_PROGRESS), true);
});

test('@followprotocol and /followprotocol trigger parser extracts task instructions', () => {
  const parsed1 = BaseIdeAdapter.parseTrigger(
    '@followprotocol Test the checkout feature, fix failures, and verify the result.'
  );
  assert.equal(parsed1.triggered, true);
  assert.equal(parsed1.triggerToken, '@followprotocol');
  assert.equal(
    parsed1.taskPrompt,
    'Test the checkout feature, fix failures, and verify the result.'
  );

  const parsed2 = BaseIdeAdapter.parseTrigger('/followprotocol Review the payment module');
  assert.equal(parsed2.triggered, true);
  assert.equal(parsed2.triggerToken, '/followprotocol');
  assert.equal(parsed2.taskPrompt, 'Review the payment module');

  const parsed3 = BaseIdeAdapter.parseTrigger('Regular prompt without trigger');
  assert.equal(parsed3.triggered, false);
});
