-- Universal Agent Coordination (UAC) Normalized SQLite Schema
-- Version: 1.0.0

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
    agent_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    ide TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'general',
    capabilities_json TEXT NOT NULL DEFAULT '[]',
    workspace_root TEXT NOT NULL,
    session_token_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ONLINE' CHECK (status IN ('ONLINE', 'BUSY', 'OFFLINE', 'STALE')),
    last_heartbeat_at TEXT NOT NULL,
    registered_at TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS tasks (
    task_id TEXT PRIMARY KEY,
    parent_task_id TEXT REFERENCES tasks(task_id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
    priority TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (priority IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
    status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN (
        'OPEN', 'CLAIMED', 'IN_PROGRESS', 'REVIEW', 'VERIFYING', 'DONE', 'BLOCKED', 'FAILED', 'CANCELLED'
    )),
    created_by TEXT NOT NULL REFERENCES agents(agent_id),
    owner_agent_id TEXT REFERENCES agents(agent_id),
    claimed_scopes_json TEXT NOT NULL DEFAULT '[]',
    retry_count INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 3,
    blocker_reason TEXT,
    require_independent_review INTEGER NOT NULL DEFAULT 0,
    require_test_execution INTEGER NOT NULL DEFAULT 1,
    lease_expires_at TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
);

CREATE TABLE IF NOT EXISTS task_participants (
    task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'collaborator',
    joined_at TEXT NOT NULL,
    PRIMARY KEY (task_id, agent_id)
);

CREATE TABLE IF NOT EXISTS task_dependencies (
    task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    depends_on_task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (task_id, depends_on_task_id),
    CHECK (task_id != depends_on_task_id)
);

CREATE TABLE IF NOT EXISTS resource_leases (
    lease_id TEXT PRIMARY KEY,
    scope_pattern TEXT NOT NULL UNIQUE,
    task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    owner_agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    mode TEXT NOT NULL DEFAULT 'EXCLUSIVE' CHECK (mode IN ('EXCLUSIVE', 'SHARED_READ')),
    baseline_hashes_json TEXT NOT NULL DEFAULT '{}',
    acquired_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    renewed_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ownership_transitions (
    transition_id TEXT PRIMARY KEY,
    scope_pattern TEXT NOT NULL,
    task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    from_agent_id TEXT REFERENCES agents(agent_id),
    to_agent_id TEXT REFERENCES agents(agent_id),
    transition_type TEXT NOT NULL CHECK (transition_type IN (
        'CLAIMED', 'RELEASED', 'HANDOFF_REQUESTED', 'HANDOFF_ACCEPTED', 'LEASE_EXPIRED', 'CONFLICT_REJECTED'
    )),
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS handoff_requests (
    handoff_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    from_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
    to_agent_id TEXT REFERENCES agents(agent_id),
    scopes_json TEXT NOT NULL DEFAULT '[]',
    summary TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED')),
    created_at TEXT NOT NULL,
    resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS messages (
    message_id TEXT PRIMARY KEY,
    task_id TEXT REFERENCES tasks(task_id) ON DELETE CASCADE,
    sender_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
    recipient_agent_id TEXT REFERENCES agents(agent_id),
    message_type TEXT NOT NULL DEFAULT 'FINDING' CHECK (message_type IN (
        'QUESTION', 'ANSWER', 'FINDING', 'PLAN', 'BLOCKER', 'HANDOFF', 'REVIEW', 'STATUS_UPDATE'
    )),
    reply_to_message_id TEXT REFERENCES messages(message_id),
    content TEXT NOT NULL,
    redacted INTEGER NOT NULL DEFAULT 0,
    acknowledged INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decisions (
    decision_id TEXT PRIMARY KEY,
    task_id TEXT REFERENCES tasks(task_id) ON DELETE CASCADE,
    author_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
    topic TEXT NOT NULL,
    decision TEXT NOT NULL,
    rationale TEXT NOT NULL DEFAULT '',
    supersedes_decision_id TEXT REFERENCES decisions(decision_id),
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUPERSEDED')),
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS verification_evidence (
    evidence_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents(agent_id),
    evidence_type TEXT NOT NULL CHECK (evidence_type IN ('TEST_RESULT', 'INDEPENDENT_REVIEW', 'BUILD_CHECK', 'LINT_CHECK')),
    command TEXT,
    exit_code INTEGER,
    passed INTEGER NOT NULL CHECK (passed IN (0, 1)),
    passed_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    output_summary TEXT NOT NULL,
    artifact_hashes_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    agent_id TEXT,
    task_id TEXT,
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner_agent_id);
CREATE INDEX IF NOT EXISTS idx_messages_task ON messages(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient_agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_leases_task ON resource_leases(task_id);
CREATE INDEX IF NOT EXISTS idx_leases_expires ON resource_leases(expires_at);
CREATE INDEX IF NOT EXISTS idx_evidence_task ON verification_evidence(task_id, evidence_type);
