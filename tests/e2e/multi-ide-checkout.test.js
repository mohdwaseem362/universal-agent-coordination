'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  CoordinatorService,
  AntiGravityAdapter,
  OpenCodeAdapter,
  ClaudeCodeAdapter,
  BaseIdeAdapter
} = require('../../src');

test('End-to-End Multi-IDE Collaboration: AntiGravity + OpenCode + Claude Code on Checkout Feature', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uac-e2e-checkout-'));

  // Three distinct CoordinatorService connections (each running its own SQLite WAL worker process)
  const coordAntiGravity = new CoordinatorService({ workspaceRoot: tmpDir });
  const coordOpenCode = new CoordinatorService({ workspaceRoot: tmpDir });
  const coordClaudeReview = new CoordinatorService({ workspaceRoot: tmpDir });

  try {
    const antiGravity = new AntiGravityAdapter({
      agentId: 'antigravity-checkout',
      role: 'service-implementation',
      coordinator: coordAntiGravity
    });
    const openCode = new OpenCodeAdapter({
      agentId: 'opencode-debugger',
      role: 'test-debugging',
      coordinator: coordOpenCode
    });
    const claudeReviewer = new ClaudeCodeAdapter({
      agentId: 'claude-security-reviewer',
      role: 'security-review',
      coordinator: coordClaudeReview
    });

    // Step 1: Developer invokes `@followprotocol Test the checkout feature, investigate failures, and fix them.` in AntiGravity
    const trigger1 = BaseIdeAdapter.parseTrigger(
      '@followprotocol Test the checkout feature, investigate failures, and fix them.'
    );
    assert.equal(trigger1.triggered, true);

    await antiGravity.connect();
    const primaryTask = await antiGravity.createAndClaimTask({
      title: 'Fix checkout calculation and verify payment flow',
      description: trigger1.taskPrompt,
      acceptanceCriteria: [
        'Discount calculation rounds to 2 decimal places without floating-point drift',
        'All checkout unit and integration tests pass',
        'Independent security review approves payment validation'
      ],
      priority: 'HIGH',
      scopes: ['src/checkout/**'],
      requireIndependentReview: true
    });

    assert.equal(primaryTask.status, 'CLAIMED');
    assert.equal(primaryTask.owner_agent_id, 'antigravity-checkout');
    assert.deepEqual(primaryTask.claimed_scopes, ['src/checkout/**']);

    await antiGravity.updateStatus(
      primaryTask.task_id,
      'IN_PROGRESS',
      'Inspecting src/checkout/CheckoutService.js and publishing initial plan.'
    );
    await antiGravity.sendMessage({
      taskId: primaryTask.task_id,
      messageType: 'PLAN',
      content:
        'Owning src/checkout/**. Need a collaborating agent to isolate the failing checkout test cases in tests/checkout/**.'
    });

    // Step 2: Developer starts OpenCode with `@followprotocol Join the existing checkout task and help AntiGravity finish it.`
    const trigger2 = BaseIdeAdapter.parseTrigger(
      '@followprotocol Join the existing checkout task and help AntiGravity finish it. Investigate the failing tests and suggest or implement fixes.'
    );
    assert.equal(trigger2.triggered, true);

    await openCode.connect();
    const discovered = await openCode.discoverTasks({ search: 'checkout' });
    assert.equal(discovered.tasks.length, 1);
    assert.equal(discovered.tasks[0].task_id, primaryTask.task_id);

    // OpenCode joins the existing task and creates a non-overlapping test-debugging subtask
    const joinResult = await openCode.joinExistingTask(primaryTask.task_id, {
      title: 'Reproduce and regression-test checkout discount rounding failures',
      description: 'Debug failing tests in tests/checkout/** and verify fix.',
      scopes: ['tests/checkout/**'],
      auto_claim: true
    });

    assert.equal(joinResult.joined_task.task_id, primaryTask.task_id);
    assert.ok(joinResult.subtask);
    assert.equal(joinResult.subtask.owner_agent_id, 'opencode-debugger');
    assert.equal(joinResult.messages.length >= 2, true);
    assert.equal(joinResult.messages[0].trust_boundary, 'UNTRUSTED_PEER_AGENT_DATA');

    const subtaskId = joinResult.subtask.task_id;
    await openCode.updateStatus(subtaskId, 'IN_PROGRESS', 'Running checkout test suite.');

    // Step 3: Conflicting ownership claim is rejected safely
    await assert.rejects(
      () => openCode.claimResource(subtaskId, 'src/checkout/CheckoutService.js'),
      (err) => err.code === 'RESOURCE_OWNERSHIP_CONFLICT'
    );

    // Step 4: OpenCode reports initial test failure and communicates reproduction steps to AntiGravity
    await openCode.reportTestResults({
      taskId: primaryTask.task_id,
      command: 'npm test -- tests/checkout/discount.spec.js',
      exitCode: 1,
      passedCount: 12,
      failedCount: 2,
      outputSummary:
        'FAIL tests/checkout/discount.spec.js: Expected 19.99, received 19.990000000000002 in calculateTotal()'
    });

    await openCode.sendMessage({
      taskId: primaryTask.task_id,
      recipientAgentId: 'antigravity-checkout',
      messageType: 'FINDING',
      content:
        'Root cause identified: CheckoutService.calculateTotal() does not round basis-point discount before subtracting from subtotal.'
    });

    // Step 5: Premature completion check MUST fail while tests are failing and subtask is incomplete
    const prematureVerify = await antiGravity.verifyCompletion(primaryTask.task_id);
    assert.equal(prematureVerify.completed, false);
    assert.ok(prematureVerify.gate_evaluation.reasons.length >= 2);

    // Step 6: AntiGravity records technical decision and fixes service within `src/checkout/**`
    await antiGravity.recordDecision({
      taskId: primaryTask.task_id,
      topic: 'Monetary rounding in CheckoutService',
      decision: 'Use integer cents arithmetic (Math.round(amount * 100) / 100) for all discount and tax calculations.',
      rationale: 'Eliminates IEEE-754 floating point drift across currencies.'
    });

    await antiGravity.sendMessage({
      taskId: primaryTask.task_id,
      recipientAgentId: 'opencode-debugger',
      messageType: 'STATUS_UPDATE',
      content: 'Applied integer-cents rounding fix in src/checkout/CheckoutService.js. Ready for test re-run.'
    });

    // Step 7: OpenCode re-runs tests, records passing evidence on both subtask and parent task, and completes subtask
    await openCode.reportTestResults({
      taskId: subtaskId,
      command: 'npm test -- tests/checkout/discount.spec.js',
      exitCode: 0,
      passedCount: 14,
      failedCount: 0,
      outputSummary: 'PASS tests/checkout/discount.spec.js (14 passed, 0 failed)'
    });
    await openCode.reportTestResults({
      taskId: primaryTask.task_id,
      command: 'npm test -- tests/checkout/discount.spec.js',
      exitCode: 0,
      passedCount: 14,
      failedCount: 0,
      outputSummary: 'PASS tests/checkout/discount.spec.js (14 passed, 0 failed)'
    });

    const subtaskVerification = await openCode.verifyCompletion(subtaskId);
    assert.equal(subtaskVerification.completed, true);
    assert.equal(subtaskVerification.task.status, 'DONE');

    // Step 8: Self-review by AntiGravity is rejected; independent review by Claude Code succeeds
    await assert.rejects(
      () =>
        antiGravity.submitReview({
          taskId: primaryTask.task_id,
          approved: true,
          findingsSummary: 'Self-approving my own checkout changes.'
        }),
      (err) => err.code === 'SELF_REVIEW_FORBIDDEN'
    );

    await claudeReviewer.connect();
    await claudeReviewer.submitReview({
      taskId: primaryTask.task_id,
      approved: true,
      findingsSummary:
        'Reviewed src/checkout/CheckoutService.js and tests/checkout/discount.spec.js. Integer-cents arithmetic prevents negative discount injection and rounding drift.'
    });

    // Step 9: Final completion gate passes and consolidated report is generated
    const finalVerification = await antiGravity.verifyCompletion(primaryTask.task_id);
    assert.equal(finalVerification.completed, true);
    assert.equal(finalVerification.task.status, 'DONE');
    assert.equal(finalVerification.task.active_leases.length, 0);

    const report = await coordAntiGravity.generateConsolidatedReport(primaryTask.task_id);
    assert.equal(report.final_status, 'DONE');
    assert.equal(report.completion_gates_passed, true);
    assert.equal(report.contributing_agents.length >= 2, true);
    assert.equal(report.conflicts_prevented.length, 1);
    assert.equal(report.independent_reviews.length, 1);
    assert.equal(report.test_executions.length, 3);
  } finally {
    await coordAntiGravity.close();
    await coordOpenCode.close();
    await coordClaudeReview.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
