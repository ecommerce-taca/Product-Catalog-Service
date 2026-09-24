import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { CategoryService } from '../services/category.service';
import { CreateCategoryDto } from '../dto/create-category.dto';
import { UpdateCategoryDto } from '../dto/update-category.dto';
import { ArchiveCategoryDto } from '../dto/archive-category.dto';
import { QueryCategoryDto } from '../dto/query-category.dto';
import { CategoryResponseDto } from '../dto/category-response.dto';

@Controller('admin/catalog/categories')
@Roles('CATALOG_ADMIN', 'SUPER_ADMIN')
export class AdminCategoryController {
  constructor(private readonly categoryService: CategoryService) {}

  @Get()
  async getCategories(@Query() query: QueryCategoryDto): Promise<{
    data: CategoryResponseDto[];
    meta: { page: number; size: number; total: number; total_pages: number };
  }> {
    const result = await this.categoryService.getAdminCategories(query);
    return {
      data: result.items,
      meta: result.pagination,
    };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createCategory(@Body() dto: CreateCategoryDto): Promise<CategoryResponseDto> {
    return this.categoryService.createCategory(dto);
  }

  @Patch(':id')
  async updateCategory(
    @Param('id') id: string,
    @Body() dto: UpdateCategoryDto,
  ): Promise<CategoryResponseDto> {
    return this.categoryService.updateCategory(id, dto);
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  async archiveCategory(
    @Param('id') id: string,
    @Body() dto: ArchiveCategoryDto,
  ): Promise<{ category_id: string; status: string; version: number }> {
    return this.categoryService.archiveCategory(id, dto);
  }
}
