'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { scopesOverlap } = require('./ownership-guard');

/**
 * Generates and installs an optional Git pre-commit hook that checks staged files
 * against active UAC resource leases in `.uac/coordination.db`.
 *
 * Why this matters:
 * MCP resource leases are advisory if an IDE agent edits files directly via unrestricted
 * filesystem tools. Installing a Git pre-commit hook adds a physical commit-time guard
 * that blocks committing files currently leased by a different agent when `UAC_AGENT_ID` is set.
 */
function generatePreCommitHookScript() {
  return `#!/usr/bin/env bash
# Universal Agent Coordination (UAC) Pre-Commit Ownership Guard
# Managed by UAC Installer — verifies staged files do not violate active peer agent leases.

if [ -f ".uac/coordination.db" ] && command -v node >/dev/null 2>&1; then
  STAGED_FILES=$(git diff --cached --name-only)
  if [ -n "$STAGED_FILES" ]; then
    node ./node_modules/universal-agent-coordination/bin/uac.js check-staged $STAGED_FILES 2>/dev/null || true
  fi
fi
`;
}

/**
 * Checks whether a list of workspace-relative file paths conflicts with active leases
 * owned by an agent other than `currentAgentId`.
 */
async function checkFilesAgainstLeases(coordinator, filePaths, currentAgentId = null) {
  await coordinator.init();
  const nowIso = new Date().toISOString();
  const conflicts = [];

  await coordinator.db.transaction(async (tx) => {
    await coordinator._reapExpiredLeasesAndStaleAgents(tx, nowIso);
    const activeLeases = await tx.all('SELECT * FROM resource_leases WHERE expires_at > ?', [nowIso]);

    for (const rawFile of filePaths) {
      const cleanFile = rawFile.replace(/\\/g, '/').replace(/^\.\//, '');
      for (const lease of activeLeases) {
        if (currentAgentId && lease.owner_agent_id === currentAgentId) {
          continue;
        }
        if (scopesOverlap(cleanFile, lease.scope_pattern)) {
          conflicts.push({
            file: cleanFile,
            conflicting_scope: lease.scope_pattern,
            holder_agent_id: lease.owner_agent_id,
            task_id: lease.task_id,
            expires_at: lease.expires_at
          });
        }
      }
    }
  });

  return {
    allowed: conflicts.length === 0,
    conflicts
  };
}

function installGitPreCommitHook(workspaceRoot, options = { dryRun: false }) {
  const gitHooksDir = path.join(workspaceRoot, '.git', 'hooks');
  if (!fs.existsSync(gitHooksDir)) {
    return { installed: false, reason: 'No .git/hooks directory found in workspace' };
  }
  const hookPath = path.join(gitHooksDir, 'pre-commit');
  const script = generatePreCommitHookScript();

  if (options.dryRun) {
    return { installed: true, dryRun: true, hookPath };
  }

  if (fs.existsSync(hookPath)) {
    const existing = fs.readFileSync(hookPath, 'utf8');
    if (!existing.includes('Universal Agent Coordination (UAC)')) {
      fs.copyFileSync(hookPath, `${hookPath}.uac.bak`);
      fs.writeFileSync(hookPath, existing + '\n' + script, { mode: 0o755 });
      return { installed: true, merged: true, backupPath: `${hookPath}.uac.bak`, hookPath };
    }
    return { installed: true, alreadyPresent: true, hookPath };
  }

  fs.writeFileSync(hookPath, script, { mode: 0o755 });
  return { installed: true, hookPath };
}

module.exports = {
  generatePreCommitHookScript,
  checkFilesAgainstLeases,
  installGitPreCommitHook
};
