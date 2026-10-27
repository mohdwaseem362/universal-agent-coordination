# Universal Agent Coordination Task & Report Template

## 1. Task Plan (`post_message` type: `PLAN`)
- **Task ID**: `<task_id>`
- **Assigned Agent / IDE**: `<agent_id> (<ide>)`
- **Claimed Resource Scopes**: `<glob_1>, <glob_2>`
- **Dependencies**: `<depends_on_task_ids or None>`
- **Planned Steps**:
  1. `<step_1>`
  2. `<step_2>`

## 2. Handoff Summary (`request_handoff`)
- **From Agent**: `<from_agent_id>`
- **To Agent**: `<to_agent_id>`
- **Transferred Scopes**: `<scopes>`
- **Completed So Far**: `<summary>`
- **Remaining Work / Reproduction Steps**: `<remaining>`

## 3. Consolidated Completion Report
- **Task ID & Title**: `<task_id> - <title>`
- **Final Status**: `<DONE | BLOCKED | FAILED>`
- **Contributing Agents**: `<agent_id (ide, role)>`
- **Files / Scopes Changed**: `<scopes>`
- **Tests Executed**: `<command> (exit_code=<0>, passed=<N>, failed=<0>)`
- **Independent Review**: `<reviewer_agent_id - verdict & summary>`
- **Remaining Unverified Items / Blockers**: `<none or explicit list>`
