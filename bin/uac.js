#!/usr/bin/env node
'use strict';

const path = require('node:path');
const {
  CoordinatorService,
  UacInstaller,
  UacMcpServer,
  getCompatibilityMatrix,
  collectDashboardState,
  renderTerminalDashboard,
  writeHtmlDashboardSnapshot,
  checkFilesAgainstLeases
} = require('../src');

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'help';
  const dryRun = args.includes('--dry-run');
  const levelArgIdx = args.indexOf('--level');
  const level = levelArgIdx !== -1 ? Number(args[levelArgIdx + 1]) : 2;
  const workspaceRoot = process.env.UAC_WORKSPACE_ROOT || process.cwd();

  if (cmd === 'mcp-server') {
    const server = new UacMcpServer({ workspaceRoot });
    server.startStdio();
    return;
  }

  const coordinator = new CoordinatorService({ workspaceRoot });
  const installer = new UacInstaller({
    targetRoot: workspaceRoot,
    packageRoot: path.join(__dirname, '..')
  });

  try {
    switch (cmd) {
      case 'init':
      case 'install': {
        if (!dryRun && level >= 2) {
          await coordinator.init();
        }
        const res = await installer.install({ dryRun, level });
        console.log(JSON.stringify(res, null, 2));
        break;
      }

      case 'uninstall': {
        const res = installer.uninstall({ dryRun });
        console.log(JSON.stringify(res, null, 2));
        break;
      }

      case 'verify-setup':
      case 'doctor': {
        await coordinator.init();
        const verification = await installer.verifySetup(coordinator);
        const compatibility = getCompatibilityMatrix();
        console.log(
          JSON.stringify(
            {
              status: verification.verified ? 'HEALTHY' : 'INCOMPLETE_SETUP',
              verification,
              compatibility_matrix: compatibility
            },
            null,
            2
          )
        );
        if (!verification.verified) process.exitCode = 1;
        break;
      }

      case 'status':
      case 'dashboard': {
        await coordinator.init();
        const state = await collectDashboardState(coordinator);
        if (args.includes('--html')) {
          const outPath = path.join(workspaceRoot, '.uac', 'dashboard.html');
          writeHtmlDashboardSnapshot(state, outPath);
          console.log(`Dashboard HTML snapshot written to: ${outPath}`);
        } else if (args.includes('--json')) {
          console.log(JSON.stringify(state, null, 2));
        } else {
          console.log(renderTerminalDashboard(state));
        }
        break;
      }

      case 'report': {
        const taskId = args[1];
        if (!taskId) {
          console.error('Usage: uac report <task_id>');
          process.exitCode = 1;
          break;
        }
        await coordinator.init();
        const report = await coordinator.generateConsolidatedReport(taskId);
        console.log(JSON.stringify(report, null, 2));
        break;
      }

      case 'check-staged': {
        const files = args.slice(1).filter((f) => !f.startsWith('--'));
        const agentId = process.env.UAC_AGENT_ID || null;
        const res = await checkFilesAgainstLeases(coordinator, files, agentId);
        if (!res.allowed) {
          console.error('UAC Ownership Guard blocked commit due to active peer leases:');
          console.error(JSON.stringify(res.conflicts, null, 2));
          process.exitCode = 1;
        }
        break;
      }

      default: {
        console.log(`Universal Agent Coordination (UAC) CLI v1.0.0 (@followprotocol)

Usage:
  uac install [--dry-run] [--level 1|2]   Install skill, sentinel blocks, and IDE MCP configs
  uac uninstall [--dry-run]               Remove UAC sentinel blocks and generated wrappers
  uac verify-setup | doctor               Verify skill installation, DB WAL health, and IDE matrix
  uac status | dashboard [--html|--json]  Display live agents, tasks, leases, and verification state
  uac report <task_id>                    Generate consolidated multi-agent completion report
  uac mcp-server                          Start JSON-RPC 2.0 MCP server over stdio`);
        break;
      }
    }
  } finally {
    await coordinator.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`UAC CLI Error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { main };
