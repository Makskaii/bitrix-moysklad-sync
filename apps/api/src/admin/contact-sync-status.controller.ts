import { Controller, Get, NotFoundException, Param, UseGuards } from '@nestjs/common';
import { AdminAccessGuard } from './admin-access.guard';
import { ContactSyncStatusReader } from '../contact-sync.service';

@Controller('api/admin/contact-sync')
@UseGuards(AdminAccessGuard)
export class ContactSyncStatusController {
  constructor(private readonly statusReader: ContactSyncStatusReader) {}

  @Get('events/:eventId')
  async getEventStatus(@Param('eventId') eventId: string) {
    const event = await this.statusReader.read(eventId);
    if (!event) throw new NotFoundException();
    return event;
  }
}
