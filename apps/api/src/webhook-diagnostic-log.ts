import { Injectable } from '@nestjs/common';

export type WebhookDiagnosticEntry = {
  source: 'BITRIX24' | 'MOYSKLAD';
  eventType: string | null;
  entityType: string | null;
  externalEntityId: string | null;
  status: 'rejected_validation' | 'processing_error';
  reason: string;
  receivedAt: string;
};

@Injectable()
export class WebhookDiagnosticLog {
  private readonly entries: WebhookDiagnosticEntry[] = [];

  record(entry: WebhookDiagnosticEntry) {
    this.entries.push(entry);
    if (this.entries.length > 100) this.entries.splice(0, this.entries.length - 100);
  }

  read() {
    return [...this.entries].reverse();
  }

  clear() {
    this.entries.length = 0;
  }
}
