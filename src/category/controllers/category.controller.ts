import { Controller, Get, Param } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { CategoryService } from '../services/category.service';
import { CategoryTreeNodeDto } from '../dto/category-response.dto';

@Controller('categories')
export class CategoryController {
  constructor(private readonly categoryService: CategoryService) {}

  @Public()
  @Get()
  async getCategories(): Promise<CategoryTreeNodeDto[]> {
    return this.categoryService.getPublicTree();
  }

  @Public()
  @Get(':id')
  async getCategoryById(@Param('id') id: string): Promise<CategoryTreeNodeDto> {
    return this.categoryService.getPublicCategoryDetail(id);
  }
}
