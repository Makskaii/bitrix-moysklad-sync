import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { sanitizeReviewDiagnostic, sanitizeReviewDiagnosticForStorage } from '../src/admin/manual-review-details';

test('email presence/count metadata survives while email values and arbitrary email keys stay redacted', () => {
  const diagnostic = {
    bitrixEmailPresent: false,
    moyskladEmailPresent: true,
    bitrixEmailFieldCount: 2,
    moyskladEmailFieldCount: 1,
    email: 'person@example.test',
    emailValue: 'person@example.test',
  };
  const expected = {
    bitrixEmailPresent: false,
    moyskladEmailPresent: true,
    bitrixEmailFieldCount: 2,
    moyskladEmailFieldCount: 1,
  };
  assert.deepEqual(sanitizeReviewDiagnostic(diagnostic), expected);
  assert.deepEqual(sanitizeReviewDiagnosticForStorage(diagnostic), {
    ...expected,
    email: '[redacted]',
    emailValue: '[redacted]',
  });
});

test('allowlisted email metadata names never allow arbitrary string values through', () => {
  assert.deepEqual(sanitizeReviewDiagnosticForStorage({
    bitrixEmailPresent: 'person@example.test',
    moyskladEmailFieldCount: 'person@example.test',
  }), {
    bitrixEmailPresent: '[redacted]',
    moyskladEmailFieldCount: '[redacted]',
  });
  assert.deepEqual(sanitizeReviewDiagnostic({
    bitrixEmailPresent: 'person@example.test',
    moyskladEmailFieldCount: 'person@example.test',
  }), {});
});
