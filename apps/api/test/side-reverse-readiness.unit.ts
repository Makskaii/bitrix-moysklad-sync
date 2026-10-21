import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { evaluateEnablePreflight, EnablePreflightInput } from '../src/sync-mode-preflight';

function fixture(): EnablePreflightInput {
  return {
    entityKey: 'deals-orders', direction: 'moyskladToBitrix24', apiAccess: true, webhookAuthConfigured: true,
    applicableStages: ['stage', 'unused-stage'], applicableCurrencies: ['rub', 'unused-currency'],
    settings: { version: 2, config: { rules: [], references: { namedPairs: [
      { kind: 'dealStages', bitrix24Id: '0:PREPARATION', moyskladId: 'stage', status: 'confirmed' },
      { kind: 'currencies', bitrix24Id: 'RUB', moyskladId: 'rub', status: 'confirmed' },
    ] }, dealOrderRuntime: { stages: [{ bitrix24StageId: 'PREPARATION', moyskladId: 'stage' }],
      currencies: [{ bitrix24Code: 'RUB', moyskladId: 'rub' }] } } },
  };
}

test('confirmed selected reverse scope enables without mapping unused provider entries', () => {
  const report = evaluateEnablePreflight(fixture());
  assert.equal(report.canEnable, true);
  assert.equal(report.warnings.length, 2);
});

test('missing, duplicate or contradictory selected stages remain blocked', () => {
  for (const change of ['missing', 'duplicate', 'contradictory']) {
    const input = fixture();
    const runtime = input.settings!.config.dealOrderRuntime as any;
    if (change === 'missing') input.applicableStages = ['unused-stage'];
    if (change === 'duplicate') runtime.stages.push({ ...runtime.stages[0] });
    if (change === 'contradictory') runtime.stages[0].bitrix24StageId = 'WON';
    assert.equal(evaluateEnablePreflight(input).canEnable, false, change);
  }
});

test('unconfirmed or ambiguous currency and absent API/auth remain blocked', () => {
  for (const change of ['missing', 'duplicate', 'unconfirmed', 'api', 'auth']) {
    const input = fixture();
    const runtime = input.settings!.config.dealOrderRuntime as any;
    if (change === 'missing') input.applicableCurrencies = ['unused-currency'];
    if (change === 'duplicate') runtime.currencies.push({ ...runtime.currencies[0] });
    if (change === 'unconfirmed') (input.settings!.config.references as any).namedPairs[1].status = 'suggested';
    if (change === 'api') input.apiAccess = false;
    if (change === 'auth') input.webhookAuthConfigured = false;
    assert.equal(evaluateEnablePreflight(input).canEnable, false, change);
  }
});

test('empty selected scope is never ready', () => {
  const input = fixture();
  input.settings!.config.dealOrderRuntime = { stages: [], currencies: [] };
  assert.equal(evaluateEnablePreflight(input).canEnable, false);
});
