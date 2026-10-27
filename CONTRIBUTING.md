# Contributing to Universal Agent Coordination (`CONTRIBUTING.md`)

## Adding a New IDE Adapter

1. **Subclass `BaseIdeAdapter`**:
   Open `src/adapters/index.js` (or add a dedicated file under `src/adapters/`) and extend `BaseIdeAdapter` from `src/adapters/base-adapter.js`:
   - Implement `getCompatibilityDescriptor()` returning honest discovery paths, MCP transport support, and unsupported capabilities.
   - Implement `generateMcpConfig(serverScriptPath, workspaceRoot)` returning the target IDE's native MCP configuration structure.
   - Implement optional command/workflow template generators if the IDE supports custom slash commands.
2. **Register in `createAdapter` and `getCompatibilityMatrix`**:
   Export the new adapter in `src/adapters/index.js` and add its setup step to `src/installer/installer.js`.
3. **Add Automated Tests**:
   - Add unit and integration tests under `tests/integration/installer.test.js` and `tests/e2e/`.
   - Run `npm test` and `node ./bin/uac.js verify-setup` to confirm all checks pass.

## Release Checklist
- [ ] All unit, integration, concurrency, recovery, and E2E tests pass (`npm test`).
- [ ] `SKILL.md` frontmatter and body pass Agent Skills validation (<500 lines, valid YAML frontmatter, blank lines before lists).
- [ ] `uac install --dry-run` makes zero filesystem modifications.
- [ ] `uac install` preserves existing `AGENTS.md`, `CLAUDE.md`, and MCP JSON configs with backups in `.uac/backups/`.
- [ ] `uac uninstall` cleanly removes UAC sentinel blocks without losing user content.
- [ ] Compatibility matrix in `README.md` accurately separates verified capabilities from unsupported features.
