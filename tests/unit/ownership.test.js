'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  scopesOverlap,
  computeBaselineHashes,
  detectExternalModifications
} = require('../../src');

test('scopesOverlap accurately detects overlapping vs disjoint file and glob scopes', () => {
  // Overlapping scopes
  assert.equal(scopesOverlap('src/checkout/**', 'src/checkout/PaymentService.ts'), true);
  assert.equal(scopesOverlap('src/checkout/PaymentService.ts', 'src/checkout/**'), true);
  assert.equal(scopesOverlap('src/checkout', 'src/checkout/cart.js'), true);
  assert.equal(scopesOverlap('src/checkout/*.ts', 'src/checkout/PaymentService.ts'), true);
  assert.equal(scopesOverlap('src/**', 'src/checkout/**'), true);

  // Disjoint scopes
  assert.equal(scopesOverlap('src/checkout/**', 'tests/checkout/**'), false);
  assert.equal(scopesOverlap('src/checkout/Cart.ts', 'src/checkout/Payment.ts'), false);
  assert.equal(scopesOverlap('src/checkout/*.ts', 'src/checkout/*.js'), false);
  assert.equal(scopesOverlap('src/vendor/**', 'src/checkout/**'), false);
});

test('computeBaselineHashes and detectExternalModifications identify uncoordinated file edits', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uac-ownership-test-'));
  try {
    const fileA = path.join(tmpDir, 'src', 'checkout', 'service.js');
    fs.mkdirSync(path.dirname(fileA), { recursive: true });
    fs.writeFileSync(fileA, 'module.exports = { total: () => 100 };\n', 'utf8');

    const baseline = computeBaselineHashes('src/checkout/service.js', tmpDir);
    assert.ok(baseline['src/checkout/service.js']);

    // Unchanged -> zero modifications
    assert.deepEqual(detectExternalModifications(baseline, tmpDir), []);

    // Simulate uncoordinated external edit
    fs.writeFileSync(fileA, 'module.exports = { total: () => 999 };\n', 'utf8');
    const modifications = detectExternalModifications(baseline, tmpDir);
    assert.equal(modifications.length, 1);
    assert.equal(modifications[0].file, 'src/checkout/service.js');
    assert.notEqual(modifications[0].baseline_hash, modifications[0].current_hash);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
