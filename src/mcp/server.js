#!/usr/bin/env node
'use strict';

const readline = require('node:readline');
const { CoordinatorService } = require('../coordinator/coordinator');

/**
 * Tool definitions following the Model Context Protocol (MCP) specification.
 * Includes inputSchema, outputSchema, authorization rules, idempotency behavior,
 * and error semantics for all 17 coordination tools.
 */
const MCP_TOOLS = [
  {
    name: 'register_agent',
    description: 'Registers or refreshes an IDE coding agent session with the shared UAC coordinator.',
    authorization: 'Requires valid workspace_token if workspace token enforcement is enabled.',
    idempotent: true,
    inputSchema: {
      type: 'object',
      required: ['name', 'ide'],
      properties: {
        agent_id: { type: 'string', description: 'Optional stable agent identifier.' },
        name: { type: 'string', description: 'Human-readable agent session name.' },
        ide: { type: 'string', description: 'IDE or client identifier (e.g., antigravity, opencode, claude-code, codex).' },
        role: { type: 'string', description: 'Agent specialty role (e.g., implementation, testing, security-review).' },
        capabilities: { type: 'array', items: { type: 'string' } },
        workspace_token: { type: 'string', description: 'Optional local workspace authentication token.' }
      }
    },
    outputSchema: {
      type: 'object',
      required: ['agent_id', 'status', 'session_token'],
      properties: {
        agent_id: { type: 'string' },
        name: { type: 'string' },
        ide: { type: 'string' },
        role: { type: 'string' },
        status: { type: 'string' },
        session_token: { type: 'string' }
      }
    }
  },
  {
    name: 'get_agent_status',
    description: 'Lists active/stale agents, their heartbeats, owned tasks, and active resource leases.',
    authorization: 'Read-only within local workspace.',
    idempotent: true,
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string' },
        include_all: { type: 'boolean', default: true }
      }
    },
    outputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'object' },
        agents: { type: 'array', items: { type: 'object' } }
      }
    }
  },
  {
    name: 'create_task',
    description: 'Creates a new shared task or subtask with acceptance criteria, priority, dependencies, and completion gate rules.',
    authorization: 'Requires registered created_by agent_id.',
    idempotent: true,
    inputSchema: {
      type: 'object',
      required: ['title', 'created_by'],
      properties: {
        task_id: { type: 'string' },
        parent_task_id: { type: ['string', 'null'] },
        title: { type: 'string' },
        description: { type: 'string' },
        acceptance_criteria: { type: 'array', items: { type: 'string' } },
        priority: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
        created_by: { type: 'string' },
        session_token: { type: 'string' },
        dependencies: { type: 'array', items: { type: 'string' } },
        require_independent_review: { type: 'boolean' },
        require_test_execution: { type: 'boolean' },
        auto_claim: { type: 'boolean' },
        scopes: { type: 'array', items: { type: 'string' } }
      }
    },
    outputSchema: {
      type: 'object',
      required: ['task_id', 'status', 'version'],
      properties: {
        task_id: { type: 'string' },
        title: { type: 'string' },
        status: { type: 'string' },
        owner_agent_id: { type: ['string', 'null'] },
        version: { type: 'integer' }
      }
    }
  },
  {
    name: 'list_tasks',
    description: 'Queries the shared task board by status, owner, parent task, or keyword search.',
    authorization: 'Read-only within local workspace.',
    idempotent: true,
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string' },
        owner_agent_id: { type: 'string' },
        parent_task_id: { type: ['string', 'null'] },
        search: { type: 'string' }
      }
    },
    outputSchema: {
      type: 'object',
      required: ['tasks'],
      properties: {
        tasks: { type: 'array', items: { type: 'object' } }
      }
    }
  },
  {
    name: 'claim_task',
    description: 'Atomically claims an OPEN task and optionally reserves exclusive file/directory scopes.',
    authorization: 'Requires registered agent_id; rejects if already owned by another active agent.',
    idempotent: true,
    inputSchema: {
      type: 'object',
      required: ['task_id', 'agent_id'],
      properties: {
        task_id: { type: 'string' },
        agent_id: { type: 'string' },
        session_token: { type: 'string' },
        scopes: { type: 'array', items: { type: 'string' } },
        ttl_seconds: { type: 'integer' },
        expected_version: { type: 'integer' }
      }
    },
    outputSchema: {
      type: 'object',
      required: ['task_id', 'status', 'owner_agent_id'],
      properties: {
        task_id: { type: 'string' },
        status: { type: 'string' },
        owner_agent_id: { type: 'string' },
        claimed_scopes: { type: 'array', items: { type: 'string' } }
      }
    }
  },
  {
    name: 'join_task',
    description: 'Joins an existing task as a collaborating IDE agent and optionally creates a non-overlapping subtask.',
    authorization: 'Requires registered agent_id.',
    idempotent: true,
    inputSchema: {
      type: 'object',
      required: ['task_id', 'agent_id'],
      properties: {
        task_id: { type: 'string' },
        agent_id: { type: 'string' },
        session_token: { type: 'string' },
        role: { type: 'string' },
        create_subtask: {
          type: 'object',
          properties: {
            task_id: { type: 'string' },
            title: { type: 'string' },
            description: { type: 'string' },
            scopes: { type: 'array', items: { type: 'string' } },
            auto_claim: { type: 'boolean' }
          }
        }
      }
    },
    outputSchema: {
      type: 'object',
      required: ['joined_task', 'messages', 'decisions'],
      properties: {
        joined_task: { type: 'object' },
        subtask: { type: ['object', 'null'] },
        messages: { type: 'array', items: { type: 'object' } },
        decisions: { type: 'array', items: { type: 'object' } }
      }
    }
  },
  {
    name: 'update_task_status',
    description: 'Transitions a task through the state machine (OPEN, CLAIMED, IN_PROGRESS, REVIEW, VERIFYING, BLOCKED, FAILED, CANCELLED). Cannot jump directly to DONE.',
    authorization: 'Requires task owner or registered task participant.',
    idempotent: false,
    inputSchema: {
      type: 'object',
      required: ['task_id', 'agent_id', 'status'],
      properties: {
        task_id: { type: 'string' },
        agent_id: { type: 'string' },
        session_token: { type: 'string' },
        status: {
          type: 'string',
          enum: ['OPEN', 'CLAIMED', 'IN_PROGRESS', 'REVIEW', 'VERIFYING', 'BLOCKED', 'FAILED', 'CANCELLED']
        },
        progress_note: { type: 'string' },
        blocker_reason: { type: 'string' },
        expected_version: { type: 'integer' }
      }
    },
    outputSchema: {
      type: 'object',
      required: ['task_id', 'status', 'version'],
      properties: {
        task_id: { type: 'string' },
        status: { type: 'string' },
        version: { type: 'integer' }
      }
    }
  },
  {
    name: 'post_message',
    description: 'Posts a secret-redacted message (FINDING, PLAN, QUESTION, ANSWER, BLOCKER, HANDOFF, REVIEW, STATUS_UPDATE) to shared state.',
    authorization: 'Requires registered sender_agent_id.',
    idempotent: false,
    inputSchema: {
      type: 'object',
      required: ['sender_agent_id', 'content'],
      properties: {
        task_id: { type: ['string', 'null'] },
        sender_agent_id: { type: 'string' },
        session_token: { type: 'string' },
        recipient_agent_id: { type: ['string', 'null'] },
        message_type: {
          type: 'string',
          enum: ['QUESTION', 'ANSWER', 'FINDING', 'PLAN', 'BLOCKER', 'HANDOFF', 'REVIEW', 'STATUS_UPDATE']
        },
        reply_to_message_id: { type: ['string', 'null'] },
        content: { type: 'string' }
      }
    },
    outputSchema: {
      type: 'object',
      required: ['message_id', 'content', 'trust_boundary'],
      properties: {
        message_id: { type: 'string' },
        content: { type: 'string' },
        redacted: { type: 'integer' },
        trust_boundary: { type: 'string' }
      }
    }
  },
  {
    name: 'read_messages',
    description: 'Reads coordination messages wrapped in an explicit untrusted-peer-data envelope.',
    authorization: 'Read-only within local workspace.',
    idempotent: true,
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        recipient_agent_id: { type: 'string' },
        message_type: { type: 'string' },
        since: { type: 'string' },
        limit: { type: 'integer' }
      }
    },
    outputSchema: {
      type: 'object',
      required: ['messages'],
      properties: {
        messages: { type: 'array', items: { type: 'object' } }
      }
    }
  },
  {
    name: 'ask_agent',
    description: 'Sends a structured QUESTION message to another collaborating agent on a task.',
    authorization: 'Requires registered sender_agent_id.',
    idempotent: false,
    inputSchema: {
      type: 'object',
      required: ['sender_agent_id', 'question'],
      properties: {
        task_id: { type: 'string' },
        sender_agent_id: { type: 'string' },
        session_token: { type: 'string' },
        recipient_agent_id: { type: 'string' },
        question: { type: 'string' }
      }
    },
    outputSchema: {
      type: 'object',
      required: ['message_id', 'message_type'],
      properties: {
        message_id: { type: 'string' },
        message_type: { type: 'string' }
      }
    }
  },
  {
    name: 'record_decision',
    description: 'Records an authoritative technical or API contract decision, optionally superseding an older decision.',
    authorization: 'Requires registered author_agent_id.',
    idempotent: false,
    inputSchema: {
      type: 'object',
      required: ['author_agent_id', 'topic', 'decision'],
      properties: {
        task_id: { type: 'string' },
        author_agent_id: { type: 'string' },
        session_token: { type: 'string' },
        topic: { type: 'string' },
        decision: { type: 'string' },
        rationale: { type: 'string' },
        supersedes_decision_id: { type: 'string' }
      }
    },
    outputSchema: {
      type: 'object',
      required: ['decision_id', 'status'],
      properties: {
        decision_id: { type: 'string' },
        topic: { type: 'string' },
        decision: { type: 'string' },
        status: { type: 'string' }
      }
    }
  },
  {
    name: 'request_handoff',
    description: 'Initiates or completes an explicit task and resource lease handoff from the current owner to another agent.',
    authorization: 'Requires current task owner (`from_agent_id`).',
    idempotent: false,
    inputSchema: {
      type: 'object',
      required: ['task_id', 'from_agent_id', 'summary'],
      properties: {
        task_id: { type: 'string' },
        from_agent_id: { type: 'string' },
        to_agent_id: { type: 'string' },
        session_token: { type: 'string' },
        scopes: { type: 'array', items: { type: 'string' } },
        summary: { type: 'string' },
        auto_accept: { type: 'boolean', default: true }
      }
    },
    outputSchema: {
      type: 'object',
      required: ['handoff_id', 'status'],
      properties: {
        handoff_id: { type: 'string' },
        task_id: { type: 'string' },
        from_agent_id: { type: 'string' },
        to_agent_id: { type: ['string', 'null'] },
        status: { type: 'string' }
      }
    }
  },
  {
    name: 'claim_resource',
    description: 'Acquires an exclusive or shared-read lease on a file, directory, or glob scope. Rejects overlapping scopes held by other agents.',
    authorization: 'Requires registered agent_id.',
    idempotent: true,
    inputSchema: {
      type: 'object',
      required: ['agent_id', 'task_id', 'scope'],
      properties: {
        agent_id: { type: 'string' },
        session_token: { type: 'string' },
        task_id: { type: 'string' },
        scope: { type: 'string' },
        mode: { type: 'string', enum: ['EXCLUSIVE', 'SHARED_READ'] },
        ttl_seconds: { type: 'integer' }
      }
    },
    outputSchema: {
      type: 'object',
      required: ['lease_id', 'scope_pattern', 'owner_agent_id', 'expires_at'],
      properties: {
        lease_id: { type: 'string' },
        scope_pattern: { type: 'string' },
        owner_agent_id: { type: 'string' },
        expires_at: { type: 'string' }
      }
    }
  },
  {
    name: 'release_resource',
    description: 'Releases an active resource lease held by the calling agent.',
    authorization: 'Requires lease owner (`agent_id`).',
    idempotent: true,
    inputSchema: {
      type: 'object',
      required: ['agent_id', 'scope'],
      properties: {
        agent_id: { type: 'string' },
        session_token: { type: 'string' },
        task_id: { type: 'string' },
        scope: { type: 'string' }
      }
    },
    outputSchema: {
      type: 'object',
      required: ['released', 'scope'],
      properties: {
        released: { type: 'boolean' },
        scope: { type: 'string' }
      }
    }
  },
  {
    name: 'report_test_results',
    description: 'Records executable test verification results (command, exit code, pass/fail counts, output summary) for a task.',
    authorization: 'Requires registered agent_id.',
    idempotent: false,
    inputSchema: {
      type: 'object',
      required: ['task_id', 'agent_id', 'command'],
      properties: {
        task_id: { type: 'string' },
        agent_id: { type: 'string' },
        session_token: { type: 'string' },
        command: { type: 'string' },
        exit_code: { type: 'integer' },
        passed: { type: 'boolean' },
        passed_count: { type: 'integer' },
        failed_count: { type: 'integer' },
        output_summary: { type: 'string' },
        artifact_hashes: { type: 'object' }
      }
    },
    outputSchema: {
      type: 'object',
      required: ['evidence_id', 'passed'],
      properties: {
        evidence_id: { type: 'string' },
        task_id: { type: 'string' },
        passed: { type: 'integer' },
        exit_code: { type: 'integer' }
      }
    }
  },
  {
    name: 'submit_review',
    description: 'Records an independent code/security review verdict for a task. Self-review by the task owner is rejected when independent review is required.',
    authorization: 'Requires registered reviewer_agent_id distinct from task owner when require_independent_review is enabled.',
    idempotent: false,
    inputSchema: {
      type: 'object',
      required: ['task_id', 'reviewer_agent_id', 'approved', 'findings_summary'],
      properties: {
        task_id: { type: 'string' },
        reviewer_agent_id: { type: 'string' },
        session_token: { type: 'string' },
        approved: { type: 'boolean' },
        findings_summary: { type: 'string' }
      }
    },
    outputSchema: {
      type: 'object',
      required: ['evidence_id', 'passed'],
      properties: {
        evidence_id: { type: 'string' },
        task_id: { type: 'string' },
        passed: { type: 'integer' }
      }
    }
  },
  {
    name: 'verify_completion',
    description: 'Evaluates all completion gates (dependencies, subtasks, blockers, test execution evidence, independent review) and marks the task DONE only if all gates pass.',
    authorization: 'Requires registered agent_id.',
    idempotent: true,
    inputSchema: {
      type: 'object',
      required: ['task_id', 'agent_id'],
      properties: {
        task_id: { type: 'string' },
        agent_id: { type: 'string' },
        session_token: { type: 'string' }
      }
    },
    outputSchema: {
      type: 'object',
      required: ['completed', 'task', 'gate_evaluation'],
      properties: {
        completed: { type: 'boolean' },
        task: { type: 'object' },
        gate_evaluation: { type: 'object' }
      }
    }
  }
];

class UacMcpServer {
  constructor(options = {}) {
    this.coordinator =
      options.coordinator ||
      new CoordinatorService({
        workspaceRoot: options.workspaceRoot || process.env.UAC_WORKSPACE_ROOT || process.cwd(),
        dbPath: options.dbPath || process.env.UAC_DB_PATH
      });
  }

  async init() {
    await this.coordinator.init();
    return this;
  }

  async close() {
    await this.coordinator.close();
  }

  async callTool(name, args = {}) {
    switch (name) {
      case 'register_agent':
        return this.coordinator.registerAgent(args);
      case 'get_agent_status':
        return this.coordinator.getAgentStatus(args);
      case 'create_task':
        return this.coordinator.createTask(args);
      case 'list_tasks':
        return this.coordinator.listTasks(args);
      case 'claim_task':
        return this.coordinator.claimTask(args);
      case 'join_task':
        return this.coordinator.joinTask(args);
      case 'update_task_status':
        return this.coordinator.updateTaskStatus(args);
      case 'post_message':
        return this.coordinator.postMessage(args);
      case 'read_messages':
        return this.coordinator.readMessages(args);
      case 'ask_agent':
        return this.coordinator.askAgent(args);
      case 'record_decision':
        return this.coordinator.recordDecision(args);
      case 'request_handoff':
        return this.coordinator.requestHandoff(args);
      case 'claim_resource':
        return this.coordinator.claimResource(args);
      case 'release_resource':
        return this.coordinator.releaseResource(args);
      case 'report_test_results':
        return this.coordinator.reportTestResults(args);
      case 'submit_review':
        return this.coordinator.submitReview(args);
      case 'verify_completion':
        return this.coordinator.verifyCompletion(args);
      default:
        throw Object.assign(new Error(`Unknown MCP tool: ${name}`), { code: 'UNKNOWN_TOOL' });
    }
  }

  async handleRpcRequest(req) {
    if (!req || typeof req !== 'object') {
      return {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid Request' }
      };
    }

    const { id, method, params } = req;

    try {
      if (method === 'initialize') {
        await this.init();
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {
              tools: { listChanged: false }
            },
            serverInfo: {
              name: 'universal-agent-coordination',
              version: '1.0.0'
            }
          }
        };
      }

      if (method === 'notifications/initialized') {
        return null; // Notification produces no response
      }

      if (method === 'ping') {
        return { jsonrpc: '2.0', id, result: {} };
      }

      if (method === 'tools/list') {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: MCP_TOOLS
          }
        };
      }

      if (method === 'tools/call') {
        const toolName = params && params.name;
        const toolArgs = (params && params.arguments) || {};
        if (!toolName) {
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32602, message: 'Missing tool name in tools/call' }
          };
        }

        try {
          const data = await this.callTool(toolName, toolArgs);
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(data, null, 2)
                }
              ],
              structuredContent: data,
              isError: false
            }
          };
        } catch (toolErr) {
          const errorPayload = {
            error: true,
            code: toolErr.code || 'TOOL_EXECUTION_ERROR',
            message: toolErr.message,
            details: toolErr.details || {}
          };
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(errorPayload, null, 2)
                }
              ],
              structuredContent: errorPayload,
              isError: true
            }
          };
        }
      }

      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` }
      };
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: err.message || 'Internal error'
        }
      };
    }
  }

  startStdio() {
    const rl = readline.createInterface({
      input: process.stdin,
      crlfDelay: Infinity
    });

    rl.on('line', async (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch (_) {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'Parse error' }
          }) + '\n'
        );
        return;
      }

      const response = await this.handleRpcRequest(parsed);
      if (response) {
        process.stdout.write(JSON.stringify(response) + '\n');
      }
    });
  }
}

if (require.main === module) {
  const server = new UacMcpServer();
  server.startStdio();
}

module.exports = {
  UacMcpServer,
  MCP_TOOLS
};
