import { mkdirSync, readdirSync, renameSync, statSync, appendFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { LoggerService } from '@nestjs/common';

export const LOG_FILE_MAX_BYTES = 200 * 1024 * 1024;

export class RotatingFileLogger implements LoggerService {
  private readonly directory: string;
  private readonly fileName: string;

  constructor(directory = process.env.LOG_DIRECTORY ?? 'logs', private readonly maxBytes = LOG_FILE_MAX_BYTES, fileName = 'application.log') {
    this.directory = resolve(directory);
    this.fileName = join(this.directory, fileName);
    mkdirSync(this.directory, { recursive: true });
  }

  log(message: unknown, context?: string) { this.write('info', message, context); }
  error(message: unknown, _trace?: string, context?: string) { this.write('error', message, context); }
  warn(message: unknown, context?: string) { this.write('warn', message, context); }
  debug(message: unknown, context?: string) { this.write('debug', message, context); }
  verbose(message: unknown, context?: string) { this.write('verbose', message, context); }
  fatal(message: unknown, context?: string) { this.write('fatal', message, context); }

  private write(level: string, message: unknown, context?: string) {
    const safeMessage = String(message)
      .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, '$1[redacted]')
      .replace(/(access_token|application_token|token|secret|password)([=: ]+)[^\s&;,]+/gi, '$1$2[redacted]')
      .slice(0, 8_000);
    const line = `${JSON.stringify({ at: new Date().toISOString(), level, context, message: safeMessage })}\n`;
    const size = Buffer.byteLength(line);
    let existingSize = 0;
    try { existingSize = statSync(this.fileName).size; } catch { /* File is created on first write. */ }
    if (existingSize > 0 && existingSize + size > this.maxBytes) this.rotate();
    appendFileSync(this.fileName, line, { encoding: 'utf8', flag: 'a' });
  }

  private rotate() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const existing = new Set(readdirSync(this.directory));
    let suffix = 0;
    const base = basename(this.fileName, '.log');
    let rotatedName = `${base}-${timestamp}.log`;
    while (existing.has(rotatedName)) rotatedName = `${base}-${timestamp}-${++suffix}.log`;
    renameSync(this.fileName, join(this.directory, basename(rotatedName)));
  }
}
