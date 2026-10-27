'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { validateAndNormalizeScope } = require('../coordinator/security');

/**
 * Converts a normalized scope pattern (such as `src/checkout/**`, `src/checkout/*.ts`,
 * or `src/checkout/PaymentService.ts`) into a canonical prefix/glob descriptor and tests
 * whether two scope patterns can overlap.
 */
function scopeToRegex(scopePattern) {
  const escaped = scopePattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '___DOUBLE_STAR___')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/___DOUBLE_STAR___/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function getBasePrefix(scopePattern) {
  const wildcardIdx = scopePattern.search(/[*?]/);
  if (wildcardIdx === -1) {
    return scopePattern.replace(/\/$/, '');
  }
  const prefix = scopePattern.slice(0, wildcardIdx).replace(/\/$/, '');
  return prefix;
}

/**
 * Determines whether two normalized scope patterns overlap.
 * Examples:
 * - `src/checkout/**` and `src/checkout/PaymentService.ts` -> true
 * - `src/checkout` and `src/checkout/cart.js` -> true
 * - `src/checkout/*.ts` and `src/checkout/PaymentService.ts` -> true
 * - `src/checkout/**` and `tests/checkout/**` -> false
 * - `src/checkout/A.ts` and `src/checkout/B.ts` -> false
 */
function scopesOverlap(scopeA, scopeB) {
  if (scopeA === scopeB) return true;

  const hasWildcardA = /[*?]/.test(scopeA);
  const hasWildcardB = /[*?]/.test(scopeB);

  const regexA = scopeToRegex(scopeA);
  const regexB = scopeToRegex(scopeB);

  if (regexA.test(scopeB) || regexB.test(scopeA)) {
    return true;
  }

  // If neither has wildcards, check directory containment (e.g., `src/checkout` vs `src/checkout/index.ts`)
  if (!hasWildcardA && !hasWildcardB) {
    const cleanA = scopeA.replace(/\/$/, '');
    const cleanB = scopeB.replace(/\/$/, '');
    if (cleanA === cleanB) return true;
    if (cleanA.startsWith(cleanB + '/') || cleanB.startsWith(cleanA + '/')) {
      return true;
    }
    return false;
  }

  // Check if a concrete path matches the other's directory wildcard
  const prefixA = getBasePrefix(scopeA);
  const prefixB = getBasePrefix(scopeB);

  if (scopeA.endsWith('/**') && (scopeB === prefixA || scopeB.startsWith(prefixA + '/'))) {
    return true;
  }
  if (scopeB.endsWith('/**') && (scopeA === prefixB || scopeA.startsWith(prefixB + '/'))) {
    return true;
  }

  // If both are wildcards in the same directory hierarchy, check if their prefixes overlap
  if (hasWildcardA && hasWildcardB) {
    if (!prefixA || !prefixB) return true;
    if (prefixA === prefixB) {
      // Same directory prefix; e.g. `src/checkout/*.ts` vs `src/checkout/*.js` -> check extension if simple `*.ext`
      const extMatchA = scopeA.match(/^\S+\/\*(\.[A-Za-z0-9_]+)$/);
      const extMatchB = scopeB.match(/^\S+\/\*(\.[A-Za-z0-9_]+)$/);
      if (extMatchA && extMatchB && extMatchA[1] !== extMatchB[1]) {
        return false;
      }
      return true;
    }
    if (
      (scopeA.includes('**') && prefixB.startsWith(prefixA + '/')) ||
      (scopeB.includes('**') && prefixA.startsWith(prefixB + '/'))
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Computes SHA-256 hashes of concrete files matching a scope within workspaceRoot
 * so UAC can detect external / uncoordinated modifications (optimistic dirty-tree check).
 */
function computeBaselineHashes(scopePattern, workspaceRoot) {
  const root = path.resolve(workspaceRoot || process.cwd());
  const hashes = {};
  if (/[*?]/.test(scopePattern)) {
    const prefix = getBasePrefix(scopePattern);
    const targetDir = path.join(root, prefix);
    if (fs.existsSync(targetDir) && fs.statSync(targetDir).isDirectory()) {
      const regex = scopeToRegex(scopePattern);
      walkDirectory(targetDir, root, regex, hashes, 64);
    }
  } else {
    const fullPath = path.join(root, scopePattern);
    if (fs.existsSync(fullPath)) {
      const stat = fs.statSync(fullPath);
      if (stat.isFile()) {
        hashes[scopePattern] = hashFileSync(fullPath);
      } else if (stat.isDirectory()) {
        walkDirectory(fullPath, root, null, hashes, 64);
      }
    }
  }
  return hashes;
}

function walkDirectory(dir, root, regex, outHashes, limit) {
  if (Object.keys(outHashes).length >= limit) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.uac') continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      walkDirectory(full, root, regex, outHashes, limit);
    } else if (entry.isFile()) {
      if (!regex || regex.test(rel)) {
        outHashes[rel] = hashFileSync(full);
        if (Object.keys(outHashes).length >= limit) return;
      }
    }
  }
}

function hashFileSync(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex');
  } catch (_) {
    return null;
  }
}

/**
 * Checks whether any baseline-tracked files were modified since lease acquisition.
 */
function detectExternalModifications(baselineHashes, workspaceRoot) {
  const root = path.resolve(workspaceRoot || process.cwd());
  const modified = [];
  for (const [relPath, originalHash] of Object.entries(baselineHashes || {})) {
    if (!originalHash) continue;
    const fullPath = path.join(root, relPath);
    const currentHash = hashFileSync(fullPath);
    if (currentHash !== originalHash) {
      modified.push({
        file: relPath,
        baseline_hash: originalHash,
        current_hash: currentHash
      });
    }
  }
  return modified;
}

module.exports = {
  scopesOverlap,
  scopeToRegex,
  computeBaselineHashes,
  detectExternalModifications,
  validateAndNormalizeScope
};
