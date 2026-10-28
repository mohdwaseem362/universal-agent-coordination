'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Pure-Node.js ACID File-Locked Database Engine for Universal Agent Coordination.
 * Used automatically on Windows/macOS/Linux systems where Python 3 is not installed
 * or where `python3.exe` is the Windows Store stub (exit code 9009).
 *
 * Uses cross-process atomic directory locks (`<dbPath>.lock`) with async non-blocking
 * backoff (so both single-process multi-client and multi-process callers never block the
 * Node event loop) and atomic write-rename persistence.
 */

const DEFAULT_TABLES = () => ({
  _seq: 0,
  schema_migrations: [],
  agents: [],
  tasks: [],
  task_participants: [],
  task_dependencies: [],
  resource_leases: [],
  ownership_transitions: [],
  handoff_requests: [],
  messages: [],
  decisions: [],
  verification_evidence: [],
  audit_log: []
});

const sleepAsync = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class PureNodeDatabaseEngine {
  constructor(dbPath) {
    this.dbPath = path.resolve(dbPath);
    this.lockDir = `${this.dbPath}.lock`;
    this.inTx = false;
    this.txState = null;
  }

  async _acquireLock(timeoutMs = 5000) {
    const start = Date.now();
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    while (true) {
      try {
        fs.mkdirSync(this.lockDir);
        return;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        try {
          const stat = fs.statSync(this.lockDir);
          if (Date.now() - stat.mtimeMs > 10000) {
            fs.rmdirSync(this.lockDir);
            continue;
          }
        } catch (_) {
          continue;
        }
        if (Date.now() - start >= timeoutMs) {
          const busyErr = new Error('SQLITE_BUSY: database is locked');
          busyErr.code = 'SQLITE_OPERATIONAL_ERROR';
          throw busyErr;
        }
        await sleepAsync(10);
      }
    }
  }

  _releaseLock() {
    try {
      fs.rmdirSync(this.lockDir);
    } catch (_) {
      // ignore if already removed
    }
  }

  _loadDiskState() {
    if (!fs.existsSync(this.dbPath)) {
      return DEFAULT_TABLES();
    }
    try {
      const raw = fs.readFileSync(this.dbPath, 'utf8');
      if (!raw.trim()) return DEFAULT_TABLES();
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_TABLES(), ...parsed };
    } catch (_) {
      return DEFAULT_TABLES();
    }
  }

  _saveDiskState(state) {
    const tmpPath = `${this.dbPath}.${process.pid}.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2, 7)}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(state), 'utf8');
    fs.renameSync(tmpPath, this.dbPath);
  }

  async execScript() {
    await this._acquireLock();
    try {
      const state = this._loadDiskState();
      this._saveDiskState(state);
      return { ok: true };
    } finally {
      this._releaseLock();
    }
  }

  async beginImmediate() {
    await this._acquireLock();
    this.inTx = true;
    this.txState = this._loadDiskState();
    return { ok: true };
  }

  async commit() {
    if (!this.inTx) return { ok: true };
    try {
      this._saveDiskState(this.txState);
      return { ok: true };
    } finally {
      this.inTx = false;
      this.txState = null;
      this._releaseLock();
    }
  }

  async rollback() {
    if (!this.inTx) return { ok: true };
    this.inTx = false;
    this.txState = null;
    this._releaseLock();
    return { ok: true };
  }

  async query(sql, params = []) {
    if (this.inTx) {
      const rows = this._evalQuery(this.txState, sql, params);
      return { ok: true, rows, rowcount: rows.length, lastrowid: 0 };
    }
    await this._acquireLock();
    try {
      const state = this._loadDiskState();
      const rows = this._evalQuery(state, sql, params);
      return { ok: true, rows, rowcount: rows.length, lastrowid: 0 };
    } finally {
      this._releaseLock();
    }
  }

  async run(sql, params = []) {
    if (this.inTx) {
      const res = this._evalRun(this.txState, sql, params);
      return { ok: true, changes: res.changes, lastrowid: res.lastrowid };
    }
    await this._acquireLock();
    try {
      const state = this._loadDiskState();
      const res = this._evalRun(state, sql, params);
      this._saveDiskState(state);
      return { ok: true, changes: res.changes, lastrowid: res.lastrowid };
    } finally {
      this._releaseLock();
    }
  }

  async close() {
    if (this.inTx) {
      await this.rollback();
    }
  }

  _evalQuery(s, rawSql, params) {
    const sql = rawSql.replace(/\s+/g, ' ').trim();

    if (sql.startsWith('SELECT version FROM schema_migrations WHERE version = 1')) {
      return s.schema_migrations.filter((r) => r.version === 1).map((r) => ({ version: r.version }));
    }

    if (sql === 'SELECT * FROM agents WHERE agent_id = ?') {
      return s.agents.filter((a) => a.agent_id === params[0]).map((a) => ({ ...a }));
    }

    if (sql === 'SELECT * FROM agents ORDER BY registered_at ASC') {
      return [...s.agents].sort((a, b) => a.registered_at.localeCompare(b.registered_at));
    }

    if (sql === 'SELECT * FROM resource_leases WHERE expires_at <= ?') {
      return s.resource_leases.filter((l) => l.expires_at <= params[0]);
    }

    if (sql === 'SELECT * FROM resource_leases WHERE expires_at > ?') {
      return s.resource_leases.filter((l) => l.expires_at > params[0]);
    }

    if (sql === 'SELECT * FROM resource_leases WHERE lease_id = ?') {
      return s.resource_leases.filter((l) => l.lease_id === params[0]);
    }

    if (sql === 'SELECT * FROM resource_leases WHERE scope_pattern = ?') {
      return s.resource_leases.filter((l) => l.scope_pattern === params[0]);
    }

    if (sql === 'SELECT * FROM resource_leases WHERE task_id = ?') {
      return s.resource_leases.filter((l) => l.task_id === params[0]);
    }

    if (sql === 'SELECT * FROM resource_leases WHERE task_id = ? AND owner_agent_id = ?') {
      return s.resource_leases.filter(
        (l) => l.task_id === params[0] && l.owner_agent_id === params[1]
      );
    }

    if (sql === 'SELECT scope_pattern FROM resource_leases WHERE task_id = ? AND owner_agent_id = ?') {
      return s.resource_leases
        .filter((l) => l.task_id === params[0] && l.owner_agent_id === params[1])
        .map((l) => ({ scope_pattern: l.scope_pattern }));
    }

    if (sql === 'SELECT scope_pattern, task_id, expires_at FROM resource_leases WHERE owner_agent_id = ?') {
      return s.resource_leases
        .filter((l) => l.owner_agent_id === params[0])
        .map((l) => ({ scope_pattern: l.scope_pattern, task_id: l.task_id, expires_at: l.expires_at }));
    }

    if (sql === 'SELECT scope_pattern, task_id, owner_agent_id, expires_at FROM resource_leases') {
      return s.resource_leases.map((l) => ({
        scope_pattern: l.scope_pattern,
        task_id: l.task_id,
        owner_agent_id: l.owner_agent_id,
        expires_at: l.expires_at
      }));
    }

    if (sql === 'SELECT lease_id, scope_pattern, owner_agent_id, mode, expires_at FROM resource_leases WHERE task_id = ?') {
      return s.resource_leases
        .filter((l) => l.task_id === params[0])
        .map((l) => ({
          lease_id: l.lease_id,
          scope_pattern: l.scope_pattern,
          owner_agent_id: l.owner_agent_id,
          mode: l.mode,
          expires_at: l.expires_at
        }));
    }

    if (sql === 'SELECT * FROM resource_leases ORDER BY acquired_at ASC') {
      return [...s.resource_leases].sort((a, b) => a.acquired_at.localeCompare(b.acquired_at));
    }

    if (sql.includes("FROM tasks WHERE status = 'CLAIMED' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?")) {
      return s.tasks.filter(
        (t) => t.status === 'CLAIMED' && t.lease_expires_at && t.lease_expires_at <= params[0]
      );
    }

    if (sql === 'SELECT * FROM tasks WHERE task_id = ?' || sql === 'SELECT task_id FROM tasks WHERE task_id = ?') {
      return s.tasks.filter((t) => t.task_id === params[0]);
    }

    if (sql === 'SELECT task_id, title, status FROM tasks WHERE owner_agent_id = ?') {
      return s.tasks
        .filter((t) => t.owner_agent_id === params[0])
        .map((t) => ({ task_id: t.task_id, title: t.title, status: t.status }));
    }

    if (sql === 'SELECT task_id, title, status, owner_agent_id FROM tasks WHERE owner_agent_id IS NOT NULL') {
      return s.tasks
        .filter((t) => t.owner_agent_id !== null)
        .map((t) => ({
          task_id: t.task_id,
          title: t.title,
          status: t.status,
          owner_agent_id: t.owner_agent_id
        }));
    }

    if (sql.includes("FROM tasks WHERE parent_task_id = ? AND status != 'CANCELLED'")) {
      return s.tasks.filter((t) => t.parent_task_id === params[0] && t.status !== 'CANCELLED');
    }

    if (sql === 'SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY created_at ASC') {
      return s.tasks
        .filter((t) => t.parent_task_id === params[0])
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
    }

    if (sql.startsWith('SELECT * FROM tasks') && sql.endsWith('ORDER BY created_at ASC')) {
      let rows = [...s.tasks];
      let pIdx = 0;
      if (sql.includes('status = ?')) {
        const val = params[pIdx++];
        rows = rows.filter((r) => r.status === val);
      }
      if (sql.includes('owner_agent_id = ?')) {
        const val = params[pIdx++];
        rows = rows.filter((r) => r.owner_agent_id === val);
      }
      if (sql.includes('parent_task_id IS NULL')) {
        rows = rows.filter((r) => r.parent_task_id === null);
      } else if (sql.includes('parent_task_id = ?')) {
        const val = params[pIdx++];
        rows = rows.filter((r) => r.parent_task_id === val);
      }
      if (sql.includes('LOWER(title) LIKE ?')) {
        const pattern = String(params[pIdx] || '').replace(/^%|%$/g, '');
        pIdx += 2;
        rows = rows.filter(
          (r) =>
            r.title.toLowerCase().includes(pattern) ||
            (r.description || '').toLowerCase().includes(pattern)
        );
      }
      return rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
    }

    if (sql === 'SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?') {
      return s.task_dependencies
        .filter((d) => d.task_id === params[0])
        .map((d) => ({ depends_on_task_id: d.depends_on_task_id }));
    }

    if (sql === 'SELECT * FROM task_dependencies') {
      return [...s.task_dependencies];
    }

    if (sql.includes('FROM task_dependencies d JOIN tasks t ON t.task_id = d.depends_on_task_id WHERE d.task_id = ?')) {
      const onlyIncomplete = sql.includes("t.status != 'DONE'");
      return s.task_dependencies
        .filter((d) => d.task_id === params[0])
        .map((d) => {
          const t = s.tasks.find((x) => x.task_id === d.depends_on_task_id);
          return t
            ? { depends_on_task_id: d.depends_on_task_id, title: t.title, status: t.status }
            : null;
        })
        .filter((r) => r && (!onlyIncomplete || r.status !== 'DONE'));
    }

    if (sql === 'SELECT * FROM task_participants WHERE task_id = ? AND agent_id = ?') {
      return s.task_participants.filter(
        (p) => p.task_id === params[0] && p.agent_id === params[1]
      );
    }

    if (sql === 'SELECT agent_id, role, joined_at FROM task_participants WHERE task_id = ?') {
      return s.task_participants
        .filter((p) => p.task_id === params[0])
        .map((p) => ({ agent_id: p.agent_id, role: p.role, joined_at: p.joined_at }));
    }

    if (sql.includes('FROM task_participants p JOIN agents a ON a.agent_id = p.agent_id WHERE p.task_id IN')) {
      const seen = new Set();
      const out = [];
      for (const p of s.task_participants) {
        if (!params.includes(p.task_id)) continue;
        const a = s.agents.find((x) => x.agent_id === p.agent_id);
        if (!a) continue;
        const key = `${p.agent_id}:${p.role}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          agent_id: p.agent_id,
          role: p.role,
          name: a.name,
          ide: a.ide,
          status: a.status
        });
      }
      return out;
    }

    if (sql === 'SELECT * FROM messages WHERE message_id = ?') {
      return s.messages.filter((m) => m.message_id === params[0]);
    }

    if (sql === 'SELECT * FROM messages WHERE task_id = ? ORDER BY created_at ASC') {
      return s.messages
        .filter((m) => m.task_id === params[0])
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
    }

    if (sql.startsWith('SELECT * FROM messages WHERE task_id IN')) {
      return s.messages
        .filter((m) => params.includes(m.task_id))
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
    }

    if (sql === 'SELECT * FROM messages ORDER BY created_at DESC LIMIT 25') {
      return [...s.messages].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 25);
    }

    if (sql.startsWith('SELECT * FROM messages') && sql.includes('ORDER BY created_at ASC LIMIT ?')) {
      let rows = [...s.messages];
      let pIdx = 0;
      if (sql.includes('task_id = ?')) {
        const v = params[pIdx++];
        rows = rows.filter((m) => m.task_id === v);
      }
      if (sql.includes('(recipient_agent_id = ? OR recipient_agent_id IS NULL)')) {
        const v = params[pIdx++];
        rows = rows.filter((m) => m.recipient_agent_id === v || m.recipient_agent_id === null);
      }
      if (sql.includes('message_type = ?')) {
        const v = params[pIdx++];
        rows = rows.filter((m) => m.message_type === v);
      }
      if (sql.includes('created_at >= ?')) {
        const v = params[pIdx++];
        rows = rows.filter((m) => m.created_at >= v);
      }
      const limit = params[params.length - 1] || 100;
      return rows.sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(0, limit);
    }

    if (sql === 'SELECT * FROM decisions WHERE decision_id = ?') {
      return s.decisions.filter((d) => d.decision_id === params[0]);
    }

    if (sql === "SELECT * FROM decisions WHERE task_id = ? AND status = 'ACTIVE' ORDER BY created_at ASC") {
      return s.decisions
        .filter((d) => d.task_id === params[0] && d.status === 'ACTIVE')
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
    }

    if (sql.startsWith('SELECT * FROM decisions WHERE task_id IN')) {
      return s.decisions
        .filter((d) => params.includes(d.task_id))
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
    }

    if (sql === "SELECT * FROM decisions WHERE status = 'ACTIVE' ORDER BY created_at DESC") {
      return s.decisions
        .filter((d) => d.status === 'ACTIVE')
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
    }

    if (sql === 'SELECT * FROM handoff_requests WHERE handoff_id = ?') {
      return s.handoff_requests.filter((h) => h.handoff_id === params[0]);
    }

    if (sql === 'SELECT * FROM verification_evidence WHERE evidence_id = ?') {
      return s.verification_evidence.filter((e) => e.evidence_id === params[0]);
    }

    if (sql.startsWith('SELECT * FROM verification_evidence WHERE task_id IN')) {
      const desc = sql.includes('DESC');
      const filtered = s.verification_evidence.filter((e) => params.includes(e.task_id));
      return filtered.sort((a, b) =>
        desc ? (b._rowid || 0) - (a._rowid || 0) : (a._rowid || 0) - (b._rowid || 0)
      );
    }

    if (sql === 'SELECT * FROM verification_evidence ORDER BY created_at DESC LIMIT 25') {
      return [...s.verification_evidence]
        .sort((a, b) => (b._rowid || 0) - (a._rowid || 0))
        .slice(0, 25);
    }

    if (sql.startsWith('SELECT * FROM ownership_transitions WHERE task_id IN')) {
      return s.ownership_transitions
        .filter((t) => params.includes(t.task_id))
        .sort((a, b) => (a._rowid || 0) - (b._rowid || 0));
    }

    if (sql === 'SELECT * FROM ownership_transitions ORDER BY created_at DESC LIMIT 30') {
      return [...s.ownership_transitions]
        .sort((a, b) => (b._rowid || 0) - (a._rowid || 0))
        .slice(0, 30);
    }

    return [];
  }

  _evalRun(s, rawSql, params) {
    const sql = rawSql.replace(/\s+/g, ' ').trim();
    const nextRowId = () => {
      s._seq = (s._seq || 0) + 1;
      return s._seq;
    };

    if (sql.startsWith('INSERT OR IGNORE INTO schema_migrations')) {
      if (!s.schema_migrations.some((m) => m.version === params[0])) {
        s.schema_migrations.push({
          version: params[0],
          name: params[1],
          applied_at: params[2]
        });
        return { changes: 1, lastrowid: nextRowId() };
      }
      return { changes: 0, lastrowid: 0 };
    }

    if (sql.startsWith('INSERT INTO agents')) {
      s.agents.push({
        agent_id: params[0],
        name: params[1],
        ide: params[2],
        role: params[3],
        capabilities_json: params[4],
        workspace_root: params[5],
        session_token_hash: params[6],
        status: 'ONLINE',
        last_heartbeat_at: params[7],
        registered_at: params[8],
        metadata_json: params[9]
      });
      return { changes: 1, lastrowid: nextRowId() };
    }

    if (sql.startsWith('UPDATE agents SET name = ?')) {
      let changes = 0;
      for (const a of s.agents) {
        if (a.agent_id === params[8]) {
          a.name = params[0];
          a.ide = params[1];
          a.role = params[2];
          a.capabilities_json = params[3];
          a.workspace_root = params[4];
          a.session_token_hash = params[5];
          a.status = 'ONLINE';
          a.last_heartbeat_at = params[6];
          a.metadata_json = params[7];
          changes++;
        }
      }
      return { changes, lastrowid: 0 };
    }

    if (sql.startsWith("UPDATE agents SET status = 'STALE'")) {
      let changes = 0;
      for (const a of s.agents) {
        if ((a.status === 'ONLINE' || a.status === 'BUSY') && a.last_heartbeat_at < params[0]) {
          a.status = 'STALE';
          changes++;
        }
      }
      return { changes, lastrowid: 0 };
    }

    if (sql.startsWith('UPDATE agents SET last_heartbeat_at = ?')) {
      let changes = 0;
      for (const a of s.agents) {
        if (a.agent_id === params[1]) {
          a.last_heartbeat_at = params[0];
          if (a.status === 'STALE') a.status = 'ONLINE';
          changes++;
        }
      }
      return { changes, lastrowid: 0 };
    }

    if (sql.startsWith('INSERT INTO tasks')) {
      if (params.length === 16) {
        // createTask (16 params)
        s.tasks.push({
          task_id: params[0],
          parent_task_id: params[1],
          title: params[2],
          description: params[3],
          acceptance_criteria_json: params[4],
          priority: params[5],
          status: params[6],
          created_by: params[7],
          owner_agent_id: params[8],
          claimed_scopes_json: params[9],
          retry_count: 0,
          max_retries: params[10],
          blocker_reason: null,
          require_independent_review: params[11],
          require_test_execution: params[12],
          lease_expires_at: params[13],
          version: 1,
          created_at: params[14],
          updated_at: params[15],
          completed_at: null
        });
      } else {
        // joinTask subtask insert (15 params where max_retries=3 is literal in SQL)
        s.tasks.push({
          task_id: params[0],
          parent_task_id: params[1],
          title: params[2],
          description: params[3],
          acceptance_criteria_json: params[4],
          priority: params[5],
          status: params[6],
          created_by: params[7],
          owner_agent_id: params[8],
          claimed_scopes_json: params[9],
          retry_count: 0,
          max_retries: 3,
          blocker_reason: null,
          require_independent_review: params[10],
          require_test_execution: params[11],
          lease_expires_at: params[12],
          version: 1,
          created_at: params[13],
          updated_at: params[14],
          completed_at: null
        });
      }
      return { changes: 1, lastrowid: nextRowId() };
    }

    if (sql.startsWith("UPDATE tasks SET status = 'OPEN', owner_agent_id = NULL")) {
      let changes = 0;
      for (const t of s.tasks) {
        if (t.task_id === params[1]) {
          t.status = 'OPEN';
          t.owner_agent_id = null;
          t.lease_expires_at = null;
          t.version += 1;
          t.updated_at = params[0];
          changes++;
        }
      }
      return { changes, lastrowid: 0 };
    }

    if (sql.startsWith("UPDATE tasks SET status = 'CLAIMED', owner_agent_id = ?")) {
      let changes = 0;
      for (const t of s.tasks) {
        if (t.task_id === params[4] && t.version === params[5]) {
          t.status = 'CLAIMED';
          t.owner_agent_id = params[0];
          t.claimed_scopes_json = params[1];
          t.lease_expires_at = params[2];
          t.version += 1;
          t.updated_at = params[3];
          changes++;
        }
      }
      return { changes, lastrowid: 0 };
    }

    if (sql.startsWith('UPDATE tasks SET status = ?, owner_agent_id = ?, retry_count = ?')) {
      let changes = 0;
      for (const t of s.tasks) {
        if (t.task_id === params[6] && t.version === params[7]) {
          t.status = params[0];
          t.owner_agent_id = params[1];
          t.retry_count = params[2];
          t.blocker_reason = params[3];
          t.lease_expires_at = params[4];
          t.version += 1;
          t.updated_at = params[5];
          changes++;
        }
      }
      return { changes, lastrowid: 0 };
    }

    if (sql.startsWith('UPDATE tasks SET owner_agent_id = ?, lease_expires_at = ?')) {
      let changes = 0;
      for (const t of s.tasks) {
        if (t.task_id === params[3]) {
          t.owner_agent_id = params[0];
          t.lease_expires_at = params[1];
          t.version += 1;
          t.updated_at = params[2];
          changes++;
        }
      }
      return { changes, lastrowid: 0 };
    }

    if (sql.startsWith('UPDATE tasks SET claimed_scopes_json = ?')) {
      let changes = 0;
      for (const t of s.tasks) {
        if (t.task_id === params[2]) {
          t.claimed_scopes_json = params[0];
          t.updated_at = params[1];
          changes++;
        }
      }
      return { changes, lastrowid: 0 };
    }

    if (sql.startsWith("UPDATE tasks SET status = 'VERIFYING'")) {
      let changes = 0;
      for (const t of s.tasks) {
        if (t.task_id === params[1]) {
          t.status = 'VERIFYING';
          t.version += 1;
          t.updated_at = params[0];
          changes++;
        }
      }
      return { changes, lastrowid: 0 };
    }

    if (sql.startsWith("UPDATE tasks SET status = 'DONE'")) {
      let changes = 0;
      for (const t of s.tasks) {
        if (t.task_id === params[2]) {
          t.status = 'DONE';
          t.lease_expires_at = null;
          t.completed_at = params[0];
          t.version += 1;
          t.updated_at = params[1];
          changes++;
        }
      }
      return { changes, lastrowid: 0 };
    }

    if (sql.startsWith('INSERT OR IGNORE INTO task_participants')) {
      const exists = s.task_participants.some(
        (p) => p.task_id === params[0] && p.agent_id === params[1]
      );
      if (!exists) {
        s.task_participants.push({
          task_id: params[0],
          agent_id: params[1],
          role: params[2],
          joined_at: params[3]
        });
        return { changes: 1, lastrowid: nextRowId() };
      }
      return { changes: 0, lastrowid: 0 };
    }

    if (sql.startsWith('INSERT OR REPLACE INTO task_participants')) {
      s.task_participants = s.task_participants.filter(
        (p) => !(p.task_id === params[0] && p.agent_id === params[1])
      );
      s.task_participants.push({
        task_id: params[0],
        agent_id: params[1],
        role: 'owner',
        joined_at: params[2]
      });
      return { changes: 1, lastrowid: nextRowId() };
    }

    if (sql.startsWith('INSERT OR IGNORE INTO task_dependencies')) {
      const exists = s.task_dependencies.some(
        (d) => d.task_id === params[0] && d.depends_on_task_id === params[1]
      );
      if (!exists) {
        s.task_dependencies.push({
          task_id: params[0],
          depends_on_task_id: params[1],
          created_at: params[2]
        });
        return { changes: 1, lastrowid: nextRowId() };
      }
      return { changes: 0, lastrowid: 0 };
    }

    if (sql.startsWith('INSERT INTO resource_leases')) {
      s.resource_leases.push({
        lease_id: params[0],
        scope_pattern: params[1],
        task_id: params[2],
        owner_agent_id: params[3],
        mode: params[4],
        baseline_hashes_json: params[5],
        acquired_at: params[6],
        expires_at: params[7],
        renewed_count: 0
      });
      return { changes: 1, lastrowid: nextRowId() };
    }

    if (sql.startsWith('UPDATE resource_leases SET task_id = ?')) {
      let changes = 0;
      for (const l of s.resource_leases) {
        if (l.lease_id === params[2]) {
          l.task_id = params[0];
          l.expires_at = params[1];
          l.renewed_count += 1;
          changes++;
        }
      }
      return { changes, lastrowid: 0 };
    }

    if (sql.startsWith('UPDATE resource_leases SET owner_agent_id = ?')) {
      let changes = 0;
      for (const l of s.resource_leases) {
        if (l.lease_id === params[2]) {
          l.owner_agent_id = params[0];
          l.expires_at = params[1];
          l.renewed_count += 1;
          changes++;
        }
      }
      return { changes, lastrowid: 0 };
    }

    if (sql === 'DELETE FROM resource_leases WHERE lease_id = ?') {
      const before = s.resource_leases.length;
      s.resource_leases = s.resource_leases.filter((l) => l.lease_id !== params[0]);
      return { changes: before - s.resource_leases.length, lastrowid: 0 };
    }

    if (sql === 'DELETE FROM resource_leases WHERE task_id = ? AND owner_agent_id = ?') {
      const before = s.resource_leases.length;
      s.resource_leases = s.resource_leases.filter(
        (l) => !(l.task_id === params[0] && l.owner_agent_id === params[1])
      );
      return { changes: before - s.resource_leases.length, lastrowid: 0 };
    }

    if (sql.startsWith('INSERT INTO ownership_transitions')) {
      const rowid = nextRowId();
      if (sql.includes("NULL, 'LEASE_EXPIRED'")) {
        s.ownership_transitions.push({
          _rowid: rowid,
          transition_id: params[0],
          scope_pattern: params[1],
          task_id: params[2],
          from_agent_id: params[3],
          to_agent_id: null,
          transition_type: 'LEASE_EXPIRED',
          reason: 'Lease TTL expired without renewal',
          created_at: params[4]
        });
      } else if (sql.includes("NULL, ?, 'CLAIMED'")) {
        s.ownership_transitions.push({
          _rowid: rowid,
          transition_id: params[0],
          scope_pattern: params[1],
          task_id: params[2],
          from_agent_id: null,
          to_agent_id: params[3],
          transition_type: 'CLAIMED',
          reason: 'Resource scope claimed',
          created_at: params[4]
        });
      } else if (sql.includes("NULL, 'RELEASED'")) {
        const reason = sql.includes('Task completed')
          ? 'Task completed and verified'
          : 'Explicitly released by owner';
        s.ownership_transitions.push({
          _rowid: rowid,
          transition_id: params[0],
          scope_pattern: params[1],
          task_id: params[2],
          from_agent_id: params[3],
          to_agent_id: null,
          transition_type: 'RELEASED',
          reason,
          created_at: params[4]
        });
      } else {
        let tType = 'CONFLICT_REJECTED';
        if (sql.includes("'HANDOFF_ACCEPTED'")) tType = 'HANDOFF_ACCEPTED';
        if (sql.includes("'HANDOFF_REQUESTED'")) tType = 'HANDOFF_REQUESTED';
        s.ownership_transitions.push({
          _rowid: rowid,
          transition_id: params[0],
          scope_pattern: params[1],
          task_id: params[2],
          from_agent_id: params[3],
          to_agent_id: params[4],
          transition_type: tType,
          reason: params[5],
          created_at: params[6]
        });
      }
      return { changes: 1, lastrowid: rowid };
    }

    if (sql.startsWith('INSERT INTO handoff_requests')) {
      const rowid = nextRowId();
      s.handoff_requests.push({
        _rowid: rowid,
        handoff_id: params[0],
        task_id: params[1],
        from_agent_id: params[2],
        to_agent_id: params[3],
        scopes_json: params[4],
        summary: params[5],
        status: params[6],
        created_at: params[7],
        resolved_at: params[8]
      });
      return { changes: 1, lastrowid: rowid };
    }

    if (sql.startsWith('INSERT INTO messages')) {
      const rowid = nextRowId();
      if (params.length === 8) {
        s.messages.push({
          _rowid: rowid,
          message_id: params[0],
          task_id: params[1],
          sender_agent_id: params[2],
          recipient_agent_id: params[3],
          message_type: params[4],
          reply_to_message_id: params[5],
          content: params[6],
          redacted: params[7],
          acknowledged: 0,
          created_at: params[8] || new Date().toISOString()
        });
      } else if (params.length === 9) {
        s.messages.push({
          _rowid: rowid,
          message_id: params[0],
          task_id: params[1],
          sender_agent_id: params[2],
          recipient_agent_id: params[3],
          message_type: params[4],
          reply_to_message_id: params[5],
          content: params[6],
          redacted: params[7],
          acknowledged: 0,
          created_at: params[8]
        });
      } else if (sql.includes("'HANDOFF'") || sql.includes("'REVIEW'")) {
        const mType = sql.includes("'HANDOFF'") ? 'HANDOFF' : 'REVIEW';
        s.messages.push({
          _rowid: rowid,
          message_id: params[0],
          task_id: params[1],
          sender_agent_id: params[2],
          recipient_agent_id: params[3],
          message_type: mType,
          reply_to_message_id: null,
          content: params[4],
          redacted: params[5],
          acknowledged: 0,
          created_at: params[6]
        });
      } else {
        s.messages.push({
          _rowid: rowid,
          message_id: params[0],
          task_id: params[1],
          sender_agent_id: params[2],
          recipient_agent_id: null,
          message_type: params[3],
          reply_to_message_id: null,
          content: params[4],
          redacted: params[5],
          acknowledged: 0,
          created_at: params[6]
        });
      }
      return { changes: 1, lastrowid: rowid };
    }

    if (sql === 'UPDATE messages SET acknowledged = 1 WHERE message_id = ?') {
      let changes = 0;
      for (const m of s.messages) {
        if (m.message_id === params[0]) {
          m.acknowledged = 1;
          changes++;
        }
      }
      return { changes, lastrowid: 0 };
    }

    if (sql === "UPDATE decisions SET status = 'SUPERSEDED' WHERE decision_id = ?") {
      let changes = 0;
      for (const d of s.decisions) {
        if (d.decision_id === params[0]) {
          d.status = 'SUPERSEDED';
          changes++;
        }
      }
      return { changes, lastrowid: 0 };
    }

    if (sql.startsWith('INSERT INTO decisions')) {
      const rowid = nextRowId();
      s.decisions.push({
        _rowid: rowid,
        decision_id: params[0],
        task_id: params[1],
        author_agent_id: params[2],
        topic: params[3],
        decision: params[4],
        rationale: params[5],
        supersedes_decision_id: params[6],
        status: 'ACTIVE',
        created_at: params[7]
      });
      return { changes: 1, lastrowid: rowid };
    }

    if (sql.startsWith('INSERT INTO verification_evidence')) {
      const rowid = nextRowId();
      if (sql.includes("'TEST_RESULT'")) {
        s.verification_evidence.push({
          _rowid: rowid,
          evidence_id: params[0],
          task_id: params[1],
          agent_id: params[2],
          evidence_type: 'TEST_RESULT',
          command: params[3],
          exit_code: params[4],
          passed: params[5],
          passed_count: params[6],
          failed_count: params[7],
          output_summary: params[8],
          artifact_hashes_json: params[9],
          created_at: params[10]
        });
      } else {
        s.verification_evidence.push({
          _rowid: rowid,
          evidence_id: params[0],
          task_id: params[1],
          agent_id: params[2],
          evidence_type: 'INDEPENDENT_REVIEW',
          command: 'independent_review',
          exit_code: params[3],
          passed: params[4],
          passed_count: params[5],
          failed_count: params[6],
          output_summary: params[7],
          artifact_hashes_json: '{}',
          created_at: params[8]
        });
      }
      return { changes: 1, lastrowid: rowid };
    }

    if (sql.startsWith('INSERT INTO audit_log')) {
      const rowid = nextRowId();
      if (sql.includes("'OWNERSHIP_CONFLICT_REJECTED'")) {
        s.audit_log.push({
          id: rowid,
          event_type: 'OWNERSHIP_CONFLICT_REJECTED',
          agent_id: params[0],
          task_id: params[1],
          details_json: params[2],
          created_at: params[3]
        });
      } else {
        s.audit_log.push({
          id: rowid,
          event_type: params[0],
          agent_id: params[1],
          task_id: params[2],
          details_json: params[3],
          created_at: params[4]
        });
      }
      return { changes: 1, lastrowid: rowid };
    }

    return { changes: 0, lastrowid: 0 };
  }
}

module.exports = {
  PureNodeDatabaseEngine
};
