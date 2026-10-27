#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  CoordinatorService,
  AntiGravityAdapter,
  OpenCodeAdapter,
  ClaudeCodeAdapter,
  collectDashboardState,
  renderTerminalDashboard
} = require('../src');

async function runDemo() {
  const demoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uac-live-demo-'));
  const coordAG = new CoordinatorService({ workspaceRoot: demoDir });
  const coordOC = new CoordinatorService({ workspaceRoot: demoDir });
  const coordCC = new CoordinatorService({ workspaceRoot: demoDir });

  try {
    const antiGravity = new AntiGravityAdapter({
      agentId: 'antigravity-checkout',
      role: 'service-implementation',
      coordinator: coordAG
    });
    const openCode = new OpenCodeAdapter({
      agentId: 'opencode-debugger',
      role: 'test-debugging',
      coordinator: coordOC
    });
    const claudeReviewer = new ClaudeCodeAdapter({
      agentId: 'claude-security-reviewer',
      role: 'security-review',
      coordinator: coordCC
    });

    await antiGravity.connect();
    await openCode.connect();
    await claudeReviewer.connect();

    const task = await antiGravity.createAndClaimTask({
      title: 'Fix checkout calculation and verify payment flow',
      description: 'Test the checkout feature, investigate failures, and fix them.',
      acceptanceCriteria: [
        'Integer-cents rounding in CheckoutService',
        'All checkout unit tests pass',
        'Independent security review passes'
      ],
      priority: 'HIGH',
      scopes: ['src/checkout/**'],
      requireIndependentReview: true
    });

    await antiGravity.updateStatus(task.task_id, 'IN_PROGRESS', 'Claimed src/checkout/**');

    const joined = await openCode.joinExistingTask(task.task_id, {
      title: 'Debug failing checkout discount tests',
      scopes: ['tests/checkout/**'],
      auto_claim: true
    });

    await openCode.updateStatus(
      joined.subtask.task_id,
      'IN_PROGRESS',
      'Investigating failing discount rounding tests in tests/checkout/**'
    );

    // Demonstrate conflict prevention
    try {
      await openCode.claimResource(joined.subtask.task_id, 'src/checkout/CheckoutService.js');
    } catch (_) {
      // Conflict rejected and logged
    }

    await openCode.reportTestResults({
      taskId: task.task_id,
      command: 'npm test -- tests/checkout/discount.spec.js',
      exitCode: 1,
      passedCount: 12,
      failedCount: 2,
      outputSummary: 'FAIL: floating-point rounding drift in calculateTotal()'
    });

    await antiGravity.recordDecision({
      taskId: task.task_id,
      topic: 'Discount rounding strategy',
      decision: 'Use integer cents arithmetic in CheckoutService.calculateTotal()'
    });

    await openCode.reportTestResults({
      taskId: joined.subtask.task_id,
      command: 'npm test -- tests/checkout/discount.spec.js',
      exitCode: 0,
      passedCount: 14,
      failedCount: 0,
      outputSummary: 'PASS: 14 passed, 0 failed'
    });
    await openCode.reportTestResults({
      taskId: task.task_id,
      command: 'npm test -- tests/checkout/discount.spec.js',
      exitCode: 0,
      passedCount: 14,
      failedCount: 0,
      outputSummary: 'PASS: 14 passed, 0 failed'
    });

    await openCode.verifyCompletion(joined.subtask.task_id);
    await claudeReviewer.submitReview({
      taskId: task.task_id,
      approved: true,
      findingsSummary:
        'Approved: integer-cents math eliminates rounding drift and negative discount injection.'
    });
    await antiGravity.verifyCompletion(task.task_id);

    const dashboardState = await collectDashboardState(coordAG);
    console.log(renderTerminalDashboard(dashboardState));

    const consolidatedReport = await coordAG.generateConsolidatedReport(task.task_id);
    console.log('\nCONSOLIDATED FINAL REPORT:');
    console.log(JSON.stringify(consolidatedReport, null, 2));
  } finally {
    await coordAG.close();
    await coordOC.close();
    await coordCC.close();
    fs.rmSync(demoDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  runDemo().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { runDemo };
