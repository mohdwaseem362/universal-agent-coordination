# OpenCode Integration Guide

1. **Install via UAC CLI**:
   ```bash
   node ./bin/uac.js install --level 2
   ```
2. **Generated Files**:
   - `opencode.json`: Registers `mcp.universal-agent-coordination` (`type: "local"`).
   - `.opencode/command/followprotocol.md`: Registers the `/followprotocol` custom command.
   - `AGENTS.md`: Adds sentinel block teaching `@followprotocol <task>`.
