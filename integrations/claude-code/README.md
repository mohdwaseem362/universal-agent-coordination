# Claude Code Integration Guide

1. **Install via UAC CLI**:
   ```bash
   node ./bin/uac.js install --level 2
   ```
2. **Generated Files**:
   - `.mcp.json`: Registers `mcpServers.universal-agent-coordination` (`type: "stdio"`).
   - `.claude/commands/followprotocol.md`: Enables `/project:followprotocol` slash command.
   - `CLAUDE.md`: Safely merges sentinel block teaching `@followprotocol <task>`.
