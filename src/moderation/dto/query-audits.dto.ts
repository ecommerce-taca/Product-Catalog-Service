import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class QueryAuditsDto {
  @IsOptional()
  @IsString()
  target_id?: string;

  @IsOptional()
  @IsString()
  target_type?: string;

  @IsOptional()
  @IsString()
  actor_user_id?: string;

  @IsOptional()
  @IsString()
  action?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  size?: number = 20;
}
