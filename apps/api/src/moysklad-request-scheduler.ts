import { AsyncResource } from 'node:async_hooks';
import { Logger } from '@nestjs/common';
import { retryAfterAt } from './provider-failure';

type PendingRequest = { start: () => void; abort: () => void };
type SchedulerOptions = { intervalMs?: number; maxConcurrent?: number; deadlineMs?: number; fallbackCooldownMs?: number };
const MAX_WAITING = 100;
const MAX_COOLDOWN_MS = 60 * 60_000;

/** One shared budget for the configured MS namespace, across all runtime adapters.
 * A request is sent ONCE. Durable domain journals, not this layer, own retries.
 */
export class MoyskladRequestScheduler {
  private readonly queue: PendingRequest[] = [];
  private readonly minimumInterval: number;
  private readonly concurrency: number;
  private readonly deadline: number;
  private readonly fallbackCooldown: number;
  private interval: number;
  private serverInterval = 0;
  private nextStart = 0;
  private blockedUntil = 0;
  private active = 0;
  private successes = 0;
  private timer?: NodeJS.Timeout;
  private lastWarning = 0;
  private readonly logger = new Logger('MoyskladRequestScheduler');

  constructor(private readonly transport: typeof fetch, private readonly base: URL, options: SchedulerOptions = {}) {
    this.minimumInterval = options.intervalMs ?? 250;
    this.interval = this.minimumInterval;
    this.concurrency = options.maxConcurrent ?? 2;
    this.deadline = options.deadlineMs ?? 12_000;
    this.fallbackCooldown = options.fallbackCooldownMs ?? 3_000;
  }

  readonly fetch: typeof fetch = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const prefix = this.base.pathname.replace(/\/$/, '');
    if (url.origin !== this.base.origin || !(url.pathname === prefix || url.pathname.startsWith(prefix + '/'))) return this.transport(input, init);
    const sourceSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    // Queue wait is INSIDE the existing per-request deadline, never added after
    // a mode transaction expired. No delayed JS continuation may send later.
    const signal = AbortSignal.any([...(sourceSignal ? [sourceSignal] : []), AbortSignal.timeout(this.deadline)]);
    const expiresAt = Date.now() + this.deadline;
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.queue.length >= MAX_WAITING) return Promise.reject(new Error('MOYSKLAD_REQUEST_QUEUE_FULL'));
    return new Promise<Response>((resolve, reject) => {
      const entry: PendingRequest = {
        abort: () => {
          const position = this.queue.indexOf(entry);
          if (position !== -1) this.queue.splice(position, 1);
          signal.removeEventListener('abort', entry.abort);
          reject(signal.reason);
          this.pump();
        },
        start: AsyncResource.bind(() => {
          signal.removeEventListener('abort', entry.abort);
          if (signal.aborted || Date.now() >= expiresAt) { reject(signal.reason ?? new DOMException('Request deadline expired', 'TimeoutError')); this.pump(); return; }
          this.active++;
          let finished = false;
          const finish = () => { if (!finished) { finished = true; this.active--; this.pump(); } };
          void Promise.resolve().then(() => {
            signal.throwIfAborted();
            if (Date.now() >= expiresAt) throw new DOMException('Request deadline expired', 'TimeoutError');
            // Anchor spacing to the actual transport start, not the earlier
            // admission microtask (which may itself have been delayed).
            this.nextStart = Date.now() + this.interval;
            return this.transport(input, { ...init, signal });
          }).then((response) => {
            this.observe(response);
            if (signal.aborted) { void response.body?.cancel().catch(() => undefined); finish(); reject(signal.reason); return; }
            resolve(this.withBodyLease(response, signal, finish));
          }).catch((error) => { finish(); reject(error); });
        }),
      };
      signal.addEventListener('abort', entry.abort, { once: true });
      this.queue.push(entry);
      this.pump();
    });
  };

  private pump() {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (!this.queue.length || this.active >= this.concurrency) return;
    const delay = Math.max(this.nextStart, this.blockedUntil) - Date.now();
    if (delay > 0) {
      this.timer = setTimeout(() => { this.timer = undefined; this.pump(); }, delay);
      this.timer.unref(); return;
    }
    const entry = this.queue.shift()!;
    this.nextStart = Date.now() + this.interval;
    entry.start();
    if (this.queue.length && this.active < this.concurrency) this.pump();
  }

  private observe(response: Response) {
    const now = Date.now();
    const limit = integerHeader(response, 'x-ratelimit-limit');
    const window = integerHeader(response, 'x-lognex-retry-timeinterval');
    const remaining = integerHeader(response, 'x-ratelimit-remaining');
    const nativeDelay = Math.max(integerHeader(response, 'x-lognex-retry-after') ?? 0, integerHeader(response, 'x-lognex-reset') ?? 0);
    const standardDelay = Math.max(0, (retryAfterAt(response.headers.get('retry-after'), now)?.getTime() ?? now) - now);
    if (limit && window) {
      this.serverInterval = Math.min(MAX_COOLDOWN_MS, Math.ceil(window / limit * 1.25));
      this.interval = Math.max(this.interval, this.serverInterval);
    }
    if (response.status === 429) {
      const wait = Math.min(MAX_COOLDOWN_MS, Math.max(nativeDelay, standardDelay, nativeDelay || standardDelay ? 0 : window || this.fallbackCooldown));
      this.blockedUntil = Math.max(this.blockedUntil, now + wait);
      this.interval = Math.max(this.serverInterval, Math.min(Math.max(this.minimumInterval, 1_000), Math.ceil(this.interval * 1.5)));
      this.successes = 0;
      // Share a real cooldown even with adapters that only understand standard
      // Retry-After. Never alter the body or resend a rejected CREATE/UPDATE.
      if (now - this.lastWarning > 5_000) {
        this.lastWarning = now;
        this.logger.warn(JSON.stringify({ resolution: 'MOYSKLAD_SHARED_COOLDOWN', status: 429, waitMs: wait, intervalMs: this.interval }));
      }
    } else if (remaining === 0 || remaining !== null && limit && remaining <= Math.ceil(limit * 0.2)) {
      this.blockedUntil = Math.max(this.blockedUntil, now + Math.min(MAX_COOLDOWN_MS, Math.max(nativeDelay, window || this.fallbackCooldown)));
    } else if (response.ok && ++this.successes >= 100) {
      this.successes = 0;
      this.interval = Math.max(this.minimumInterval, this.serverInterval, Math.ceil(this.interval * 0.9));
    }
  }

  private withBodyLease(response: Response, signal: AbortSignal, finish: () => void): Response {
    const wrap = (body: ReadableStream<Uint8Array> | null) => {
      const headers = new Headers(response.headers);
      if (response.status === 429) {
        const wait = Math.max(0, this.blockedUntil - Date.now());
        const existing = retryAfterAt(headers.get('retry-after'))?.getTime() ?? 0;
        if (existing < this.blockedUntil) headers.set('retry-after', String(Math.ceil(wait / 1000)));
      }
      const result = new Response(body, { status: response.status, statusText: response.statusText, headers });
      for (const key of ['url', 'redirected', 'type'] as const) Object.defineProperty(result, key, { value: response[key] });
      return result;
    };
    // Preserve simple injected HTTP fakes as well as native empty responses.
    if (!response.body?.getReader) { finish(); return response instanceof Response && response.status === 429 ? wrap(null) : response; }
    // Some adapters throw on !ok without consuming the error body. Drain a
    // second branch so such a response cannot retain a permit until timeout.
    // The consumer branch still preserves the complete original response.
    const [consumer, monitor] = response.body.tee();
    const reader = consumer.getReader();
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const abort = () => { void reader.cancel(signal.reason).catch(() => undefined); finish(); controller.error(signal.reason); };
    const done = () => { signal.removeEventListener('abort', abort); finish(); };
    void monitor.pipeTo(new WritableStream<Uint8Array>({ write() {} }), { signal }).catch(() => undefined).finally(done);
    const stream = new ReadableStream<Uint8Array>({
      start(value) { controller = value; },
      async pull(value) {
        try {
          const chunk = await reader.read();
          if (signal.aborted) return;
          if (chunk.done) { done(); value.close(); } else value.enqueue(chunk.value);
        } catch (error) { done(); value.error(error); }
      },
      async cancel(reason) { done(); await reader.cancel(reason); },
    });
    signal.addEventListener('abort', abort, { once: true });
    return wrap(stream);
  }
}

function integerHeader(response: Response, name: string): number | null {
  const value = response.headers.get(name);
  return value && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
}

/** Install after the controlled transport guard, before constructing providers.
 * Thus namespace/admission checks still execute at actual send time, in the
 * submitting event's async scope. Other providers are passed through untouched.
 */
export function installMoyskladRequestScheduler(): void {
  const configured = process.env.MOYSKLAD_API_BASE_URL;
  if (!configured) return; // An unconfigured UI may start; preflight still blocks exchange.
  const base = new URL(configured);
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = new MoyskladRequestScheduler(original, base).fetch;
}
