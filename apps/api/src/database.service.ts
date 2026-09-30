import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class DatabaseService extends PrismaClient {
  constructor() {
    const mode = process.env.SYNC_MODE;
    if (mode !== 'apply' && mode !== 'dry') {
      throw new Error('SYNC_MODE must be dry or apply');
    }

    const databaseUrl = mode === 'dry' ? process.env.DRY_DATABASE_URL : process.env.DATABASE_URL;
    if (mode === 'dry' && !databaseUrl) {
      throw new Error('DRY_DATABASE_URL is required when SYNC_MODE=dry');
    }

    super(databaseUrl ? { datasources: { db: { url: databaseUrl } } } : {});
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
