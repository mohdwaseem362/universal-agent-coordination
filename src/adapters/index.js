'use strict';

const { BaseIdeAdapter } = require('./base-adapter');

class AntiGravityAdapter extends BaseIdeAdapter {
  constructor(options = {}) {
    super({
      ...options,
      ide: 'antigravity',
      displayName: 'AntiGravity IDE',
      agentId: options.agentId || 'antigravity-primary',
      agentName: options.agentName || 'AntiGravity Agent'
    });
  }

  getCompatibilityDescriptor() {
    return {
      ide: 'antigravity',
      display_name: 'AntiGravity IDE / Gemini Agent Mode',
      skill_discovery: 'NATIVE_SKILL_MD (.agent/skills/universal-agent-coordination/SKILL.md & skills/universal-agent-coordination/SKILL.md)',
      instruction_files: ['AGENTS.md', '.agent/workflows/followprotocol.md'],
      mcp_config_path: '.gemini/settings.json',
      mcp_transport: 'stdio',
      trigger_mechanism: '@followprotocol <task> (via AGENTS.md + skill trigger) or /followprotocol workflow',
      verification_status: 'VERIFIED_SKILL_AND_MCP_STDIO',
      unsupported_capabilities: this.getUnsupportedCapabilities()
    };
  }

  generateMcpConfig(serverScriptPath, workspaceRoot) {
    return {
      mcpServers: {
        'universal-agent-coordination': {
          command: 'node',
          args: [serverScriptPath],
          env: {
            UAC_WORKSPACE_ROOT: workspaceRoot
          }
        }
      }
    };
  }

  generateWorkflowMarkdown() {
    return `---
description: Execute a task using the Universal Agent Coordination (@followprotocol) multi-IDE workflow
---
# @followprotocol Workflow (AntiGravity)

When invoked via \`@followprotocol <task>\` or \`/followprotocol <task>\`:
1. Load \`skills/universal-agent-coordination/SKILL.md\`.
2. Call MCP tool \`register_agent\` with \`ide: "antigravity"\`.
3. Call \`list_tasks\` and \`get_agent_status\` to check existing tasks and active peer leases.
4. Claim or join the target task (\`claim_task\` or \`join_task\`) and reserve file scopes (\`claim_resource\`) before editing.
5. Communicate plans, findings, and questions via \`post_message\` and \`record_decision\`.
6. Run relevant project tests, report via \`report_test_results\`, and complete via \`verify_completion\`.
`;
  }
}

class OpenCodeAdapter extends BaseIdeAdapter {
  constructor(options = {}) {
    super({
      ...options,
      ide: 'opencode',
      displayName: 'OpenCode CLI/IDE',
      agentId: options.agentId || 'opencode-collab',
      agentName: options.agentName || 'OpenCode Agent'
    });
  }

  getCompatibilityDescriptor() {
    return {
      ide: 'opencode',
      display_name: 'OpenCode',
      skill_discovery: 'AGENTS_MD_AND_CUSTOM_COMMAND (AGENTS.md + .opencode/command/followprotocol.md)',
      instruction_files: ['AGENTS.md', '.opencode/command/followprotocol.md'],
      mcp_config_path: 'opencode.json',
      mcp_transport: 'stdio (type: local)',
      trigger_mechanism: '@followprotocol <task> in chat or /followprotocol custom command',
      verification_status: 'VERIFIED_CONFIG_AND_MCP_STDIO',
      unsupported_capabilities: this.getUnsupportedCapabilities()
    };
  }

  generateMcpConfig(serverScriptPath, workspaceRoot) {
    return {
      $schema: 'https://opencode.ai/config.json',
      mcp: {
        'universal-agent-coordination': {
          type: 'local',
          command: ['node', serverScriptPath],
          enabled: true,
          environment: {
            UAC_WORKSPACE_ROOT: workspaceRoot
          }
        }
      }
    };
  }

  generateCommandMarkdown() {
    return `---
description: Run Universal Agent Coordination (@followprotocol) to collaborate with peer IDEs
---
Follow the Universal Agent Coordination protocol in \`skills/universal-agent-coordination/SKILL.md\`:
1. Register via \`register_agent\` (\`ide: "opencode"\`).
2. Search existing tasks with \`list_tasks\` before creating a duplicate task.
3. Join existing tasks via \`join_task\` and claim non-overlapping file scopes via \`claim_resource\`.
4. Read peer messages via \`read_messages\`, run verification tests, record results with \`report_test_results\`, and verify completion via \`verify_completion\`.
`;
  }
}

class ClaudeCodeAdapter extends BaseIdeAdapter {
  constructor(options = {}) {
    super({
      ...options,
      ide: 'claude-code',
      displayName: 'Claude Code',
      agentId: options.agentId || 'claude-code-agent',
      agentName: options.agentName || 'Claude Code Agent'
    });
  }

  getCompatibilityDescriptor() {
    return {
      ide: 'claude-code',
      display_name: 'Claude Code CLI / IDE Extension',
      skill_discovery: 'CLAUDE_MD_AND_SLASH_COMMAND (CLAUDE.md + .claude/commands/followprotocol.md)',
      instruction_files: ['CLAUDE.md', '.claude/commands/followprotocol.md'],
      mcp_config_path: '.mcp.json',
      mcp_transport: 'stdio',
      trigger_mechanism: '@followprotocol <task> (via CLAUDE.md) or /project:followprotocol slash command',
      verification_status: 'VERIFIED_CONFIG_AND_MCP_STDIO',
      unsupported_capabilities: this.getUnsupportedCapabilities()
    };
  }

  generateMcpConfig(serverScriptPath, workspaceRoot) {
    return {
      mcpServers: {
        'universal-agent-coordination': {
          type: 'stdio',
          command: 'node',
          args: [serverScriptPath],
          env: {
            UAC_WORKSPACE_ROOT: workspaceRoot
          }
        }
      }
    };
  }

  generateCommandMarkdown() {
    return `Execute the Universal Agent Coordination protocol (@followprotocol) for task: $ARGUMENTS

1. Read \`skills/universal-agent-coordination/SKILL.md\`.
2. Register this session via MCP tool \`register_agent\` (\`ide: "claude-code"\`).
3. Inspect active tasks (\`list_tasks\`), messages (\`read_messages\`), and resource leases (\`get_agent_status\`).
4. Claim or join the task (\`claim_task\` / \`join_task\`) and reserve scopes (\`claim_resource\`) prior to editing files.
5. Run tests, report evidence via \`report_test_results\`, or submit independent reviews via \`submit_review\`, then call \`verify_completion\`.
`;
  }
}

class CodexAdapter extends BaseIdeAdapter {
  constructor(options = {}) {
    super({
      ...options,
      ide: 'codex',
      displayName: 'OpenAI Codex CLI',
      agentId: options.agentId || 'codex-agent',
      agentName: options.agentName || 'Codex Agent'
    });
  }

  getCompatibilityDescriptor() {
    return {
      ide: 'codex',
      display_name: 'Codex CLI / Agent',
      skill_discovery: 'AGENTS_MD_AND_SKILL_DIR (AGENTS.md + skills/universal-agent-coordination/SKILL.md)',
      instruction_files: ['AGENTS.md'],
      mcp_config_path: '.codex/config.toml',
      mcp_transport: 'stdio (or CLI fallback via `npx uac`)',
      trigger_mechanism: '@followprotocol <task> parsed via AGENTS.md project instructions',
      verification_status: 'VERIFIED_CONFIG_AND_MCP_STDIO',
      unsupported_capabilities: [
        ...this.getUnsupportedCapabilities(),
        'Native slash command registration in older Codex CLI builds (uses @followprotocol convention in AGENTS.md).'
      ]
    };
  }

  generateConfigToml(serverScriptPath, workspaceRoot) {
    return `# Universal Agent Coordination (UAC) MCP configuration for Codex CLI
[mcp_servers.universal_agent_coordination]
command = "node"
args = ["${serverScriptPath.replace(/\\/g, '/')}"]
env = { UAC_WORKSPACE_ROOT = "${workspaceRoot.replace(/\\/g, '/')}" }
`;
  }
}

function createAdapter(ideName, options = {}) {
  const normalized = String(ideName || '').toLowerCase().trim();
  switch (normalized) {
    case 'antigravity':
      return new AntiGravityAdapter(options);
    case 'opencode':
      return new OpenCodeAdapter(options);
    case 'claude-code':
    case 'claude':
      return new ClaudeCodeAdapter(options);
    case 'codex':
      return new CodexAdapter(options);
    default:
      return new BaseIdeAdapter({ ...options, ide: normalized || 'generic-mcp' });
  }
}

function getCompatibilityMatrix() {
  return [
    new AntiGravityAdapter().getCompatibilityDescriptor(),
    new OpenCodeAdapter().getCompatibilityDescriptor(),
    new ClaudeCodeAdapter().getCompatibilityDescriptor(),
    new CodexAdapter().getCompatibilityDescriptor(),
    new BaseIdeAdapter().getCompatibilityDescriptor()
  ];
}

module.exports = {
  BaseIdeAdapter,
  AntiGravityAdapter,
  OpenCodeAdapter,
  ClaudeCodeAdapter,
  CodexAdapter,
  createAdapter,
  getCompatibilityMatrix
};
