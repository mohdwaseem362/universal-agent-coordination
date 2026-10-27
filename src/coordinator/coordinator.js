'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { CoordinationDatabase } = require('../database/db');
const {
  TASK_STATES,
  VALID_PRIORITIES,
  LifecycleError,
  assertTransition
} = require('./state-machine');
const {
  SecurityError,
  redactSecrets,
  validateAndNormalizeScope,
  hashToken,
  generateToken,
  wrapUntrustedPeerMessage
} = require('./security');
const {
  scopesOverlap,
  computeBaselineHashes
} = require('../ownership/ownership-guard');
const { evaluateCompletionGates } = require('../verification/verifier');

class CoordinatorError extends Error {
  constructor(message, code = 'COORDINATOR_ERROR', details = {}) {
    super(message);
    this.name = 'CoordinatorError';
    this.code = code;
    this.details = details;
  }
}

class CoordinatorService {
  /**
   * @param {object} options
   * @param {string} options.workspaceRoot
   * @param {string} [options.dbPath]
   * @param {number} [options.defaultLeaseTtlSeconds=900]
   * @param {number} [options.heartbeatStaleSeconds=300]
   */
  constructor(options = {}) {
    this.workspaceRoot = path.resolve(options.workspaceRoot || process.cwd());
    this.uacDir = path.join(this.workspaceRoot, '.uac');
    this.dbPath = options.dbPath
      ? path.resolve(options.dbPath)
      : path.join(this.uacDir, 'coordination.db');
    this.tokenFilePath = path.join(this.uacDir, 'workspace.token');
    this.defaultLeaseTtlSeconds = options.defaultLeaseTtlSeconds || 900;
    this.heartbeatStaleSeconds = options.heartbeatStaleSeconds || 300;
    this.db = new CoordinationDatabase(this.dbPath);
    this.sessionTokens = new Map();
  }

  async init() {
    fs.mkdirSync(this.uacDir, { recursive: true });
    if (!fs.existsSync(this.tokenFilePath)) {
      const wsToken = generateToken(24);
      fs.writeFileSync(this.tokenFilePath, wsToken + '\n', { mode: 0o600 });
    }
    await this.db.init();
    return this;
  }

  getWorkspaceToken() {
    if (!fs.existsSync(this.tokenFilePath)) {
      fs.mkdirSync(this.uacDir, { recursive: true });
      const wsToken = generateToken(24);
      fs.writeFileSync(this.tokenFilePath, wsToken + '\n', { mode: 0o600 });
    }
    return fs.readFileSync(this.tokenFilePath, 'utf8').trim();
  }

  async close() {
    await this.db.close();
  }

  _now(overrideIso) {
    return overrideIso || new Date().toISOString();
  }

  _addSeconds(isoStr, seconds) {
    const ms = new Date(isoStr).getTime() + seconds * 1000;
    return new Date(ms).toISOString();
  }

  async _logAudit(tx, eventType, agentId, taskId, details = {}, nowIso) {
    await tx.run(
      `INSERT INTO audit_log (event_type, agent_id, task_id, details_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [eventType, agentId || null, taskId || null, JSON.stringify(details), nowIso || this._now()]
    );
  }

  async _recordRejectedConflictDurable(conflictDetails, nowIso) {
    const {
      requested_scope,
      conflicting_scope,
      holder_agent_id,
      requester_agent_id,
      task_id,
      holder_task_id
    } = conflictDetails;
    await this.db.run(
      `INSERT INTO ownership_transitions
       (transition_id, scope_pattern, task_id, from_agent_id, to_agent_id, transition_type, reason, created_at)
       VALUES (?, ?, ?, ?, ?, 'CONFLICT_REJECTED', ?, ?)`,
      [
        `tr_${generateToken(8)}`,
        requested_scope,
        task_id,
        holder_agent_id,
        requester_agent_id,
        `Conflicts with active lease '${conflicting_scope}' held by '${holder_agent_id}' on task '${holder_task_id}'`,
        nowIso
      ]
    );
    await this.db.run(
      `INSERT INTO audit_log (event_type, agent_id, task_id, details_json, created_at)
       VALUES ('OWNERSHIP_CONFLICT_REJECTED', ?, ?, ?, ?)`,
      [requester_agent_id, task_id, JSON.stringify(conflictDetails), nowIso]
    );
  }

  async _reapExpiredLeasesAndStaleAgents(tx, nowIso) {
    const expiredLeases = await tx.all(
      'SELECT * FROM resource_leases WHERE expires_at <= ?',
      [nowIso]
    );
    for (const lease of expiredLeases) {
      await tx.run('DELETE FROM resource_leases WHERE lease_id = ?', [lease.lease_id]);
      await tx.run(
        `INSERT INTO ownership_transitions
         (transition_id, scope_pattern, task_id, from_agent_id, to_agent_id, transition_type, reason, created_at)
         VALUES (?, ?, ?, ?, NULL, 'LEASE_EXPIRED', 'Lease TTL expired without renewal', ?)`,
        [
          `tr_${generateToken(8)}`,
          lease.scope_pattern,
          lease.task_id,
          lease.owner_agent_id,
          nowIso
        ]
      );
      await this._logAudit(
        tx,
        'RESOURCE_LEASE_EXPIRED',
        lease.owner_agent_id,
        lease.task_id,
        { scope: lease.scope_pattern, expired_at: lease.expires_at },
        nowIso
      );
    }

    const expiredTaskClaims = await tx.all(
      `SELECT * FROM tasks
       WHERE status = 'CLAIMED' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
      [nowIso]
    );
    for (const task of expiredTaskClaims) {
      await tx.run(
        `UPDATE tasks
         SET status = 'OPEN', owner_agent_id = NULL, lease_expires_at = NULL, version = version + 1, updated_at = ?
         WHERE task_id = ?`,
        [nowIso, task.task_id]
      );
      await this._logAudit(
        tx,
        'TASK_CLAIM_LEASE_EXPIRED',
        task.owner_agent_id,
        task.task_id,
        { previous_owner: task.owner_agent_id, lease_expires_at: task.lease_expires_at },
        nowIso
      );
    }

    const staleCutoff = new Date(
      new Date(nowIso).getTime() - this.heartbeatStaleSeconds * 1000
    ).toISOString();
    await tx.run(
      `UPDATE agents SET status = 'STALE'
       WHERE status IN ('ONLINE', 'BUSY') AND last_heartbeat_at < ?`,
      [staleCutoff]
    );
  }

  async _authenticateAgent(tx, agentId, sessionToken, nowIso) {
    if (!agentId || typeof agentId !== 'string') {
      throw new SecurityError('Missing or invalid agent_id', 'UNAUTHORIZED_AGENT');
    }
    const agent = await tx.get('SELECT * FROM agents WHERE agent_id = ?', [agentId]);
    if (!agent) {
      throw new SecurityError(
        `Agent '${agentId}' is not registered with the coordinator`,
        'AGENT_NOT_REGISTERED'
      );
    }

    if (sessionToken) {
      const providedHash = hashToken(sessionToken);
      const wsTokenHash = hashToken(this.getWorkspaceToken());
      if (providedHash !== agent.session_token_hash && providedHash !== wsTokenHash) {
        throw new SecurityError(`Invalid session token for agent '${agentId}'`, 'INVALID_SESSION_TOKEN');
      }
    }

    await tx.run(
      `UPDATE agents SET last_heartbeat_at = ?, status = CASE WHEN status = 'STALE' THEN 'ONLINE' ELSE status END
       WHERE agent_id = ?`,
      [nowIso, agentId]
    );
    return agent;
  }

  async registerAgent(params = {}) {
    await this.init();
    const {
      agent_id,
      name,
      ide,
      role = 'general',
      capabilities = [],
      workspace_token,
      metadata = {},
      now
    } = params;

    if (!name || !ide) {
      throw new CoordinatorError('register_agent requires both `name` and `ide`', 'VALIDATION_ERROR');
    }

    if (workspace_token && workspace_token !== this.getWorkspaceToken()) {
      throw new SecurityError(
        'Invalid workspace_token provided during agent registration',
        'INVALID_WORKSPACE_TOKEN'
      );
    }

    const nowIso = this._now(now);
    const resolvedAgentId =
      agent_id ||
      `${ide.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

    return this.db.transaction(async (tx) => {
      await this._reapExpiredLeasesAndStaleAgents(tx, nowIso);

      const existing = await tx.get('SELECT * FROM agents WHERE agent_id = ?', [resolvedAgentId]);
      const sessionToken = this.sessionTokens.get(resolvedAgentId) || generateToken(20);
      const tokenHash = hashToken(sessionToken);

      if (existing) {
        await tx.run(
          `UPDATE agents
           SET name = ?, ide = ?, role = ?, capabilities_json = ?, workspace_root = ?,
               session_token_hash = ?, status = 'ONLINE', last_heartbeat_at = ?, metadata_json = ?
           WHERE agent_id = ?`,
          [
            name,
            ide,
            role,
            JSON.stringify(capabilities),
            this.workspaceRoot,
            tokenHash,
            nowIso,
            JSON.stringify(metadata),
            resolvedAgentId
          ]
        );
      } else {
        await tx.run(
          `INSERT INTO agents
           (agent_id, name, ide, role, capabilities_json, workspace_root, session_token_hash, status, last_heartbeat_at, registered_at, metadata_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'ONLINE', ?, ?, ?)`,
          [
            resolvedAgentId,
            name,
            ide,
            role,
            JSON.stringify(capabilities),
            this.workspaceRoot,
            tokenHash,
            nowIso,
            nowIso,
            JSON.stringify(metadata)
          ]
        );
      }

      this.sessionTokens.set(resolvedAgentId, sessionToken);
      await this._logAudit(
        tx,
        existing ? 'AGENT_REREGISTERED' : 'AGENT_REGISTERED',
        resolvedAgentId,
        null,
        { ide, role, capabilities },
        nowIso
      );

      return {
        agent_id: resolvedAgentId,
        name,
        ide,
        role,
        capabilities,
        status: 'ONLINE',
        workspace_root: this.workspaceRoot,
        session_token: sessionToken,
        registered_at: existing ? existing.registered_at : nowIso,
        last_heartbeat_at: nowIso
      };
    });
  }

  async getAgentStatus(params = {}) {
    await this.init();
    const { agent_id, include_all = true, now } = params;
    const nowIso = this._now(now);

    return this.db.transaction(async (tx) => {
      await this._reapExpiredLeasesAndStaleAgents(tx, nowIso);

      if (agent_id && !include_all) {
        const agent = await tx.get('SELECT * FROM agents WHERE agent_id = ?', [agent_id]);
        if (!agent) {
          throw new CoordinatorError(`Agent '${agent_id}' not found`, 'NOT_FOUND');
        }
        const leases = await tx.all(
          'SELECT scope_pattern, task_id, expires_at FROM resource_leases WHERE owner_agent_id = ?',
          [agent_id]
        );
        const ownedTasks = await tx.all(
          'SELECT task_id, title, status FROM tasks WHERE owner_agent_id = ?',
          [agent_id]
        );
        return {
          agent: this._formatAgentRow(agent, leases, ownedTasks)
        };
      }

      const agents = await tx.all('SELECT * FROM agents ORDER BY registered_at ASC');
      const allLeases = await tx.all(
        'SELECT scope_pattern, task_id, owner_agent_id, expires_at FROM resource_leases'
      );
      const allTasks = await tx.all(
        'SELECT task_id, title, status, owner_agent_id FROM tasks WHERE owner_agent_id IS NOT NULL'
      );

      return {
        agents: agents.map((a) =>
          this._formatAgentRow(
            a,
            allLeases.filter((l) => l.owner_agent_id === a.agent_id),
            allTasks.filter((t) => t.owner_agent_id === a.agent_id)
          )
        )
      };
    });
  }

  _formatAgentRow(row, leases = [], ownedTasks = []) {
    return {
      agent_id: row.agent_id,
      name: row.name,
      ide: row.ide,
      role: row.role,
      capabilities: JSON.parse(row.capabilities_json || '[]'),
      status: row.status,
      last_heartbeat_at: row.last_heartbeat_at,
      registered_at: row.registered_at,
      active_leases: leases,
      owned_tasks: ownedTasks
    };
  }

  async createTask(params = {}) {
    await this.init();
    const {
      task_id,
      parent_task_id = null,
      title,
      description = '',
      acceptance_criteria = [],
      priority = 'MEDIUM',
      created_by,
      session_token,
      dependencies = [],
      require_independent_review = false,
      require_test_execution = true,
      max_retries = 3,
      auto_claim = false,
      scopes = [],
      now
    } = params;

    if (!title || typeof title !== 'string' || !title.trim()) {
      throw new CoordinatorError('create_task requires a non-empty `title`', 'VALIDATION_ERROR');
    }
    if (!VALID_PRIORITIES.includes(priority)) {
      throw new CoordinatorError(
        `Invalid priority '${priority}'. Must be one of: ${VALID_PRIORITIES.join(', ')}`,
        'VALIDATION_ERROR'
      );
    }

    const nowIso = this._now(now);
    const scrubbedTitle = redactSecrets(title.trim());
    const scrubbedDesc = redactSecrets(description);
    const normalizedScopes = scopes.map((s) => validateAndNormalizeScope(s, this.workspaceRoot));

    try {
      return await this.db.transaction(async (tx) => {
        await this._reapExpiredLeasesAndStaleAgents(tx, nowIso);
        await this._authenticateAgent(tx, created_by, session_token, nowIso);

        if (parent_task_id) {
          const parent = await tx.get('SELECT task_id FROM tasks WHERE task_id = ?', [
            parent_task_id
          ]);
          if (!parent) {
            throw new CoordinatorError(
              `Parent task '${parent_task_id}' does not exist`,
              'NOT_FOUND'
            );
          }
        }

        for (const depId of dependencies) {
          const dep = await tx.get('SELECT task_id FROM tasks WHERE task_id = ?', [depId]);
          if (!dep) {
            throw new CoordinatorError(`Dependency task '${depId}' does not exist`, 'NOT_FOUND');
          }
        }

        const resolvedTaskId = task_id || `task_${generateToken(6)}`;
        const existing = await tx.get('SELECT * FROM tasks WHERE task_id = ?', [resolvedTaskId]);
        if (existing) {
          return this._hydrateTask(tx, existing);
        }

        const initialStatus = auto_claim ? TASK_STATES.CLAIMED : TASK_STATES.OPEN;
        const initialOwner = auto_claim ? created_by : null;
        const leaseExpiresAt = auto_claim
          ? this._addSeconds(nowIso, this.defaultLeaseTtlSeconds)
          : null;

        await tx.run(
          `INSERT INTO tasks (
            task_id, parent_task_id, title, description, acceptance_criteria_json,
            priority, status, created_by, owner_agent_id, claimed_scopes_json,
            retry_count, max_retries, require_independent_review, require_test_execution,
            lease_expires_at, version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 1, ?, ?)`,
          [
            resolvedTaskId,
            parent_task_id,
            scrubbedTitle.text,
            scrubbedDesc.text,
            JSON.stringify(acceptance_criteria),
            priority,
            initialStatus,
            created_by,
            initialOwner,
            JSON.stringify(normalizedScopes),
            max_retries,
            require_independent_review ? 1 : 0,
            require_test_execution ? 1 : 0,
            leaseExpiresAt,
            nowIso,
            nowIso
          ]
        );

        await tx.run(
          `INSERT OR IGNORE INTO task_participants (task_id, agent_id, role, joined_at)
           VALUES (?, ?, ?, ?)`,
          [resolvedTaskId, created_by, auto_claim ? 'owner' : 'creator', nowIso]
        );

        for (const depId of dependencies) {
          await tx.run(
            `INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id, created_at)
             VALUES (?, ?, ?)`,
            [resolvedTaskId, depId, nowIso]
          );
        }

        if (auto_claim && normalizedScopes.length > 0) {
          for (const scope of normalizedScopes) {
            await this._acquireScopeInTx(tx, {
              agentId: created_by,
              taskId: resolvedTaskId,
              scopePattern: scope,
              ttlSeconds: this.defaultLeaseTtlSeconds,
              nowIso
            });
          }
        }

        await this._logAudit(
          tx,
          'TASK_CREATED',
          created_by,
          resolvedTaskId,
          { title: scrubbedTitle.text, priority, auto_claim, parent_task_id, dependencies },
          nowIso
        );

        const createdRow = await tx.get('SELECT * FROM tasks WHERE task_id = ?', [resolvedTaskId]);
        return this._hydrateTask(tx, createdRow);
      });
    } catch (err) {
      if (err.code === 'RESOURCE_OWNERSHIP_CONFLICT' && err.details) {
        await this._recordRejectedConflictDurable(err.details, nowIso);
      }
      throw err;
    }
  }

  async listTasks(params = {}) {
    await this.init();
    const { status, owner_agent_id, parent_task_id, search, now } = params;
    const nowIso = this._now(now);

    return this.db.transaction(async (tx) => {
      await this._reapExpiredLeasesAndStaleAgents(tx, nowIso);

      const conditions = [];
      const args = [];

      if (status) {
        conditions.push('status = ?');
        args.push(status);
      }
      if (owner_agent_id) {
        conditions.push('owner_agent_id = ?');
        args.push(owner_agent_id);
      }
      if (parent_task_id !== undefined) {
        if (parent_task_id === null) {
          conditions.push('parent_task_id IS NULL');
        } else {
          conditions.push('parent_task_id = ?');
          args.push(parent_task_id);
        }
      }
      if (search && search.trim()) {
        conditions.push('(LOWER(title) LIKE ? OR LOWER(description) LIKE ?)');
        const q = `%${search.trim().toLowerCase()}%`;
        args.push(q, q);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const rows = await tx.all(`SELECT * FROM tasks ${whereClause} ORDER BY created_at ASC`, args);

      const tasks = [];
      for (const row of rows) {
        tasks.push(await this._hydrateTask(tx, row));
      }
      return { tasks };
    });
  }

  async claimTask(params = {}) {
    await this.init();
    const {
      task_id,
      agent_id,
      session_token,
      scopes = [],
      ttl_seconds,
      expected_version,
      now
    } = params;

    if (!task_id) {
      throw new CoordinatorError('claim_task requires `task_id`', 'VALIDATION_ERROR');
    }

    const nowIso = this._now(now);
    const leaseTtl = ttl_seconds || this.defaultLeaseTtlSeconds;
    const normalizedScopes = scopes.map((s) => validateAndNormalizeScope(s, this.workspaceRoot));

    try {
      return await this.db.transaction(async (tx) => {
        await this._reapExpiredLeasesAndStaleAgents(tx, nowIso);
        await this._authenticateAgent(tx, agent_id, session_token, nowIso);

        const task = await tx.get('SELECT * FROM tasks WHERE task_id = ?', [task_id]);
        if (!task) {
          throw new CoordinatorError(`Task '${task_id}' not found`, 'NOT_FOUND');
        }

        if (expected_version !== undefined && task.version !== expected_version) {
          throw new CoordinatorError(
            `Stale task version for '${task_id}': expected version ${expected_version}, actual is ${task.version}`,
            'STALE_WRITE_CONFLICT',
            { task_id, expected_version, actual_version: task.version }
          );
        }

        if (
          task.owner_agent_id === agent_id &&
          (task.status === TASK_STATES.CLAIMED || task.status === TASK_STATES.IN_PROGRESS)
        ) {
          for (const scope of normalizedScopes) {
            await this._acquireScopeInTx(tx, {
              agentId: agent_id,
              taskId: task_id,
              scopePattern: scope,
              ttlSeconds: leaseTtl,
              nowIso
            });
          }
          const updatedRow = await tx.get('SELECT * FROM tasks WHERE task_id = ?', [task_id]);
          return this._hydrateTask(tx, updatedRow);
        }

        if (
          task.owner_agent_id &&
          task.owner_agent_id !== agent_id &&
          task.status !== TASK_STATES.OPEN
        ) {
          throw new CoordinatorError(
            `Task '${task_id}' is already claimed by agent '${task.owner_agent_id}' (status: ${task.status}). Use join_task to collaborate or request_handoff to transfer ownership.`,
            'DUPLICATE_TASK_CLAIM',
            { task_id, current_owner: task.owner_agent_id, status: task.status }
          );
        }

        assertTransition(task, TASK_STATES.CLAIMED);

        for (const scope of normalizedScopes) {
          await this._acquireScopeInTx(tx, {
            agentId: agent_id,
            taskId: task_id,
            scopePattern: scope,
            ttlSeconds: leaseTtl,
            nowIso
          });
        }

        const activeLeases = await tx.all(
          'SELECT scope_pattern FROM resource_leases WHERE task_id = ? AND owner_agent_id = ?',
          [task_id, agent_id]
        );
        const mergedScopes = Array.from(
          new Set([
            ...JSON.parse(task.claimed_scopes_json || '[]'),
            ...activeLeases.map((l) => l.scope_pattern)
          ])
        );

        const leaseExpiresAt = this._addSeconds(nowIso, leaseTtl);
        const updateRes = await tx.run(
          `UPDATE tasks
           SET status = 'CLAIMED', owner_agent_id = ?, claimed_scopes_json = ?,
               lease_expires_at = ?, version = version + 1, updated_at = ?
           WHERE task_id = ? AND version = ?`,
          [agent_id, JSON.stringify(mergedScopes), leaseExpiresAt, nowIso, task_id, task.version]
        );

        if (updateRes.changes !== 1) {
          throw new CoordinatorError(
            `Concurrent modification detected while claiming task '${task_id}'`,
            'CONCURRENT_CLAIM_CONFLICT'
          );
        }

        await tx.run(
          `INSERT OR REPLACE INTO task_participants (task_id, agent_id, role, joined_at)
           VALUES (?, ?, 'owner', ?)`,
          [task_id, agent_id, nowIso]
        );

        await this._logAudit(
          tx,
          'TASK_CLAIMED',
          agent_id,
          task_id,
          { scopes: mergedScopes, lease_expires_at: leaseExpiresAt },
          nowIso
        );

        const updatedRow = await tx.get('SELECT * FROM tasks WHERE task_id = ?', [task_id]);
        return this._hydrateTask(tx, updatedRow);
      });
    } catch (err) {
      if (err.code === 'RESOURCE_OWNERSHIP_CONFLICT' && err.details) {
        await this._recordRejectedConflictDurable(err.details, nowIso);
      }
      throw err;
    }
  }

  async joinTask(params = {}) {
    await this.init();
    const {
      task_id,
      agent_id,
      session_token,
      role = 'collaborator',
      create_subtask = null,
      now
    } = params;

    if (!task_id) {
      throw new CoordinatorError('join_task requires `task_id`', 'VALIDATION_ERROR');
    }

    const nowIso = this._now(now);

    try {
      return await this.db.transaction(async (tx) => {
        await this._reapExpiredLeasesAndStaleAgents(tx, nowIso);
        await this._authenticateAgent(tx, agent_id, session_token, nowIso);

        const parentTask = await tx.get('SELECT * FROM tasks WHERE task_id = ?', [task_id]);
        if (!parentTask) {
          throw new CoordinatorError(`Task '${task_id}' not found`, 'NOT_FOUND');
        }

        await tx.run(
          `INSERT OR IGNORE INTO task_participants (task_id, agent_id, role, joined_at)
           VALUES (?, ?, ?, ?)`,
          [task_id, agent_id, role, nowIso]
        );

        let createdSubtask = null;
        if (create_subtask && typeof create_subtask === 'object' && create_subtask.title) {
          const subId = create_subtask.task_id || `task_${generateToken(6)}`;
          const subTitle = redactSecrets(create_subtask.title.trim()).text;
          const subDesc = redactSecrets(create_subtask.description || '').text;
          const subScopes = (create_subtask.scopes || []).map((s) =>
            validateAndNormalizeScope(s, this.workspaceRoot)
          );
          const subAutoClaim = create_subtask.auto_claim !== false;
          const subStatus = subAutoClaim ? TASK_STATES.CLAIMED : TASK_STATES.OPEN;
          const subOwner = subAutoClaim ? agent_id : null;
          const subLease = subAutoClaim
            ? this._addSeconds(nowIso, this.defaultLeaseTtlSeconds)
            : null;

          await tx.run(
            `INSERT INTO tasks (
              task_id, parent_task_id, title, description, acceptance_criteria_json,
              priority, status, created_by, owner_agent_id, claimed_scopes_json,
              retry_count, max_retries, require_independent_review, require_test_execution,
              lease_expires_at, version, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 3, ?, ?, ?, 1, ?, ?)`,
            [
              subId,
              task_id,
              subTitle,
              subDesc,
              JSON.stringify(create_subtask.acceptance_criteria || []),
              create_subtask.priority || parentTask.priority,
              subStatus,
              agent_id,
              subOwner,
              JSON.stringify(subScopes),
              create_subtask.require_independent_review ? 1 : 0,
              create_subtask.require_test_execution !== false ? 1 : 0,
              subLease,
              nowIso,
              nowIso
            ]
          );

          await tx.run(
            `INSERT OR REPLACE INTO task_participants (task_id, agent_id, role, joined_at)
             VALUES (?, ?, 'owner', ?)`,
            [subId, agent_id, nowIso]
          );

          if (subAutoClaim && subScopes.length > 0) {
            for (const scope of subScopes) {
              await this._acquireScopeInTx(tx, {
                agentId: agent_id,
                taskId: subId,
                scopePattern: scope,
                ttlSeconds: this.defaultLeaseTtlSeconds,
                nowIso
              });
            }
          }

          const subRow = await tx.get('SELECT * FROM tasks WHERE task_id = ?', [subId]);
          createdSubtask = await this._hydrateTask(tx, subRow);
        }

        await this._logAudit(
          tx,
          'TASK_JOINED',
          agent_id,
          task_id,
          { role, subtask_created: createdSubtask ? createdSubtask.task_id : null },
          nowIso
        );

        const hydratedParent = await this._hydrateTask(tx, parentTask);
        const recentMessages = await tx.all(
          `SELECT * FROM messages WHERE task_id = ? ORDER BY created_at ASC`,
          [task_id]
        );
        const decisions = await tx.all(
          `SELECT * FROM decisions WHERE task_id = ? AND status = 'ACTIVE' ORDER BY created_at ASC`,
          [task_id]
        );

        return {
          joined_task: hydratedParent,
          subtask: createdSubtask,
          messages: recentMessages.map(wrapUntrustedPeerMessage),
          decisions
        };
      });
    } catch (err) {
      if (err.code === 'RESOURCE_OWNERSHIP_CONFLICT' && err.details) {
        await this._recordRejectedConflictDurable(err.details, nowIso);
      }
      throw err;
    }
  }

  async updateTaskStatus(params = {}) {
    await this.init();
    const {
      task_id,
      agent_id,
      session_token,
      status,
      progress_note,
      blocker_reason = null,
      expected_version,
      now
    } = params;

    if (!task_id || !status) {
      throw new CoordinatorError(
        'update_task_status requires `task_id` and `status`',
        'VALIDATION_ERROR'
      );
    }

    const nowIso = this._now(now);

    return this.db.transaction(async (tx) => {
      await this._reapExpiredLeasesAndStaleAgents(tx, nowIso);
      await this._authenticateAgent(tx, agent_id, session_token, nowIso);

      const task = await tx.get('SELECT * FROM tasks WHERE task_id = ?', [task_id]);
      if (!task) {
        throw new CoordinatorError(`Task '${task_id}' not found`, 'NOT_FOUND');
      }

      if (expected_version !== undefined && task.version !== expected_version) {
        throw new CoordinatorError(
          `Stale task version for '${task_id}': expected ${expected_version}, got ${task.version}`,
          'STALE_WRITE_CONFLICT',
          { task_id, expected_version, actual_version: task.version }
        );
      }

      const participant = await tx.get(
        'SELECT * FROM task_participants WHERE task_id = ? AND agent_id = ?',
        [task_id, agent_id]
      );
      if (task.owner_agent_id && task.owner_agent_id !== agent_id && !participant) {
        throw new SecurityError(
          `Agent '${agent_id}' is neither the owner nor a participant of task '${task_id}'`,
          'UNAUTHORIZED_TASK_UPDATE'
        );
      }

      if (status === TASK_STATES.IN_PROGRESS) {
        const unmetDeps = await tx.all(
          `SELECT d.depends_on_task_id, t.status
           FROM task_dependencies d
           JOIN tasks t ON t.task_id = d.depends_on_task_id
           WHERE d.task_id = ? AND t.status != 'DONE'`,
          [task_id]
        );
        if (unmetDeps.length > 0) {
          throw new CoordinatorError(
            `Cannot start task '${task_id}' because dependencies are not DONE: ${unmetDeps
              .map((d) => `${d.depends_on_task_id} (${d.status})`)
              .join(', ')}`,
            'UNMET_DEPENDENCIES',
            { unmet_dependencies: unmetDeps }
          );
        }
      }

      assertTransition(task, status);

      let newRetryCount = task.retry_count;
      if (status === TASK_STATES.FAILED && task.status !== TASK_STATES.FAILED) {
        newRetryCount += 1;
      }

      const scrubbedBlocker = blocker_reason ? redactSecrets(blocker_reason).text : null;
      const newOwner = status === TASK_STATES.OPEN ? null : task.owner_agent_id || agent_id;
      const leaseExpiresAt =
        status === TASK_STATES.OPEN || status === TASK_STATES.CANCELLED
          ? null
          : this._addSeconds(nowIso, this.defaultLeaseTtlSeconds);

      const res = await tx.run(
        `UPDATE tasks
         SET status = ?, owner_agent_id = ?, retry_count = ?, blocker_reason = ?,
             lease_expires_at = ?, version = version + 1, updated_at = ?
         WHERE task_id = ? AND version = ?`,
        [
          status,
          newOwner,
          newRetryCount,
          status === TASK_STATES.BLOCKED ? scrubbedBlocker || 'Blocked' : null,
          leaseExpiresAt,
          nowIso,
          task_id,
          task.version
        ]
      );

      if (res.changes !== 1) {
        throw new CoordinatorError(
          `Concurrent update conflict on task '${task_id}'`,
          'STALE_WRITE_CONFLICT'
        );
      }

      if (status === TASK_STATES.OPEN || status === TASK_STATES.CANCELLED) {
        await tx.run('DELETE FROM resource_leases WHERE task_id = ? AND owner_agent_id = ?', [
          task_id,
          agent_id
        ]);
      }

      if (progress_note && progress_note.trim()) {
        const scrubbedNote = redactSecrets(progress_note.trim());
        await tx.run(
          `INSERT INTO messages (
            message_id, task_id, sender_agent_id, recipient_agent_id,
            message_type, content, redacted, created_at
          ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
          [
            `msg_${generateToken(6)}`,
            task_id,
            agent_id,
            status === TASK_STATES.BLOCKED ? 'BLOCKER' : 'STATUS_UPDATE',
            scrubbedNote.text,
            scrubbedNote.redacted ? 1 : 0,
            nowIso
          ]
        );
      }

      await this._logAudit(
        tx,
        'TASK_STATUS_UPDATED',
        agent_id,
        task_id,
        { from_status: task.status, to_status: status, retry_count: newRetryCount },
        nowIso
      );

      const updated = await tx.get('SELECT * FROM tasks WHERE task_id = ?', [task_id]);
      return this._hydrateTask(tx, updated);
    });
  }

  async postMessage(params = {}) {
    await this.init();
    const {
      task_id = null,
      sender_agent_id,
      session_token,
      recipient_agent_id = null,
      message_type = 'FINDING',
      reply_to_message_id = null,
      content,
      now
    } = params;

    if (!content || typeof content !== 'string' || !content.trim()) {
      throw new CoordinatorError('post_message requires non-empty `content`', 'VALIDATION_ERROR');
    }

    const validTypes = [
      'QUESTION',
      'ANSWER',
      'FINDING',
      'PLAN',
      'BLOCKER',
      'HANDOFF',
      'REVIEW',
      'STATUS_UPDATE'
    ];
    if (!validTypes.includes(message_type)) {
      throw new CoordinatorError(
        `Invalid message_type '${message_type}'. Must be one of: ${validTypes.join(', ')}`,
        'VALIDATION_ERROR'
      );
    }

    const nowIso = this._now(now);
    const scrubbed = redactSecrets(content.trim());

    return this.db.transaction(async (tx) => {
      await this._reapExpiredLeasesAndStaleAgents(tx, nowIso);
      await this._authenticateAgent(tx, sender_agent_id, session_token, nowIso);

      if (task_id) {
        const task = await tx.get('SELECT task_id FROM tasks WHERE task_id = ?', [task_id]);
        if (!task) {
          throw new CoordinatorError(`Task '${task_id}' not found`, 'NOT_FOUND');
        }
      }

      const msgId = `msg_${generateToken(6)}`;
      await tx.run(
        `INSERT INTO messages (
          message_id, task_id, sender_agent_id, recipient_agent_id,
          message_type, reply_to_message_id, content, redacted, acknowledged, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        [
          msgId,
          task_id,
          sender_agent_id,
          recipient_agent_id,
          message_type,
          reply_to_message_id,
          scrubbed.text,
          scrubbed.redacted ? 1 : 0,
          nowIso
        ]
      );

      if (reply_to_message_id) {
        await tx.run('UPDATE messages SET acknowledged = 1 WHERE message_id = ?', [
          reply_to_message_id
        ]);
      }

      await this._logAudit(
        tx,
        'MESSAGE_POSTED',
        sender_agent_id,
        task_id,
        { message_id: msgId, message_type, recipient_agent_id, redacted: scrubbed.redacted },
        nowIso
      );

      const row = await tx.get('SELECT * FROM messages WHERE message_id = ?', [msgId]);
      return wrapUntrustedPeerMessage(row);
    });
  }

  async readMessages(params = {}) {
    await this.init();
    const { task_id, recipient_agent_id, message_type, since, limit = 100, now } = params;
    const nowIso = this._now(now);

    return this.db.transaction(async (tx) => {
      await this._reapExpiredLeasesAndStaleAgents(tx, nowIso);

      const conditions = [];
      const args = [];

      if (task_id) {
        conditions.push('task_id = ?');
        args.push(task_id);
      }
      if (recipient_agent_id) {
        conditions.push('(recipient_agent_id = ? OR recipient_agent_id IS NULL)');
        args.push(recipient_agent_id);
      }
      if (message_type) {
        conditions.push('message_type = ?');
        args.push(message_type);
      }
      if (since) {
        conditions.push('created_at >= ?');
        args.push(since);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const rows = await tx.all(
        `SELECT * FROM messages ${whereClause} ORDER BY created_at ASC LIMIT ?`,
        [...args, Number(limit) || 100]
      );

      return {
        messages: rows.map(wrapUntrustedPeerMessage)
      };
    });
  }

  async askAgent(params = {}) {
    const {
      task_id,
      sender_agent_id,
      session_token,
      recipient_agent_id = null,
      question,
      now
    } = params;

    if (!question || typeof question !== 'string' || !question.trim()) {
      throw new CoordinatorError('ask_agent requires a non-empty `question`', 'VALIDATION_ERROR');
    }

    return this.postMessage({
      task_id,
      sender_agent_id,
      session_token,
      recipient_agent_id,
      message_type: 'QUESTION',
      content: question,
      now
    });
  }

  async recordDecision(params = {}) {
    await this.init();
    const {
      task_id = null,
      author_agent_id,
      session_token,
      topic,
      decision,
      rationale = '',
      supersedes_decision_id = null,
      now
    } = params;

    if (!topic || !decision) {
      throw new CoordinatorError(
        'record_decision requires `topic` and `decision`',
        'VALIDATION_ERROR'
      );
    }

    const nowIso = this._now(now);
    const scrubbedTopic = redactSecrets(topic.trim());
    const scrubbedDecision = redactSecrets(decision.trim());
    const scrubbedRationale = redactSecrets(rationale.trim());

    return this.db.transaction(async (tx) => {
      await this._reapExpiredLeasesAndStaleAgents(tx, nowIso);
      await this._authenticateAgent(tx, author_agent_id, session_token, nowIso);

      if (supersedes_decision_id) {
        const oldDec = await tx.get('SELECT * FROM decisions WHERE decision_id = ?', [
          supersedes_decision_id
        ]);
        if (!oldDec) {
          throw new CoordinatorError(
            `Superseded decision '${supersedes_decision_id}' does not exist`,
            'NOT_FOUND'
          );
        }
        await tx.run(`UPDATE decisions SET status = 'SUPERSEDED' WHERE decision_id = ?`, [
          supersedes_decision_id
        ]);
      }

      const decisionId = `dec_${generateToken(6)}`;
      await tx.run(
        `INSERT INTO decisions (
          decision_id, task_id, author_agent_id, topic, decision, rationale,
          supersedes_decision_id, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
        [
          decisionId,
          task_id,
          author_agent_id,
          scrubbedTopic.text,
          scrubbedDecision.text,
          scrubbedRationale.text,
          supersedes_decision_id,
          nowIso
        ]
      );

      await this._logAudit(
        tx,
        'DECISION_RECORDED',
        author_agent_id,
        task_id,
        { decision_id: decisionId, topic: scrubbedTopic.text, supersedes_decision_id },
        nowIso
      );

      return tx.get('SELECT * FROM decisions WHERE decision_id = ?', [decisionId]);
    });
  }

  async requestHandoff(params = {}) {
    await this.init();
    const {
      task_id,
      from_agent_id,
      to_agent_id,
      session_token,
      scopes = [],
      summary,
      auto_accept = true,
      now
    } = params;

    if (!task_id || !from_agent_id || !summary) {
      throw new CoordinatorError(
        'request_handoff requires `task_id`, `from_agent_id`, and `summary`',
        'VALIDATION_ERROR'
      );
    }

    const nowIso = this._now(now);
    const normalizedScopes = scopes.map((s) => validateAndNormalizeScope(s, this.workspaceRoot));
    const scrubbedSummary = redactSecrets(summary.trim());

    return this.db.transaction(async (tx) => {
      await this._reapExpiredLeasesAndStaleAgents(tx, nowIso);
      await this._authenticateAgent(tx, from_agent_id, session_token, nowIso);

      const task = await tx.get('SELECT * FROM tasks WHERE task_id = ?', [task_id]);
      if (!task) {
        throw new CoordinatorError(`Task '${task_id}' not found`, 'NOT_FOUND');
      }

      if (task.owner_agent_id !== from_agent_id) {
        throw new SecurityError(
          `Only current task owner ('${task.owner_agent_id}') can initiate handoff for task '${task_id}'`,
          'UNAUTHORIZED_HANDOFF'
        );
      }

      if (to_agent_id) {
        const targetAgent = await tx.get('SELECT * FROM agents WHERE agent_id = ?', [to_agent_id]);
        if (!targetAgent) {
          throw new CoordinatorError(`Target agent '${to_agent_id}' is not registered`, 'NOT_FOUND');
        }
      }

      const handoffId = `ho_${generateToken(6)}`;
      const finalStatus = auto_accept && to_agent_id ? 'ACCEPTED' : 'PENDING';
      const resolvedAt = finalStatus === 'ACCEPTED' ? nowIso : null;

      await tx.run(
        `INSERT INTO handoff_requests (
          handoff_id, task_id, from_agent_id, to_agent_id, scopes_json, summary, status, created_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          handoffId,
          task_id,
          from_agent_id,
          to_agent_id || null,
          JSON.stringify(normalizedScopes),
          scrubbedSummary.text,
          finalStatus,
          nowIso,
          resolvedAt
        ]
      );

      await tx.run(
        `INSERT INTO messages (
          message_id, task_id, sender_agent_id, recipient_agent_id, message_type, content, redacted, created_at
        ) VALUES (?, ?, ?, ?, 'HANDOFF', ?, ?, ?)`,
        [
          `msg_${generateToken(6)}`,
          task_id,
          from_agent_id,
          to_agent_id || null,
          scrubbedSummary.text,
          scrubbedSummary.redacted ? 1 : 0,
          nowIso
        ]
      );

      if (finalStatus === 'ACCEPTED' && to_agent_id) {
        const newExpiry = this._addSeconds(nowIso, this.defaultLeaseTtlSeconds);
        await tx.run(
          `UPDATE tasks SET owner_agent_id = ?, lease_expires_at = ?, version = version + 1, updated_at = ?
           WHERE task_id = ?`,
          [to_agent_id, newExpiry, nowIso, task_id]
        );

        await tx.run(
          `INSERT OR REPLACE INTO task_participants (task_id, agent_id, role, joined_at)
           VALUES (?, ?, 'owner', ?)`,
          [task_id, to_agent_id, nowIso]
        );

        const taskLeases = await tx.all(
          'SELECT * FROM resource_leases WHERE task_id = ? AND owner_agent_id = ?',
          [task_id, from_agent_id]
        );
        for (const lease of taskLeases) {
          if (normalizedScopes.length === 0 || normalizedScopes.includes(lease.scope_pattern)) {
            await tx.run(
              `UPDATE resource_leases
               SET owner_agent_id = ?, expires_at = ?, renewed_count = renewed_count + 1
               WHERE lease_id = ?`,
              [to_agent_id, newExpiry, lease.lease_id]
            );
            await tx.run(
              `INSERT INTO ownership_transitions
               (transition_id, scope_pattern, task_id, from_agent_id, to_agent_id, transition_type, reason, created_at)
               VALUES (?, ?, ?, ?, ?, 'HANDOFF_ACCEPTED', ?, ?)`,
              [
                `tr_${generateToken(8)}`,
                lease.scope_pattern,
                task_id,
                from_agent_id,
                to_agent_id,
                scrubbedSummary.text,
                nowIso
              ]
            );
          }
        }
      } else {
        for (const scope of normalizedScopes) {
          await tx.run(
            `INSERT INTO ownership_transitions
             (transition_id, scope_pattern, task_id, from_agent_id, to_agent_id, transition_type, reason, created_at)
             VALUES (?, ?, ?, ?, ?, 'HANDOFF_REQUESTED', ?, ?)`,
            [
              `tr_${generateToken(8)}`,
              scope,
              task_id,
              from_agent_id,
              to_agent_id || null,
              scrubbedSummary.text,
              nowIso
            ]
          );
        }
      }

      await this._logAudit(
        tx,
        'HANDOFF_REQUESTED',
        from_agent_id,
        task_id,
        { handoff_id: handoffId, to_agent_id, status: finalStatus, scopes: normalizedScopes },
        nowIso
      );

      return tx.get('SELECT * FROM handoff_requests WHERE handoff_id = ?', [handoffId]);
    });
  }

  async claimResource(params = {}) {
    await this.init();
    const {
      agent_id,
      session_token,
      task_id,
      scope,
      mode = 'EXCLUSIVE',
      ttl_seconds,
      now
    } = params;

    if (!task_id || !scope) {
      throw new CoordinatorError('claim_resource requires `task_id` and `scope`', 'VALIDATION_ERROR');
    }

    const normalizedScope = validateAndNormalizeScope(scope, this.workspaceRoot);
    const nowIso = this._now(now);
    const ttl = ttl_seconds || this.defaultLeaseTtlSeconds;

    try {
      return await this.db.transaction(async (tx) => {
        await this._reapExpiredLeasesAndStaleAgents(tx, nowIso);
        await this._authenticateAgent(tx, agent_id, session_token, nowIso);

        const task = await tx.get('SELECT * FROM tasks WHERE task_id = ?', [task_id]);
        if (!task) {
          throw new CoordinatorError(`Task '${task_id}' not found`, 'NOT_FOUND');
        }

        const lease = await this._acquireScopeInTx(tx, {
          agentId: agent_id,
          taskId: task_id,
          scopePattern: normalizedScope,
          mode,
          ttlSeconds: ttl,
          nowIso
        });

        const currentScopes = JSON.parse(task.claimed_scopes_json || '[]');
        if (!currentScopes.includes(normalizedScope)) {
          currentScopes.push(normalizedScope);
          await tx.run(
            'UPDATE tasks SET claimed_scopes_json = ?, updated_at = ? WHERE task_id = ?',
            [JSON.stringify(currentScopes), nowIso, task_id]
          );
        }

        return lease;
      });
    } catch (err) {
      if (err.code === 'RESOURCE_OWNERSHIP_CONFLICT' && err.details) {
        await this._recordRejectedConflictDurable(err.details, nowIso);
      }
      throw err;
    }
  }

  async _acquireScopeInTx(tx, { agentId, taskId, scopePattern, mode = 'EXCLUSIVE', ttlSeconds, nowIso }) {
    const activeLeases = await tx.all('SELECT * FROM resource_leases WHERE expires_at > ?', [
      nowIso
    ]);

    for (const existing of activeLeases) {
      if (scopesOverlap(scopePattern, existing.scope_pattern)) {
        if (existing.owner_agent_id === agentId && existing.scope_pattern === scopePattern) {
          const newExpiresAt = this._addSeconds(nowIso, ttlSeconds);
          await tx.run(
            `UPDATE resource_leases
             SET task_id = ?, expires_at = ?, renewed_count = renewed_count + 1
             WHERE lease_id = ?`,
            [taskId, newExpiresAt, existing.lease_id]
          );
          return tx.get('SELECT * FROM resource_leases WHERE lease_id = ?', [existing.lease_id]);
        }

        if (
          existing.owner_agent_id !== agentId ||
          existing.mode === 'EXCLUSIVE' ||
          mode === 'EXCLUSIVE'
        ) {
          throw new CoordinatorError(
            `Ownership conflict: Scope '${scopePattern}' overlaps with active lease '${existing.scope_pattern}' held by agent '${existing.owner_agent_id}' (task '${existing.task_id}', expires ${existing.expires_at}).`,
            'RESOURCE_OWNERSHIP_CONFLICT',
            {
              requested_scope: scopePattern,
              conflicting_scope: existing.scope_pattern,
              holder_agent_id: existing.owner_agent_id,
              requester_agent_id: agentId,
              task_id: taskId,
              holder_task_id: existing.task_id,
              expires_at: existing.expires_at
            }
          );
        }
      }
    }

    const leaseId = `lease_${generateToken(6)}`;
    const expiresAt = this._addSeconds(nowIso, ttlSeconds);
    const baselineHashes = computeBaselineHashes(scopePattern, this.workspaceRoot);

    await tx.run(
      `INSERT INTO resource_leases
       (lease_id, scope_pattern, task_id, owner_agent_id, mode, baseline_hashes_json, acquired_at, expires_at, renewed_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [
        leaseId,
        scopePattern,
        taskId,
        agentId,
        mode,
        JSON.stringify(baselineHashes),
        nowIso,
        expiresAt
      ]
    );

    await tx.run(
      `INSERT INTO ownership_transitions
       (transition_id, scope_pattern, task_id, from_agent_id, to_agent_id, transition_type, reason, created_at)
       VALUES (?, ?, ?, NULL, ?, 'CLAIMED', 'Resource scope claimed', ?)`,
      [`tr_${generateToken(8)}`, scopePattern, taskId, agentId, nowIso]
    );

    await this._logAudit(
      tx,
      'RESOURCE_CLAIMED',
      agentId,
      taskId,
      { lease_id: leaseId, scope: scopePattern, expires_at: expiresAt },
      nowIso
    );

    return tx.get('SELECT * FROM resource_leases WHERE lease_id = ?', [leaseId]);
  }

  async releaseResource(params = {}) {
    await this.init();
    const { agent_id, session_token, task_id, scope, now } = params;
    if (!scope) {
      throw new CoordinatorError('release_resource requires `scope`', 'VALIDATION_ERROR');
    }

    const normalizedScope = validateAndNormalizeScope(scope, this.workspaceRoot);
    const nowIso = this._now(now);

    return this.db.transaction(async (tx) => {
      await this._reapExpiredLeasesAndStaleAgents(tx, nowIso);
      await this._authenticateAgent(tx, agent_id, session_token, nowIso);

      const lease = await tx.get('SELECT * FROM resource_leases WHERE scope_pattern = ?', [
        normalizedScope
      ]);
      if (!lease) {
        return { released: false, scope: normalizedScope, reason: 'No active lease found' };
      }
      if (lease.owner_agent_id !== agent_id) {
        throw new SecurityError(
          `Agent '${agent_id}' cannot release scope '${normalizedScope}' owned by '${lease.owner_agent_id}'`,
          'UNAUTHORIZED_LEASE_RELEASE'
        );
      }

      await tx.run('DELETE FROM resource_leases WHERE lease_id = ?', [lease.lease_id]);
      await tx.run(
        `INSERT INTO ownership_transitions
         (transition_id, scope_pattern, task_id, from_agent_id, to_agent_id, transition_type, reason, created_at)
         VALUES (?, ?, ?, ?, NULL, 'RELEASED', 'Explicitly released by owner', ?)`,
        [`tr_${generateToken(8)}`, normalizedScope, task_id || lease.task_id, agent_id, nowIso]
      );

      await this._logAudit(
        tx,
        'RESOURCE_RELEASED',
        agent_id,
        task_id || lease.task_id,
        { scope: normalizedScope },
        nowIso
      );

      return { released: true, scope: normalizedScope, lease_id: lease.lease_id };
    });
  }

  async reportTestResults(params = {}) {
    await this.init();
    const {
      task_id,
      agent_id,
      session_token,
      command,
      exit_code = 0,
      passed,
      passed_count = 0,
      failed_count = 0,
      output_summary = '',
      artifact_hashes = {},
      now
    } = params;

    if (!task_id || !command) {
      throw new CoordinatorError(
        'report_test_results requires `task_id` and `command`',
        'VALIDATION_ERROR'
      );
    }

    const isPassed =
      passed !== undefined ? Boolean(passed) : exit_code === 0 && Number(failed_count) === 0;
    const nowIso = this._now(now);
    const scrubbedOutput = redactSecrets(output_summary);

    return this.db.transaction(async (tx) => {
      await this._reapExpiredLeasesAndStaleAgents(tx, nowIso);
      await this._authenticateAgent(tx, agent_id, session_token, nowIso);

      const task = await tx.get('SELECT * FROM tasks WHERE task_id = ?', [task_id]);
      if (!task) {
        throw new CoordinatorError(`Task '${task_id}' not found`, 'NOT_FOUND');
      }

      const evidenceId = `ev_${generateToken(6)}`;
      await tx.run(
        `INSERT INTO verification_evidence (
          evidence_id, task_id, agent_id, evidence_type, command, exit_code,
          passed, passed_count, failed_count, output_summary, artifact_hashes_json, created_at
        ) VALUES (?, ?, ?, 'TEST_RESULT', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          evidenceId,
          task_id,
          agent_id,
          command,
          Number(exit_code),
          isPassed ? 1 : 0,
          Number(passed_count),
          Number(failed_count),
          scrubbedOutput.text,
          JSON.stringify(artifact_hashes),
          nowIso
        ]
      );

      await this._logAudit(
        tx,
        'TEST_RESULTS_REPORTED',
        agent_id,
        task_id,
        {
          evidence_id: evidenceId,
          command,
          exit_code,
          passed: isPassed,
          passed_count,
          failed_count
        },
        nowIso
      );

      return tx.get('SELECT * FROM verification_evidence WHERE evidence_id = ?', [evidenceId]);
    });
  }

  async submitReview(params = {}) {
    await this.init();
    const {
      task_id,
      reviewer_agent_id,
      session_token,
      approved,
      findings_summary,
      now
    } = params;

    if (!task_id || !reviewer_agent_id || approved === undefined || !findings_summary) {
      throw new CoordinatorError(
        'submit_review requires `task_id`, `reviewer_agent_id`, `approved`, and `findings_summary`',
        'VALIDATION_ERROR'
      );
    }

    const nowIso = this._now(now);
    const scrubbedFindings = redactSecrets(findings_summary.trim());

    return this.db.transaction(async (tx) => {
      await this._reapExpiredLeasesAndStaleAgents(tx, nowIso);
      await this._authenticateAgent(tx, reviewer_agent_id, session_token, nowIso);

      const task = await tx.get('SELECT * FROM tasks WHERE task_id = ?', [task_id]);
      if (!task) {
        throw new CoordinatorError(`Task '${task_id}' not found`, 'NOT_FOUND');
      }

      if (task.require_independent_review === 1 && task.owner_agent_id === reviewer_agent_id) {
        throw new SecurityError(
          `Independent review violation: Task owner '${reviewer_agent_id}' cannot self-review task '${task_id}'`,
          'SELF_REVIEW_FORBIDDEN'
        );
      }

      const evidenceId = `ev_${generateToken(6)}`;
      await tx.run(
        `INSERT INTO verification_evidence (
          evidence_id, task_id, agent_id, evidence_type, command, exit_code,
          passed, passed_count, failed_count, output_summary, artifact_hashes_json, created_at
        ) VALUES (?, ?, ?, 'INDEPENDENT_REVIEW', 'independent_review', ?, ?, ?, ?, ?, '{}', ?)`,
        [
          evidenceId,
          task_id,
          reviewer_agent_id,
          approved ? 0 : 1,
          approved ? 1 : 0,
          approved ? 1 : 0,
          approved ? 0 : 1,
          scrubbedFindings.text,
          nowIso
        ]
      );

      await tx.run(
        `INSERT INTO messages (
          message_id, task_id, sender_agent_id, recipient_agent_id,
          message_type, content, redacted, created_at
        ) VALUES (?, ?, ?, ?, 'REVIEW', ?, ?, ?)`,
        [
          `msg_${generateToken(6)}`,
          task_id,
          reviewer_agent_id,
          task.owner_agent_id,
          scrubbedFindings.text,
          scrubbedFindings.redacted ? 1 : 0,
          nowIso
        ]
      );

      await this._logAudit(
        tx,
        'INDEPENDENT_REVIEW_SUBMITTED',
        reviewer_agent_id,
        task_id,
        { evidence_id: evidenceId, approved: Boolean(approved) },
        nowIso
      );

      return tx.get('SELECT * FROM verification_evidence WHERE evidence_id = ?', [evidenceId]);
    });
  }

  async verifyCompletion(params = {}) {
    await this.init();
    const { task_id, agent_id, session_token, now } = params;

    if (!task_id) {
      throw new CoordinatorError('verify_completion requires `task_id`', 'VALIDATION_ERROR');
    }

    const nowIso = this._now(now);

    return this.db.transaction(async (tx) => {
      await this._reapExpiredLeasesAndStaleAgents(tx, nowIso);
      await this._authenticateAgent(tx, agent_id, session_token, nowIso);

      const task = await tx.get('SELECT * FROM tasks WHERE task_id = ?', [task_id]);
      if (!task) {
        throw new CoordinatorError(`Task '${task_id}' not found`, 'NOT_FOUND');
      }

      if (task.status === TASK_STATES.DONE) {
        const evaluation = await evaluateCompletionGates(tx, task_id);
        return {
          completed: true,
          task: await this._hydrateTask(tx, task),
          gate_evaluation: evaluation
        };
      }

      if (task.status === TASK_STATES.IN_PROGRESS || task.status === TASK_STATES.REVIEW) {
        assertTransition(task, TASK_STATES.VERIFYING);
        await tx.run(
          `UPDATE tasks SET status = 'VERIFYING', version = version + 1, updated_at = ? WHERE task_id = ?`,
          [nowIso, task_id]
        );
      }

      const evaluation = await evaluateCompletionGates(tx, task_id);
      if (!evaluation.passed) {
        await this._logAudit(
          tx,
          'COMPLETION_GATE_REJECTED',
          agent_id,
          task_id,
          { reasons: evaluation.reasons, summary: evaluation.summary },
          nowIso
        );
        const currentTask = await tx.get('SELECT * FROM tasks WHERE task_id = ?', [task_id]);
        return {
          completed: false,
          task: await this._hydrateTask(tx, currentTask),
          gate_evaluation: evaluation
        };
      }

      const refreshedTask = await tx.get('SELECT * FROM tasks WHERE task_id = ?', [task_id]);
      assertTransition(refreshedTask, TASK_STATES.DONE, { verifiedByGate: true });

      await tx.run(
        `UPDATE tasks
         SET status = 'DONE', lease_expires_at = NULL, completed_at = ?, version = version + 1, updated_at = ?
         WHERE task_id = ?`,
        [nowIso, nowIso, task_id]
      );

      const heldLeases = await tx.all('SELECT * FROM resource_leases WHERE task_id = ?', [task_id]);
      for (const lease of heldLeases) {
        await tx.run('DELETE FROM resource_leases WHERE lease_id = ?', [lease.lease_id]);
        await tx.run(
          `INSERT INTO ownership_transitions
           (transition_id, scope_pattern, task_id, from_agent_id, to_agent_id, transition_type, reason, created_at)
           VALUES (?, ?, ?, ?, NULL, 'RELEASED', 'Task completed and verified', ?)`,
          [`tr_${generateToken(8)}`, lease.scope_pattern, task_id, lease.owner_agent_id, nowIso]
        );
      }

      await this._logAudit(
        tx,
        'TASK_COMPLETED',
        agent_id,
        task_id,
        { summary: evaluation.summary },
        nowIso
      );

      const finalRow = await tx.get('SELECT * FROM tasks WHERE task_id = ?', [task_id]);
      return {
        completed: true,
        task: await this._hydrateTask(tx, finalRow),
        gate_evaluation: evaluation
      };
    });
  }

  async generateConsolidatedReport(taskId) {
    await this.init();
    return this.db.transaction(async (tx) => {
      const task = await tx.get('SELECT * FROM tasks WHERE task_id = ?', [taskId]);
      if (!task) {
        throw new CoordinatorError(`Task '${taskId}' not found`, 'NOT_FOUND');
      }

      const hydratedTask = await this._hydrateTask(tx, task);
      const subtasks = await tx.all(
        'SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY created_at ASC',
        [taskId]
      );
      const hydratedSubtasks = [];
      for (const st of subtasks) {
        hydratedSubtasks.push(await this._hydrateTask(tx, st));
      }

      const relevantIds = [taskId, ...subtasks.map((s) => s.task_id)];
      const placeholders = relevantIds.map(() => '?').join(',');

      const participants = await tx.all(
        `SELECT DISTINCT p.agent_id, p.role, a.name, a.ide, a.status
         FROM task_participants p
         JOIN agents a ON a.agent_id = p.agent_id
         WHERE p.task_id IN (${placeholders})`,
        relevantIds
      );

      const evidence = await tx.all(
        `SELECT * FROM verification_evidence WHERE task_id IN (${placeholders}) ORDER BY created_at ASC`,
        relevantIds
      );

      const decisions = await tx.all(
        `SELECT * FROM decisions WHERE task_id IN (${placeholders}) ORDER BY created_at ASC`,
        relevantIds
      );

      const transitions = await tx.all(
        `SELECT * FROM ownership_transitions WHERE task_id IN (${placeholders}) ORDER BY created_at ASC`,
        relevantIds
      );

      const messages = await tx.all(
        `SELECT * FROM messages WHERE task_id IN (${placeholders}) ORDER BY created_at ASC`,
        relevantIds
      );

      const gateEvaluation = await evaluateCompletionGates(tx, taskId);

      return {
        generated_at: new Date().toISOString(),
        task: hydratedTask,
        subtasks: hydratedSubtasks,
        contributing_agents: participants,
        decisions,
        test_executions: evidence.filter((e) => e.evidence_type === 'TEST_RESULT'),
        independent_reviews: evidence.filter((e) => e.evidence_type === 'INDEPENDENT_REVIEW'),
        ownership_transitions: transitions,
        conflicts_prevented: transitions.filter((t) => t.transition_type === 'CONFLICT_REJECTED'),
        messages_exchanged: messages.length,
        outstanding_blockers: [
          ...(hydratedTask.blocker_reason ? [hydratedTask.blocker_reason] : []),
          ...hydratedSubtasks
            .filter((s) => s.blocker_reason)
            .map((s) => `${s.task_id}: ${s.blocker_reason}`)
        ],
        unverified_items: gateEvaluation.reasons,
        final_status: hydratedTask.status,
        completion_gates_passed: gateEvaluation.passed
      };
    });
  }

  async _hydrateTask(tx, row) {
    if (!row) return null;
    const deps = await tx.all(
      'SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?',
      [row.task_id]
    );
    const participants = await tx.all(
      'SELECT agent_id, role, joined_at FROM task_participants WHERE task_id = ?',
      [row.task_id]
    );
    const leases = await tx.all(
      'SELECT lease_id, scope_pattern, owner_agent_id, mode, expires_at FROM resource_leases WHERE task_id = ?',
      [row.task_id]
    );
    return {
      task_id: row.task_id,
      parent_task_id: row.parent_task_id,
      title: row.title,
      description: row.description,
      acceptance_criteria: JSON.parse(row.acceptance_criteria_json || '[]'),
      priority: row.priority,
      status: row.status,
      created_by: row.created_by,
      owner_agent_id: row.owner_agent_id,
      claimed_scopes: JSON.parse(row.claimed_scopes_json || '[]'),
      active_leases: leases,
      dependencies: deps.map((d) => d.depends_on_task_id),
      participants,
      retry_count: row.retry_count,
      max_retries: row.max_retries,
      blocker_reason: row.blocker_reason,
      require_independent_review: Boolean(row.require_independent_review),
      require_test_execution: Boolean(row.require_test_execution),
      lease_expires_at: row.lease_expires_at,
      version: row.version,
      created_at: row.created_at,
      updated_at: row.updated_at,
      completed_at: row.completed_at
    };
  }
}

module.exports = {
  CoordinatorService,
  CoordinatorError,
  LifecycleError,
  SecurityError
};
