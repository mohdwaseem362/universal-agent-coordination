# Security Model and Trust Boundaries (`SECURITY.md`)

Universal Agent Coordination (UAC) treats shared multi-agent state as a critical security and operational boundary.

## 1. Threat Model & Trust Boundaries
1. **Prompt Injection via Peer Agent Messages**:
   - If Agent A reads untrusted external data (e.g., an issue description or web page) and posts a message to shared state, Agent B reading that message could be vulnerable to indirect prompt injection.
   - **Mitigation**: Every message returned by `read_messages` and `join_task` is wrapped in an explicit envelope (`trust_boundary: "UNTRUSTED_PEER_AGENT_DATA"`) with a mandatory security directive instructing the receiving agent to treat peer messages strictly as data, never as system instructions or shell execution commands.
2. **Secret & Credential Leakage in Shared State**:
   - Agents might accidentally paste `.env` values, API keys, JWTs, or database passwords into `post_message`, `record_decision`, or `report_test_results`.
   - **Mitigation**: `src/coordinator/security.js` automatically scrubs OpenAI/Anthropic keys (`sk-...`), GitHub tokens (`ghp_...`, `github_pat_...`), AWS access keys (`AKIA...`), Slack tokens (`xoxb-...`), Google API keys, JWTs, private key blocks, Bearer tokens, DB connection passwords, and `api_key`/`password` assignments before writing to SQLite.
3. **Path Traversal & Sensitive File Claims**:
   - **Mitigation**: `validateAndNormalizeScope` rejects `..` traversal segments, null bytes, absolute paths outside `workspaceRoot`, root wildcard claims (`.`), and protected files (`.env*`, `.git/config`, `id_rsa`, `*.pem`, `*.key`).
4. **No Arbitrary Shell or Filesystem Execution via MCP**:
   - The UAC MCP server (`src/mcp/server.js`) exposes strictly typed coordination state operations. It never executes shell commands or writes arbitrary workspace files.
5. **Agent Identity, Authorization, and Self-Review Prevention**:
   - Workspace registration generates a local `0600` token (`.uac/workspace.token`) and per-agent `session_token` hashes.
   - Only the task owner may initiate `request_handoff` or release owned leases.
   - When `require_independent_review` is enabled, `submit_review` enforces `reviewer_agent_id !== owner_agent_id` (`SELF_REVIEW_FORBIDDEN`).

## 2. Honest Disclosure of Physical File Lock Limitations
- **Advisory Locks + Git Hook + Baseline Hashes**: UAC resource leases (`claim_resource`) prevent overlapping edits among protocol-compliant agents. Because OS processes running as the same local developer user can still write directly to the filesystem if they ignore MCP tools, UAC records SHA-256 baseline hashes (`computeBaselineHashes` / `detectExternalModifications`) when a scope is claimed and provides a Git `pre-commit` hook (`uac check-staged`) to block commits that touch files leased by another active agent.
