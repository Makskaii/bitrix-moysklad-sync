import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { assertConfiguredDatabaseTargets } from './database-target';

@Injectable()
export class DatabaseService extends PrismaClient {
  constructor() {
    assertConfiguredDatabaseTargets();
    const mode = process.env.SYNC_MODE;
    const databaseUrl = mode === 'dry' ? process.env.DRY_DATABASE_URL : process.env.DATABASE_URL;
    super({ datasources: { db: { url: databaseUrl } } });
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
