import 'reflect-metadata';
import { BadRequestException, Body, Controller, Get, Injectable, Module, Post } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PrismaClient, TrialAction } from '@prisma/client';

@Injectable()
class DatabaseService extends PrismaClient {
  async onModuleDestroy() {
    await this.$disconnect();
  }
}

@Controller()
class AppController {
  constructor(private readonly database: DatabaseService) {}

  @Get('health')
  async health() {
    await this.database.$queryRaw`SELECT 1`;
    return { status: 'ok', database: 'ok' };
  }

  @Get('api/trial-actions')
  list(): Promise<TrialAction[]> {
    return this.database.trialAction.findMany({ orderBy: { createdAt: 'desc' } });
  }

  @Post('api/trial-actions')
  create(@Body() body: { message?: unknown } | null): Promise<TrialAction> {
    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    if (!message || message.length > 200) {
      throw new BadRequestException('message must contain between 1 and 200 characters');
    }
    return this.database.trialAction.create({ data: { message } });
  }
}

@Module({ controllers: [AppController], providers: [DatabaseService] })
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(process.env.PORT ?? 3000, '0.0.0.0');
}

void bootstrap();
