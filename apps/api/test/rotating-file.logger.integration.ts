import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { LOG_FILE_MAX_BYTES, RotatingFileLogger } from '../src/rotating-file.logger';

const directories: string[] = [];

after(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

test('technical log files rotate before exceeding the configured per-file size', () => {
  assert.equal(LOG_FILE_MAX_BYTES, 200 * 1024 * 1024);
  const directory = mkdtempSync(join(tmpdir(), 'sync-logs-'));
  directories.push(directory);
  const logger = new RotatingFileLogger(directory, 240);
  logger.log('first operational message', 'test');
  logger.warn('second operational message', 'test');
  logger.error('third operational message', undefined, 'test');

  const files = readdirSync(directory).filter((name) => name.endsWith('.log'));
  assert.ok(files.length >= 2, 'writing beyond the threshold creates a rotated file');
  assert.ok(files.every((name) => statSync(join(directory, name)).size <= 240));
  assert.ok(files.some((name) => readFileSync(join(directory, name), 'utf8').includes('"level":"error"')));
});

test('operational log categories can be kept in separate rotating files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sync-categories-'));
  directories.push(directory);
  new RotatingFileLogger(directory, 1_000, 'manual-review.log').warn('manual decision', 'MANUAL');
  new RotatingFileLogger(directory, 1_000, 'events.log').log('accepted event', 'EVENT');
  const files = readdirSync(directory).sort();
  assert.deepEqual(files, ['events.log', 'manual-review.log']);
  assert.match(readFileSync(join(directory, 'manual-review.log'), 'utf8'), /manual decision/);
  assert.match(readFileSync(join(directory, 'events.log'), 'utf8'), /accepted event/);
});
