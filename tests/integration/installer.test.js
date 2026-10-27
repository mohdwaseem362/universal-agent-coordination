'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UacInstaller, CoordinatorService, SENTINEL_START } = require('../../src');

test('UacInstaller supports --dry-run, preserves existing user instructions and MCP configs, verifies setup, and cleanly uninstalls', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uac-installer-test-'));
  const packageRoot = path.resolve(__dirname, '..', '..');

  try {
    // Seed existing user configuration files to verify they are NEVER overwritten destructively
    const existingAgentsMd = '# My Custom Project Rules\n\nAlways run `npm run lint` before committing.\n';
    const existingClaudeMd = '# Claude Custom Rules\n\nFollow strict TypeScript conventions.\n';
    const existingMcpJson = {
      mcpServers: {
        'existing-postgres-mcp': {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-postgres']
        }
      }
    };

    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), existingAgentsMd, 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), existingClaudeMd, 'utf8');
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify(existingMcpJson, null, 2), 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"sample-app"}\n', 'utf8');

    const installer = new UacInstaller({ targetRoot: tmpDir, packageRoot });

    // 1. Test --dry-run (must not modify existing AGENTS.md or create new files)
    const dryRes = await installer.install({ dryRun: true, level: 2 });
    assert.equal(dryRes.dry_run, true);
    assert.equal(fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf8'), existingAgentsMd);
    assert.equal(
      fs.existsSync(path.join(tmpDir, 'skills', 'universal-agent-coordination', 'SKILL.md')),
      false
    );

    // 2. Perform real Level 2 installation
    const installRes = await installer.install({ dryRun: false, level: 2 });
    assert.equal(installRes.dry_run, false);

    // Verify original AGENTS.md and CLAUDE.md content is preserved alongside sentinel block
    const mergedAgentsMd = fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf8');
    assert.ok(mergedAgentsMd.includes('Always run `npm run lint` before committing.'));
    assert.ok(mergedAgentsMd.includes(SENTINEL_START));

    const mergedClaudeMd = fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf8');
    assert.ok(mergedClaudeMd.includes('Follow strict TypeScript conventions.'));
    assert.ok(mergedClaudeMd.includes(SENTINEL_START));

    // Verify existing MCP server in .mcp.json was preserved alongside universal-agent-coordination
    const mergedMcp = JSON.parse(fs.readFileSync(path.join(tmpDir, '.mcp.json'), 'utf8'));
    assert.ok(mergedMcp.mcpServers['existing-postgres-mcp']);
    assert.ok(mergedMcp.mcpServers['universal-agent-coordination']);

    // Verify canonical skill and IDE wrappers exist
    assert.equal(
      fs.existsSync(path.join(tmpDir, 'skills', 'universal-agent-coordination', 'SKILL.md')),
      true
    );
    assert.equal(
      fs.existsSync(path.join(tmpDir, '.agent', 'workflows', 'followprotocol.md')),
      true
    );
    assert.equal(
      fs.existsSync(path.join(tmpDir, '.opencode', 'command', 'followprotocol.md')),
      true
    );
    assert.equal(
      fs.existsSync(path.join(tmpDir, '.claude', 'commands', 'followprotocol.md')),
      true
    );

    // 3. Verify setup health with CoordinatorService
    const coordinator = new CoordinatorService({ workspaceRoot: tmpDir });
    try {
      const verifyRes = await installer.verifySetup(coordinator);
      assert.equal(verifyRes.verified, true);
    } finally {
      await coordinator.close();
    }

    // 4. Uninstall and verify original user content in AGENTS.md and CLAUDE.md remains intact
    const uninstallRes = installer.uninstall({ dryRun: false });
    assert.ok(uninstallRes.removed.length >= 4);

    const postUninstallAgentsMd = fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf8');
    assert.ok(postUninstallAgentsMd.includes('Always run `npm run lint` before committing.'));
    assert.equal(postUninstallAgentsMd.includes(SENTINEL_START), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
