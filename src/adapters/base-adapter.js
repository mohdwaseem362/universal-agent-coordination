'use strict';

/**
 * Consistent IDE Adapter interface for Universal Agent Coordination (UAC).
 * Connects an IDE agent session (AntiGravity, OpenCode, Claude Code, Codex, or generic MCP client)
 * to the CoordinatorService and documents exact capability support and limitations.
 */

const FOLLOW_PROTOCOL_REGEX = /(?:^|\s)(?:@followprotocol|\/followprotocol)\b\s*(.*)$/is;

class BaseIdeAdapter {
  constructor(options = {}) {
    this.ide = options.ide || 'generic-mcp';
    this.displayName = options.displayName || 'Generic MCP Client';
    this.agentId = options.agentId || `${this.ide}-agent`;
    this.agentName = options.agentName || `${this.displayName} Session`;
    this.role = options.role || 'general';
    this.coordinator = options.coordinator || null;
    this.sessionToken = null;
  }

  /**
   * Parses whether a user prompt invokes `@followprotocol <task>` or `/followprotocol <task>`.
   */
  static parseTrigger(userPrompt) {
    if (typeof userPrompt !== 'string') {
      return { triggered: false, taskPrompt: '' };
    }
    const match = userPrompt.match(FOLLOW_PROTOCOL_REGEX);
    if (!match) {
      return { triggered: false, taskPrompt: '' };
    }
    return {
      triggered: true,
      triggerToken: userPrompt.includes('/followprotocol') ? '/followprotocol' : '@followprotocol',
      taskPrompt: (match[1] || '').trim()
    };
  }

  getCompatibilityDescriptor() {
    return {
      ide: this.ide,
      display_name: this.displayName,
      skill_discovery: 'PARTIAL',
      instruction_files: ['AGENTS.md'],
      mcp_transport: 'stdio',
      custom_command_support: 'FALLBACK_CONVENTION',
      physical_file_lock_enforcement: 'ADVISORY_PLUS_GIT_HOOK',
      verification_status: 'SIMULATED_CLIENT_VERIFIED',
      unsupported_capabilities: this.getUnsupportedCapabilities()
    };
  }

  getUnsupportedCapabilities() {
    return [
      'Automatic background push notifications without agent polling (MCP stdio is request/response driven; agents must call read_messages or list_tasks at step boundaries).',
      'OS-kernel mandatory file locking against raw bash/filesystem writes (enforced via MCP claim_resource checks, SHA-256 baseline dirty-tree verification, and Git pre-commit hook).'
    ];
  }

  async connect(coordinator) {
    if (coordinator) {
      this.coordinator = coordinator;
    }
    if (!this.coordinator) {
      return {
        connected: false,
        mode: 'LEVEL_1_SKILL_ONLY',
        warning:
          'Coordinator unavailable. Operating in Level 1 (single-agent skill-only fallback). Cross-IDE task claiming, messaging, and resource leases are disabled.'
      };
    }

    const reg = await this.coordinator.registerAgent({
      agent_id: this.agentId,
      name: this.agentName,
      ide: this.ide,
      role: this.role,
      capabilities: ['mcp-tools', 'followprotocol', 'resource-leases', 'verification-gates']
    });
    this.sessionToken = reg.session_token;
    return {
      connected: true,
      mode: 'LEVEL_2_COORDINATED',
      agent: reg
    };
  }

  _requireCoordinator() {
    if (!this.coordinator) {
      throw new Error(
        `[${this.ide}] Cross-IDE coordinator is not connected. Cannot perform shared coordination operation.`
      );
    }
  }

  async discoverTasks(filter = {}) {
    this._requireCoordinator();
    return this.coordinator.listTasks(filter);
  }

  async createAndClaimTask({ title, description, acceptanceCriteria = [], priority = 'HIGH', scopes = [], requireIndependentReview = false }) {
    this._requireCoordinator();
    return this.coordinator.createTask({
      title,
      description,
      acceptance_criteria: acceptanceCriteria,
      priority,
      created_by: this.agentId,
      session_token: this.sessionToken,
      auto_claim: true,
      scopes,
      require_independent_review: requireIndependentReview,
      require_test_execution: true
    });
  }

  async claimTask(taskId, scopes = []) {
    this._requireCoordinator();
    return this.coordinator.claimTask({
      task_id: taskId,
      agent_id: this.agentId,
      session_token: this.sessionToken,
      scopes
    });
  }

  async joinExistingTask(taskId, subtaskSpec = null) {
    this._requireCoordinator();
    return this.coordinator.joinTask({
      task_id: taskId,
      agent_id: this.agentId,
      session_token: this.sessionToken,
      role: this.role,
      create_subtask: subtaskSpec
    });
  }

  async updateStatus(taskId, status, progressNote = '', blockerReason = null) {
    this._requireCoordinator();
    return this.coordinator.updateTaskStatus({
      task_id: taskId,
      agent_id: this.agentId,
      session_token: this.sessionToken,
      status,
      progress_note: progressNote,
      blocker_reason: blockerReason
    });
  }

  async sendMessage({ taskId, recipientAgentId = null, messageType = 'FINDING', content, replyToMessageId = null }) {
    this._requireCoordinator();
    return this.coordinator.postMessage({
      task_id: taskId,
      sender_agent_id: this.agentId,
      session_token: this.sessionToken,
      recipient_agent_id: recipientAgentId,
      message_type: messageType,
      reply_to_message_id: replyToMessageId,
      content
    });
  }

  async readMessages(filter = {}) {
    this._requireCoordinator();
    return this.coordinator.readMessages(filter);
  }

  async claimResource(taskId, scope, mode = 'EXCLUSIVE') {
    this._requireCoordinator();
    return this.coordinator.claimResource({
      agent_id: this.agentId,
      session_token: this.sessionToken,
      task_id: taskId,
      scope,
      mode
    });
  }

  async releaseResource(taskId, scope) {
    this._requireCoordinator();
    return this.coordinator.releaseResource({
      agent_id: this.agentId,
      session_token: this.sessionToken,
      task_id: taskId,
      scope
    });
  }

  async requestHandoff({ taskId, toAgentId, scopes = [], summary }) {
    this._requireCoordinator();
    return this.coordinator.requestHandoff({
      task_id: taskId,
      from_agent_id: this.agentId,
      to_agent_id: toAgentId,
      session_token: this.sessionToken,
      scopes,
      summary,
      auto_accept: true
    });
  }

  async recordDecision({ taskId, topic, decision, rationale = '', supersedesDecisionId = null }) {
    this._requireCoordinator();
    return this.coordinator.recordDecision({
      task_id: taskId,
      author_agent_id: this.agentId,
      session_token: this.sessionToken,
      topic,
      decision,
      rationale,
      supersedes_decision_id: supersedesDecisionId
    });
  }

  async reportTestResults({ taskId, command, exitCode, passedCount, failedCount, outputSummary }) {
    this._requireCoordinator();
    return this.coordinator.reportTestResults({
      task_id: taskId,
      agent_id: this.agentId,
      session_token: this.sessionToken,
      command,
      exit_code: exitCode,
      passed: exitCode === 0 && failedCount === 0,
      passed_count: passedCount,
      failed_count: failedCount,
      output_summary: outputSummary
    });
  }

  async submitReview({ taskId, approved, findingsSummary }) {
    this._requireCoordinator();
    return this.coordinator.submitReview({
      task_id: taskId,
      reviewer_agent_id: this.agentId,
      session_token: this.sessionToken,
      approved,
      findings_summary: findingsSummary
    });
  }

  async verifyCompletion(taskId) {
    this._requireCoordinator();
    return this.coordinator.verifyCompletion({
      task_id: taskId,
      agent_id: this.agentId,
      session_token: this.sessionToken
    });
  }
}

module.exports = {
  BaseIdeAdapter,
  FOLLOW_PROTOCOL_REGEX
};
