import { strict as assert } from 'node:assert';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { resolveApiBindHost } from '../src/api-bind-host';

test('API bind host defaults to all interfaces and accepts an explicit loopback address', () => {
  assert.equal(resolveApiBindHost(undefined), '0.0.0.0');
  assert.equal(resolveApiBindHost('127.0.0.1'), '127.0.0.1');
  assert.equal(resolveApiBindHost('::1'), '::1');
});

test('API listener can bind only the configured loopback interface', async () => {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, resolveApiBindHost('127.0.0.1'), resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    assert.equal(address.address, '127.0.0.1');
  } finally {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('invalid API bind hosts fail closed instead of falling back to all interfaces', () => {
  for (const host of ['', 'localhost', '127.0.0.1/24', ' 127.0.0.1']) {
    assert.throws(() => resolveApiBindHost(host), /API_BIND_HOST must be an IPv4 or IPv6 address/);
  }
});
