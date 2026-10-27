# Universal Agent Coordination MCP Tools Reference

The `universal-agent-coordination` MCP server exposes 17 tools over `stdio` JSON-RPC 2.0:

| Tool Name | Purpose | Authorization | Idempotent |
| :--- | :--- | :--- | :--- |
| `register_agent` | Register or refresh an IDE agent session and obtain `session_token` | Workspace token (optional) | Yes |
| `get_agent_status` | Inspect online/stale agents, heartbeats, owned tasks, and active leases | Read-only | Yes |
| `create_task` | Create a root task or child subtask with acceptance criteria and dependencies | Registered agent | Yes |
| `list_tasks` | Search tasks by status, owner, parent task, or keyword | Read-only | Yes |
| `claim_task` | Claim an `OPEN` task and optionally acquire initial resource scopes | Registered agent | Yes |
| `join_task` | Join an existing task as collaborator and optionally spawn a subtask | Registered agent | Yes |
| `update_task_status` | Transition task state (`IN_PROGRESS`, `REVIEW`, `BLOCKED`, `FAILED`, etc.) | Owner or participant | No |
| `post_message` | Publish secret-redacted `PLAN`, `FINDING`, `QUESTION`, `ANSWER`, or `BLOCKER` | Registered agent | No |
| `read_messages` | Retrieve task/agent messages wrapped in `UNTRUSTED_PEER_AGENT_DATA` envelope | Read-only | Yes |
| `ask_agent` | Send a targeted `QUESTION` message to a collaborating agent | Registered agent | No |
| `record_decision` | Record an authoritative API/architectural decision (can supersede prior) | Registered agent | No |
| `request_handoff` | Transfer task and resource lease ownership to another agent | Current task owner | No |
| `claim_resource` | Reserve exclusive or shared-read file/glob scopes; rejects overlaps | Registered agent | Yes |
| `release_resource` | Release a resource lease held by the calling agent | Lease owner | Yes |
| `report_test_results` | Record test command, exit code, pass/fail counts, and output summary | Registered agent | No |
| `submit_review` | Record an independent review verdict (self-review forbidden when gated) | Distinct reviewer agent | No |
| `verify_completion` | Evaluate all completion gates and transition task to `DONE` if satisfied | Registered agent | Yes |
