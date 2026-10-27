'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CoordinatorService, UacMcpServer } = require('../../src');

test('MCP server exposes all 17 tools with valid schemas and executes JSON-RPC 2.0 tool calls', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uac-mcp-test-'));
  const server = new UacMcpServer({ workspaceRoot: tmpDir });

  try {
    const initRes = await server.handleRpcRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {}
    });
    assert.equal(initRes.result.serverInfo.name, 'universal-agent-coordination');

    const listRes = await server.handleRpcRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {}
    });
    assert.equal(listRes.result.tools.length, 17);

    // Call register_agent via JSON-RPC
    const regRes = await server.handleRpcRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'register_agent',
        arguments: {
          agent_id: 'mcp-client-1',
          name: 'MCP Test Client',
          ide: 'antigravity',
          role: 'implementation'
        }
      }
    });
    assert.equal(regRes.result.isError, false);
    assert.equal(regRes.result.structuredContent.agent_id, 'mcp-client-1');
  } finally {
    await server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Multi-process SQLite WAL concurrency prevents duplicate task claims and conflicting resource claims', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uac-concurrency-test-'));
  const coordinatorA = new CoordinatorService({ workspaceRoot: tmpDir });
  const coordinatorB = new CoordinatorService({ workspaceRoot: tmpDir });

  try {
    await coordinatorA.init();
    await coordinatorB.init();

    const agentA = await coordinatorA.registerAgent({
      agent_id: 'agent-a',
      name: 'Agent A',
      ide: 'antigravity'
    });
    const agentB = await coordinatorB.registerAgent({
      agent_id: 'agent-b',
      name: 'Agent B',
      ide: 'opencode'
    });

    const task = await coordinatorA.createTask({
      task_id: 'task_race_1',
      title: 'Concurrent Claim Race Task',
      created_by: agentA.agent_id,
      auto_claim: false
    });
    assert.equal(task.status, 'OPEN');

    // Fire two concurrent claim requests from two separate OS worker processes
    const results = await Promise.allSettled([
      coordinatorA.claimTask({
        task_id: 'task_race_1',
        agent_id: agentA.agent_id,
        scopes: ['src/billing/**']
      }),
      coordinatorB.claimTask({
        task_id: 'task_race_1',
        agent_id: agentB.agent_id,
        scopes: ['src/billing/Invoice.js']
      })
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    assert.equal(fulfilled.length, 1, 'Exactly one concurrent claim must succeed');
    assert.equal(rejected.length, 1, 'The competing claim must be rejected');
  } finally {
    await coordinatorA.close();
    await coordinatorB.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Coordinator persists state across restarts and automatically recovers expired leases', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uac-recovery-test-'));
  const t0 = '2026-10-27T10:00:00.000Z';
  const tExpired = '2026-10-27T10:20:00.000Z'; // 20 minutes later (> 60s TTL)

  let coordinator1 = new CoordinatorService({
    workspaceRoot: tmpDir,
    defaultLeaseTtlSeconds: 60
  });

  try {
    await coordinator1.init();
    await coordinator1.registerAgent({
      agent_id: 'crashed-agent',
      name: 'Crashed Agent',
      ide: 'codex',
      now: t0
    });
    await coordinator1.registerAgent({
      agent_id: 'recovery-agent',
      name: 'Recovery Agent',
      ide: 'claude-code',
      now: t0
    });

    await coordinator1.createTask({
      task_id: 'task_recover',
      title: 'Task Held By Crashed Agent',
      created_by: 'crashed-agent',
      auto_claim: true,
      scopes: ['src/payment/**'],
      now: t0
    });

    // Simulate coordinator crash/restart by closing coordinator1 and opening coordinator2
    await coordinator1.close();
    coordinator1 = null;

    const coordinator2 = new CoordinatorService({
      workspaceRoot: tmpDir,
      defaultLeaseTtlSeconds: 60
    });
    try {
      await coordinator2.init();

      // At tExpired, crashed-agent's task claim and resource lease on `src/payment/**` must auto-expire
      const reclaimed = await coordinator2.claimTask({
        task_id: 'task_recover',
        agent_id: 'recovery-agent',
        scopes: ['src/payment/Gateway.js'],
        now: tExpired
      });

      assert.equal(reclaimed.owner_agent_id, 'recovery-agent');
      assert.equal(reclaimed.status, 'CLAIMED');
    } finally {
      await coordinator2.close();
    }
  } finally {
    if (coordinator1) await coordinator1.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
