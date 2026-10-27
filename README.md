# Universal Agent Coordination (UAC) — `@followprotocol`

> **One memorable trigger (`@followprotocol`), one shared SQLite WAL coordination engine, multiple AI coding IDEs (AntiGravity, OpenCode, Claude Code, Codex), and one verifiable completed task.**

[![UAC CI](https://github.com/mohdwaseem362/universal-agent-coordination/actions/workflows/ci.yml/badge.svg)](https://github.com/mohdwaseem362/universal-agent-coordination/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](package.json)
[![Python 3](https://img.shields.io/badge/python-3.8%2B%20sqlite3-blue.svg)](src/database/sqlite_worker.py)
[![MCP Server](https://img.shields.io/badge/MCP-JSON--RPC%202.0%20stdio-purple.svg)](src/mcp/server.js)

Universal Agent Coordination (UAC) is a production-minded, model-agnostic, multi-IDE AI agent collaboration system. It lets developers run multiple coding agents across **AntiGravity**, **OpenCode**, **Claude Code**, **Codex CLI**, and other **MCP / Agent Skills** clients on the same software repository without duplicate task creation, silent file overwrites, or unverified "Done!" claims.

## Table of Contents

1. [What Problem Does UAC Solve?](#1-what-problem-does-uac-solve)
2. [Architecture Overview (Skill + Coordinator)](#2-architecture-overview-skill--coordinator)
3. [Quickstart: Install from GitHub into Any Project](#3-quickstart-install-from-github-into-any-project)
4. [Supported IDEs & Compatibility Matrix](#4-supported-ides--compatibility-matrix)
5. [How `@followprotocol` Works Step-by-Step](#5-how-followprotocol-works-step-by-step)
6. [Real Multi-IDE Example: AntiGravity + OpenCode + Claude Code](#6-real-multi-ide-example-antigravity--opencode--claude-code)
7. [17 MCP Coordination Tools Reference](#7-17-mcp-coordination-tools-reference)
8. [CLI Commands & Live Observability Dashboard](#8-cli-commands--live-observability-dashboard)
9. [Security Model, Offline Mode & Limitations](#9-security-model-offline-mode--limitations)
10. [Uninstallation & Contributing](#10-uninstallation--contributing)

## 1. What Problem Does UAC Solve?

When you open two or more AI coding tools on the same project (for example, **AntiGravity** building a backend service while **OpenCode** debugs failing tests and **Claude Code** audits security):
- **Isolated Context**: Agent B cannot see Agent A's chat history, plan, or interface decisions.
- **Conflicting Edits**: Both agents edit the same file simultaneously and silently overwrite each other's work.
- **Premature Completion**: Agents claim a task is complete without running tests or passing independent review.

**UAC fixes this with two independently usable layers:**
1. **Universal Coordination Skill (`skills/universal-agent-coordination/SKILL.md`)**: Teaches any compatible agent how to inspect repositories, claim tasks, reserve file scopes, bound repair loops, and verify completion gates.
2. **Shared Coordination Engine (`src/coordinator/`, `src/mcp/server.js`)**: A zero-build, local-first **SQLite WAL** transaction engine and **JSON-RPC 2.0 MCP server** that coordinates task state, file leases, peer messages, decisions, handoffs, and test/review evidence across IDEs.

## 2. Architecture Overview (Skill + Coordinator)

```text
+--------------------+     +--------------------+     +--------------------+
|  AntiGravity IDE   |     |   OpenCode CLI     |     |    Claude Code     |
| (@followprotocol)  |     | (@followprotocol)  |     | (@followprotocol)  |
+---------+----------+     +---------+----------+     +---------+----------+
          |                          |                          |
          | MCP stdio                | MCP stdio                | MCP stdio
          v                          v                          v
+---------+--------------------------+--------------------------+----------+
|                 UAC MCP Server (src/mcp/server.js - 17 Tools)            |
|  - State Machine Validator (OPEN->CLAIMED->IN_PROGRESS->VERIFYING->DONE) |
|  - Ownership Guard (Glob Overlap Engine + SHA-256 Dirty-Tree Hashes)     |
|  - Security Boundary (Secret Scrubbing + UNTRUSTED_PEER_AGENT_DATA)      |
|  - 5-Gate Completion Verifier (Deps, Subtasks, Blockers, Tests, Review)  |
+------------------------------------+-------------------------------------+
                                     |
                                     | BEGIN IMMEDIATE ... COMMIT (ACID WAL)
                                     v
                     +---------------+----------------+
                     |  .uac/coordination.db (SQLite) |
                     +--------------------------------+
```

## 3. Quickstart: Install from GitHub into Any Project

### Prerequisites
- **Node.js `>= 18.0.0`** (`node -v`)
- **Python `>= 3.8`** with standard library `sqlite3` (`python3 --version`)
- **Zero `npm install` or native compilation (`node-gyp`) required!**

### Option A: Clone into Your Project's `tools/` Folder (Recommended)
Run these commands from the root of any project where you want multi-IDE coordination:

```bash
# 1. Clone UAC into your project
git clone https://github.com/mohdwaseem362/universal-agent-coordination.git tools/universal-agent-coordination

# 2. Preview what the non-destructive installer will configure (Dry Run)
node ./tools/universal-agent-coordination/bin/uac.js install --dry-run

# 3. Install Level 2 (Skill + Shared SQLite Coordinator + IDE MCP Configs + Git Hook)
node ./tools/universal-agent-coordination/bin/uac.js install --level 2

# 4. Verify setup health and IDE compatibility matrix
node ./tools/universal-agent-coordination/bin/uac.js verify-setup
```

### Option B: Install Globally on Your Machine (`npm link`)
If you want the `uac` command available in every project on your computer without cloning into each repo:

```bash
git clone https://github.com/mohdwaseem362/universal-agent-coordination.git ~/universal-agent-coordination
cd ~/universal-agent-coordination
npm test
npm link

# Now inside ANY project directory, simply run:
cd /path/to/any-project
uac install --level 2
uac status
```

### Level 1 vs. Level 2 Installation
- **Level 1 (`uac install --level 1`) — Skill Only**: Installs `SKILL.md` and `AGENTS.md`/`CLAUDE.md` sentinel blocks for single-agent workflows. No MCP server is required; the agent explicitly discloses that cross-IDE coordination is offline.
- **Level 2 (`uac install --level 2`) — Skill + Coordinator (Default)**: Installs the skill, merges sentinel blocks into `AGENTS.md`/`CLAUDE.md` (with automatic backups in `.uac/backups/`), generates MCP configs for AntiGravity, OpenCode, Claude Code, and Codex, initializes `.uac/coordination.db`, and installs the Git `pre-commit` ownership guard.

## 4. Supported IDEs & Compatibility Matrix

| IDE / Tool | Skill & Instruction Discovery | MCP Configuration File | `@followprotocol` Trigger | Status |
| :--- | :--- | :--- | :--- | :--- |
| **AntiGravity** | `.agent/skills/universal-agent-coordination/SKILL.md`, `AGENTS.md`, `.agent/workflows/followprotocol.md` | `.gemini/settings.json` | Native Skill + `@followprotocol` + `/followprotocol` workflow | **Verified** (Skill + MCP stdio) |
| **OpenCode** | `AGENTS.md`, `.opencode/command/followprotocol.md` | `opencode.json` | `@followprotocol` + `/followprotocol` custom command | **Verified** (Config + MCP stdio) |
| **Claude Code** | `CLAUDE.md`, `.claude/commands/followprotocol.md` | `.mcp.json` | `@followprotocol` + `/project:followprotocol` slash command | **Verified** (Config + MCP stdio) |
| **Codex CLI** | `AGENTS.md`, `skills/universal-agent-coordination/SKILL.md` | `.codex/config.toml` | `@followprotocol` via `AGENTS.md` | **Verified** (Config + MCP stdio) |
| **Generic MCP** | `skills/universal-agent-coordination/SKILL.md`, `AGENTS.md` | Standard MCP `stdio` config | `@followprotocol` prompt convention | **Verified** (MCP stdio) |

## 5. How `@followprotocol` Works Step-by-Step

When you type `@followprotocol <your task>` (or `/followprotocol <your task>`) in any configured IDE:
1. **Protocol Load & Stack Detection**: The agent loads `skills/universal-agent-coordination/SKILL.md` and inspects project manifests (`package.json`, `composer.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`) and `AGENTS.md`/`CLAUDE.md`.
2. **Agent Registration**: Calls `register_agent` to register its IDE session and heartbeat.
3. **Task Discovery (No Duplicates)**: Calls `list_tasks` and `get_agent_status` to check if another IDE has already created the task.
4. **Claim or Join**: Calls `claim_task` (if new) or `join_task` (to collaborate on an existing task or create a child subtask).
5. **Resource Scope Reservation**: Calls `claim_resource` (e.g., `src/checkout/**` or `tests/checkout/**`) before editing files. Overlapping claims by other agents are rejected with `RESOURCE_OWNERSHIP_CONFLICT`.
6. **Structured Communication**: Exchanges plans, findings, questions, and API decisions via `post_message`, `read_messages`, `ask_agent`, `record_decision`, and `request_handoff`.
7. **Gated Verification**: Runs tests, records exact exit codes via `report_test_results`, submits/requests independent review via `submit_review`, and calls `verify_completion` to transition the task to `DONE`.

## 6. Real Multi-IDE Example: AntiGravity + OpenCode + Claude Code

You can run the complete 3-IDE simulation locally at any time:
```bash
node ./examples/multi-ide-checkout-demo.js
```

### Step 1 — Assign Primary Task in AntiGravity
In **AntiGravity**, prompt:
```text
@followprotocol Test the checkout feature, investigate failures, and fix them.
```
- AntiGravity registers as `antigravity-checkout`, creates the primary task with `require_independent_review: true`, claims exclusive ownership of `src/checkout/**`, and publishes its plan.

### Step 2 — Join from OpenCode
In **OpenCode**, prompt:
```text
@followprotocol Join the existing checkout task and help AntiGravity finish it. Investigate the failing tests and suggest or implement fixes.
```
- OpenCode connects to the same `.uac/coordination.db`, discovers the existing checkout task via `list_tasks`, calls `join_task` to create a child subtask owning `tests/checkout/**`, and reads AntiGravity's messages.
- If OpenCode attempts to claim `src/checkout/CheckoutService.js`, UAC rejects it with `RESOURCE_OWNERSHIP_CONFLICT` and logs `CONFLICT_REJECTED`.
- OpenCode runs the checkout test suite, reports the failure (`exit_code: 1, failed_count: 2`) via `report_test_results`, and posts the root cause (`floating-point rounding drift in calculateTotal()`) to AntiGravity.

### Step 3 — Fix, Re-Test, Independent Review & Completion
- AntiGravity records the architectural fix via `record_decision` (`integer-cents arithmetic`) and updates `src/checkout/CheckoutService.js`.
- OpenCode re-runs the tests, records passing evidence (`exit_code: 0, passed_count: 14, failed_count: 0`), and completes its subtask.
- **Claude Code** (`claude-security-reviewer`) reviews the diff and calls `submit_review({ approved: true })` (self-review by `antigravity-checkout` is blocked with `SELF_REVIEW_FORBIDDEN`).
- AntiGravity calls `verify_completion` — all 5 gates pass, active leases are released, and the task transitions to `DONE`.

## 7. 17 MCP Coordination Tools Reference

| Tool Name | Purpose | Auth Required | Idempotent |
| :--- | :--- | :--- | :--- |
| `register_agent` | Register or refresh an IDE agent session | Workspace token (optional) | Yes |
| `get_agent_status` | List online/stale agents, heartbeats, owned tasks, and leases | Read-only | Yes |
| `create_task` | Create a shared task or subtask with acceptance criteria & gates | Registered agent | Yes |
| `list_tasks` | Search tasks by status, owner, parent task, or keyword | Read-only | Yes |
| `claim_task` | Atomically claim an `OPEN` task and optional resource scopes | Registered agent | Yes |
| `join_task` | Join an existing task as collaborator and optionally spawn subtask | Registered agent | Yes |
| `update_task_status` | Transition task state (`IN_PROGRESS`, `REVIEW`, `BLOCKED`, `FAILED`) | Owner or participant | No |
| `post_message` | Post secret-redacted `PLAN`, `FINDING`, `QUESTION`, `ANSWER`, `BLOCKER` | Registered agent | No |
| `read_messages` | Read messages wrapped in `UNTRUSTED_PEER_AGENT_DATA` envelope | Read-only | Yes |
| `ask_agent` | Send a targeted `QUESTION` message to another collaborating agent | Registered agent | No |
| `record_decision` | Record an authoritative architectural/interface decision | Registered agent | No |
| `request_handoff` | Transfer task and resource lease ownership to another agent | Current task owner | No |
| `claim_resource` | Reserve exclusive or shared-read file/glob scopes; rejects overlaps | Registered agent | Yes |
| `release_resource` | Release an active resource lease held by the calling agent | Lease owner | Yes |
| `report_test_results` | Record test command, exit code, pass/fail counts, and summary | Registered agent | No |
| `submit_review` | Record an independent code/security review verdict | Distinct reviewer agent | No |
| `verify_completion` | Evaluate all 5 completion gates and mark task `DONE` if satisfied | Registered agent | Yes |

## 8. CLI Commands & Live Observability Dashboard

```bash
# View live terminal dashboard (connected agents, tasks, active leases, conflicts, evidence)
node ./bin/uac.js status

# Generate self-contained HTML dashboard snapshot (.uac/dashboard.html)
node ./bin/uac.js dashboard --html

# Export full coordinator state as JSON
node ./bin/uac.js status --json

# Generate consolidated multi-agent completion report for a specific task
node ./bin/uac.js report <task_id>

# Run automated test suite (unit + integration + concurrency + E2E)
npm test
```

## 9. Security Model, Offline Mode & Limitations

- **100% Offline & Local-First**: Works entirely offline using local SQLite WAL (`.uac/coordination.db`). No cloud accounts, Redis, PostgreSQL, Docker, or external API keys required.
- **Automatic Secret Scrubbing**: `src/coordinator/security.js` automatically redacts OpenAI/Anthropic keys (`sk-...`), GitHub tokens (`ghp_...`, `github_pat_...`), AWS keys (`AKIA...`), Slack tokens, Google API keys, JWTs, Bearer tokens, private keys, and DB connection passwords before writing to SQLite.
- **Prompt Injection Defense**: Peer messages are wrapped with `trust_boundary: "UNTRUSTED_PEER_AGENT_DATA"` so agents treat peer messages as data, never as higher-priority system instructions.
- **Advisory Locks + Physical Guards**: MCP leases coordinate protocol-compliant agents. To guard against raw filesystem edits bypassing MCP, UAC records SHA-256 file baselines (`detectExternalModifications`) and installs a Git `pre-commit` hook (`uac check-staged`) that blocks commits touching files leased to another agent. See [`SECURITY.md`](SECURITY.md) for full details.

## 10. Uninstallation & Contributing

- **Uninstall cleanly from any project** (removes UAC sentinel blocks and wrappers while preserving all original `AGENTS.md`, `CLAUDE.md`, and MCP settings):
  ```bash
  node ./bin/uac.js uninstall
  ```
- **Adding a new IDE adapter**: Subclass `BaseIdeAdapter` in [`src/adapters/index.js`](src/adapters/index.js). See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the step-by-step contributor guide and release checklist.
