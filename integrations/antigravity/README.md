# AntiGravity IDE Integration Guide

1. **Install via UAC CLI**:
   ```bash
   node ./bin/uac.js install --level 2
   ```
2. **Generated Files**:
   - `.agent/skills/universal-agent-coordination/SKILL.md`: Native Agent Skill discovered automatically by AntiGravity.
   - `.agent/workflows/followprotocol.md`: Enables `/followprotocol <task>` slash workflow.
   - `AGENTS.md`: Adds sentinel block teaching `@followprotocol <task>`.
   - `.gemini/settings.json`: Configures the `universal-agent-coordination` MCP server over `stdio`.
