import { IsString, IsOptional, IsEnum, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Priority } from '@prisma/client';

export class UpdateTicketDto {
  @ApiProperty({
    description: 'Ticket title',
    example: 'Updated ticket title',
    minLength: 1,
    required: false,
  })
  @IsOptional()
  @IsString()
  @MinLength(1, { message: 'Title must not be empty' })
  title?: string;

  @ApiProperty({
    description: 'Ticket description',
    example: 'Updated description',
    required: false,
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    description: 'Ticket priority',
    enum: Priority,
    example: 'HIGH',
    required: false,
  })
  @IsOptional()
  @IsEnum(Priority)
  priority?: Priority;
}
