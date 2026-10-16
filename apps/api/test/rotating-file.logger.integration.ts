import { strict as assert } from 'node:assert';
import { closeSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, truncateSync } from 'node:fs';
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

test('a file already at the 200 MB production boundary rotates without allocating a large test buffer', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sync-logs-boundary-'));
  directories.push(directory);
  const applicationLog = join(directory, 'application.log');
  closeSync(openSync(applicationLog, 'w'));
  truncateSync(applicationLog, LOG_FILE_MAX_BYTES);
  const logger = new RotatingFileLogger(directory);
  logger.log('boundary message', 'test');
  const files = readdirSync(directory).filter((name) => name.endsWith('.log'));
  assert.equal(files.length, 2);
  assert.equal(statSync(applicationLog).size < LOG_FILE_MAX_BYTES, true);
  assert.equal(files.filter((name) => name.startsWith('application-')).length, 1);
});
