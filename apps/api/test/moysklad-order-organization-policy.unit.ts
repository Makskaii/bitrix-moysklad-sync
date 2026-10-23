import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { orderOrganizationDecision } from '../src/deals-orders/moysklad-order-organization-policy';

const reference = (id: string) => ({ organization: { meta: { type: 'organization', href: `https://api.moysklad.ru/api/remap/1.2/entity/organization/${id}` } } });

test('only the two customer-approved native organizations admit order events', () => {
  assert.equal(orderOrganizationDecision(reference('02ada5df-d515-11e2-3c12-7054d21a8d1e')), 'ALLOWED');
  assert.equal(orderOrganizationDecision(reference('a039078a-7cf0-11e7-7a6c-d2a90051dacf')), 'ALLOWED');
  assert.equal(orderOrganizationDecision(reference('00000000-0000-0000-0000-000000000001')), 'EXCLUDED');
});

test('missing, contradictory or foreign organization identity cannot be treated as excluded or allowed', () => {
  assert.equal(orderOrganizationDecision({}), 'UNVERIFIED');
  assert.equal(orderOrganizationDecision({ ...reference('02ada5df-d515-11e2-3c12-7054d21a8d1e'), organization: { id: '00000000-0000-0000-0000-000000000001', ...reference('02ada5df-d515-11e2-3c12-7054d21a8d1e').organization } }), 'UNVERIFIED');
  assert.equal(orderOrganizationDecision({ organization: { meta: { type: 'organization', href: 'https://example.com/api/remap/1.2/entity/organization/02ada5df-d515-11e2-3c12-7054d21a8d1e' } } }), 'UNVERIFIED');
});
