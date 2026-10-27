'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Generates real-time CLI and HTML observability snapshots directly from the
 * authoritative SQLite coordination state. Never displays mocked or fabricated activity.
 */
async function collectDashboardState(coordinator) {
  await coordinator.init();
  const nowIso = new Date().toISOString();

  return coordinator.db.transaction(async (tx) => {
    await coordinator._reapExpiredLeasesAndStaleAgents(tx, nowIso);

    const agents = await tx.all('SELECT * FROM agents ORDER BY registered_at ASC');
    const tasks = await tx.all('SELECT * FROM tasks ORDER BY created_at ASC');
    const dependencies = await tx.all('SELECT * FROM task_dependencies');
    const leases = await tx.all('SELECT * FROM resource_leases ORDER BY acquired_at ASC');
    const transitions = await tx.all(
      'SELECT * FROM ownership_transitions ORDER BY created_at DESC LIMIT 30'
    );
    const messages = await tx.all('SELECT * FROM messages ORDER BY created_at DESC LIMIT 25');
    const decisions = await tx.all(
      "SELECT * FROM decisions WHERE status = 'ACTIVE' ORDER BY created_at DESC"
    );
    const evidence = await tx.all(
      'SELECT * FROM verification_evidence ORDER BY created_at DESC LIMIT 25'
    );

    return {
      generated_at: nowIso,
      workspace_root: coordinator.workspaceRoot,
      db_path: coordinator.dbPath,
      agents,
      tasks,
      dependencies,
      leases,
      conflicts: transitions.filter((t) => t.transition_type === 'CONFLICT_REJECTED'),
      transitions,
      messages: messages.reverse(),
      decisions,
      evidence
    };
  });
}

function renderTerminalDashboard(state) {
  const lines = [];
  lines.push('================================================================================');
  lines.push(' UNIVERSAL AGENT COORDINATION (UAC) — LIVE STATE OBSERVABILITY');
  lines.push(` Workspace : ${state.workspace_root}`);
  lines.push(` Database  : ${state.db_path}`);
  lines.push(` Timestamp : ${state.generated_at}`);
  lines.push('================================================================================');
  lines.push('');

  lines.push(`CONNECTED AGENTS (${state.agents.length})`);
  if (state.agents.length === 0) {
    lines.push('  (No agents registered)');
  } else {
    for (const a of state.agents) {
      lines.push(
        `  - [${a.status}] ${a.agent_id} (${a.ide} | role: ${a.role}) last heartbeat: ${a.last_heartbeat_at}`
      );
    }
  }
  lines.push('');

  lines.push(`SHARED TASKS (${state.tasks.length})`);
  if (state.tasks.length === 0) {
    lines.push('  (No tasks created)');
  } else {
    for (const t of state.tasks) {
      const parentTag = t.parent_task_id ? ` [subtask of ${t.parent_task_id}]` : '';
      const ownerTag = t.owner_agent_id ? ` owner=${t.owner_agent_id}` : ' owner=UNASSIGNED';
      const deps = state.dependencies
        .filter((d) => d.task_id === t.task_id)
        .map((d) => d.depends_on_task_id);
      const depTag = deps.length > 0 ? ` depends_on=[${deps.join(', ')}]` : '';
      lines.push(
        `  - [${t.status}] ${t.task_id}: ${t.title}${parentTag} (${t.priority},${ownerTag}${depTag}, v${t.version})`
      );
      if (t.blocker_reason) {
        lines.push(`      BLOCKER: ${t.blocker_reason}`);
      }
    }
  }
  lines.push('');

  lines.push(`ACTIVE RESOURCE LEASES (${state.leases.length})`);
  if (state.leases.length === 0) {
    lines.push('  (No active resource leases)');
  } else {
    for (const l of state.leases) {
      lines.push(
        `  - ${l.scope_pattern} -> owner=${l.owner_agent_id} (task=${l.task_id}, mode=${l.mode}, expires=${l.expires_at})`
      );
    }
  }
  lines.push('');

  lines.push(`OWNERSHIP CONFLICTS PREVENTED (${state.conflicts.length})`);
  if (state.conflicts.length === 0) {
    lines.push('  (Zero ownership conflicts recorded)');
  } else {
    for (const c of state.conflicts) {
      lines.push(
        `  - [${c.created_at}] Scope '${c.scope_pattern}' requested by '${c.to_agent_id}' rejected (held by '${c.from_agent_id}')`
      );
    }
  }
  lines.push('');

  lines.push(`VERIFICATION & REVIEW EVIDENCE (${state.evidence.length})`);
  if (state.evidence.length === 0) {
    lines.push('  (No verification evidence recorded yet)');
  } else {
    for (const e of state.evidence) {
      const verdict = e.passed === 1 ? 'PASSED' : 'FAILED';
      lines.push(
        `  - [${verdict}] [${e.evidence_type}] task=${e.task_id} by=${e.agent_id} cmd="${e.command || ''}" (${e.output_summary})`
      );
    }
  }
  lines.push('');

  lines.push(`RECENT AGENT MESSAGES & HANDOFFS (${state.messages.length})`);
  if (state.messages.length === 0) {
    lines.push('  (No messages exchanged)');
  } else {
    for (const m of state.messages) {
      const toTag = m.recipient_agent_id ? ` -> ${m.recipient_agent_id}` : ' -> ALL';
      lines.push(
        `  - [${m.message_type}] ${m.sender_agent_id}${toTag} (task=${m.task_id || 'global'}): ${m.content}`
      );
    }
  }
  lines.push('================================================================================');
  return lines.join('\n');
}

function writeHtmlDashboardSnapshot(state, outputPath) {
  const esc = (s) =>
    String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Universal Agent Coordination (UAC) — Live State</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; margin: 24px; background: #0f172a; color: #e2e8f0; }
    h1, h2 { color: #f8fafc; margin-bottom: 8px; }
    .meta { color: #94a3b8; font-size: 0.9rem; margin-bottom: 24px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 16px; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 16px; }
    table { width: 100%; border-collapse: collapse; font-size: 0.88rem; margin-top: 8px; }
    th, td { text-align: left; padding: 8px; border-bottom: 1px solid #334155; }
    th { color: #94a3b8; font-weight: 600; }
    .badge { padding: 2px 8px; border-radius: 999px; font-size: 0.75rem; font-weight: 600; background: #334155; }
    .DONE, .ONLINE, .PASSED { background: #065f46; color: #a7f3d0; }
    .IN_PROGRESS, .CLAIMED { background: #1e40af; color: #bfdbfe; }
    .BLOCKED, .FAILED { background: #991b1b; color: #fecaca; }
  </style>
</head>
<body>
  <h1>Universal Agent Coordination (@followprotocol)</h1>
  <div class="meta">
    Workspace: <code>${esc(state.workspace_root)}</code> |
    Generated: <code>${esc(state.generated_at)}</code>
  </div>
  <div class="grid">
    <div class="card">
      <h2>Connected Agents (${state.agents.length})</h2>
      <table>
        <thead><tr><th>Agent ID</th><th>IDE</th><th>Role</th><th>Status</th><th>Last Heartbeat</th></tr></thead>
        <tbody>
          ${state.agents
            .map(
              (a) =>
                `<tr><td><code>${esc(a.agent_id)}</code></td><td>${esc(a.ide)}</td><td>${esc(a.role)}</td><td><span class="badge ${esc(a.status)}">${esc(a.status)}</span></td><td>${esc(a.last_heartbeat_at)}</td></tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>
    <div class="card">
      <h2>Tasks (${state.tasks.length})</h2>
      <table>
        <thead><tr><th>Task ID</th><th>Title</th><th>Owner</th><th>Status</th><th>Version</th></tr></thead>
        <tbody>
          ${state.tasks
            .map(
              (t) =>
                `<tr><td><code>${esc(t.task_id)}</code></td><td>${esc(t.title)}</td><td><code>${esc(t.owner_agent_id || '-')}</code></td><td><span class="badge ${esc(t.status)}">${esc(t.status)}</span></td><td>v${esc(t.version)}</td></tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>
    <div class="card">
      <h2>Active Resource Leases (${state.leases.length})</h2>
      <table>
        <thead><tr><th>Scope</th><th>Owner</th><th>Task</th><th>Expires</th></tr></thead>
        <tbody>
          ${state.leases
            .map(
              (l) =>
                `<tr><td><code>${esc(l.scope_pattern)}</code></td><td><code>${esc(l.owner_agent_id)}</code></td><td><code>${esc(l.task_id)}</code></td><td>${esc(l.expires_at)}</td></tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>
    <div class="card">
      <h2>Verification Evidence (${state.evidence.length})</h2>
      <table>
        <thead><tr><th>Type</th><th>Task</th><th>Agent</th><th>Verdict</th><th>Summary</th></tr></thead>
        <tbody>
          ${state.evidence
            .map(
              (e) =>
                `<tr><td>${esc(e.evidence_type)}</td><td><code>${esc(e.task_id)}</code></td><td><code>${esc(e.agent_id)}</code></td><td><span class="badge ${e.passed ? 'PASSED' : 'FAILED'}">${e.passed ? 'PASSED' : 'FAILED'}</span></td><td>${esc(e.output_summary)}</td></tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>
  </div>
</body>
</html>`;

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, html, 'utf8');
  return outputPath;
}

module.exports = {
  collectDashboardState,
  renderTerminalDashboard,
  writeHtmlDashboardSnapshot
};
