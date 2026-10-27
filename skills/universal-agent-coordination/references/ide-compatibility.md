# IDE Compatibility Matrix and Discovery Guide

| IDE / Agent | Skill & Instruction Discovery | MCP Configuration File | `@followprotocol` Trigger Support | Verification Status |
| :--- | :--- | :--- | :--- | :--- |
| **AntiGravity** | `.agent/skills/universal-agent-coordination/SKILL.md`, `AGENTS.md`, `.agent/workflows/followprotocol.md` | `.gemini/settings.json` | Native skill + `@followprotocol` in `AGENTS.md` + `/followprotocol` workflow | Verified skill + MCP stdio |
| **OpenCode** | `AGENTS.md`, `.opencode/command/followprotocol.md` | `opencode.json` (`mcp.universal-agent-coordination`) | `@followprotocol` via `AGENTS.md` + `/followprotocol` custom command | Verified config + MCP stdio |
| **Claude Code** | `CLAUDE.md`, `.claude/commands/followprotocol.md` | `.mcp.json` (`mcpServers.universal-agent-coordination`) | `@followprotocol` via `CLAUDE.md` + `/project:followprotocol` command | Verified config + MCP stdio |
| **Codex CLI** | `AGENTS.md`, `skills/universal-agent-coordination/SKILL.md` | `.codex/config.toml` | `@followprotocol` via `AGENTS.md` instructions | Verified config + MCP stdio |
| **Generic MCP** | `skills/universal-agent-coordination/SKILL.md`, `AGENTS.md` | Standard MCP `stdio` client config | `@followprotocol` prompt convention | Verified via MCP stdio |
