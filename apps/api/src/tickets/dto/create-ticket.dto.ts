import { IsString, IsOptional, IsEnum, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { TicketType, Priority } from '@prisma/client';

export class CreateTicketDto {
  @ApiProperty({
    description: 'Ticket type',
    enum: TicketType,
    example: 'BUG',
  })
  @IsEnum(TicketType)
  type!: TicketType;

  @ApiProperty({
    description: 'Ticket title',
    example: 'Fix login bug',
    minLength: 1,
  })
  @IsString()
  @MinLength(1, { message: 'Title must not be empty' })
  title!: string;

  @ApiProperty({
    description: 'Ticket description',
    example: 'Users cannot login with email',
    required: false,
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    description: 'Ticket priority',
    enum: Priority,
    example: 'MEDIUM',
    required: false,
    default: 'MEDIUM',
  })
  @IsOptional()
  @IsEnum(Priority)
  priority?: Priority;
}
