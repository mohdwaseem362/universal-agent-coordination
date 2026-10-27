'use strict';

const { CoordinatorService, CoordinatorError, LifecycleError, SecurityError } = require('./coordinator/coordinator');
const { CoordinationDatabase, DatabaseError } = require('./database/db');
const { TASK_STATES, VALID_PRIORITIES, PERMITTED_TRANSITIONS, canTransition, assertTransition } = require('./coordinator/state-machine');
const { redactSecrets, validateAndNormalizeScope, wrapUntrustedPeerMessage } = require('./coordinator/security');
const { scopesOverlap, computeBaselineHashes, detectExternalModifications } = require('./ownership/ownership-guard');
const { checkFilesAgainstLeases, installGitPreCommitHook } = require('./ownership/git-hook');
const { evaluateCompletionGates } = require('./verification/verifier');
const { UacMcpServer, MCP_TOOLS } = require('./mcp/server');
const {
  BaseIdeAdapter,
  AntiGravityAdapter,
  OpenCodeAdapter,
  ClaudeCodeAdapter,
  CodexAdapter,
  createAdapter,
  getCompatibilityMatrix
} = require('./adapters');
const { UacInstaller, SENTINEL_START, SENTINEL_END, generateSentinelInstructionBlock } = require('./installer/installer');
const { collectDashboardState, renderTerminalDashboard, writeHtmlDashboardSnapshot } = require('./dashboard/dashboard');

module.exports = {
  CoordinatorService,
  CoordinatorError,
  LifecycleError,
  SecurityError,
  CoordinationDatabase,
  DatabaseError,
  TASK_STATES,
  VALID_PRIORITIES,
  PERMITTED_TRANSITIONS,
  canTransition,
  assertTransition,
  redactSecrets,
  validateAndNormalizeScope,
  wrapUntrustedPeerMessage,
  scopesOverlap,
  computeBaselineHashes,
  detectExternalModifications,
  checkFilesAgainstLeases,
  installGitPreCommitHook,
  evaluateCompletionGates,
  UacMcpServer,
  MCP_TOOLS,
  BaseIdeAdapter,
  AntiGravityAdapter,
  OpenCodeAdapter,
  ClaudeCodeAdapter,
  CodexAdapter,
  createAdapter,
  getCompatibilityMatrix,
  UacInstaller,
  SENTINEL_START,
  SENTINEL_END,
  generateSentinelInstructionBlock,
  collectDashboardState,
  renderTerminalDashboard,
  writeHtmlDashboardSnapshot
};
