import { Controller, Get, UseGuards } from '@nestjs/common';
import { AdminAccessGuard } from './admin-access.guard';
import { ProductDuplicateAliasService } from '../products/product-duplicate-alias.service';

@Controller('api/admin/product-duplicates')
@UseGuards(AdminAccessGuard)
export class ProductDuplicatesController {
  constructor(private readonly aliases: ProductDuplicateAliasService) {}

  @Get()
  list() {
    return this.aliases.list();
  }
}
