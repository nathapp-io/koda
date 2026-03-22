import { IsString, IsOptional, IsEnum, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { TicketType, Priority } from '../../common/enums';

export class CreateTicketDto {
  @ApiProperty({
    description: 'Ticket type',
    enum: TicketType,
    example: 'BUG',
  })
  @IsEnum(TicketType, { message: '$t(common.validation.isEnum)' })
  type!: TicketType;

  @ApiProperty({
    description: 'Ticket title',
    example: 'Fix login bug',
    minLength: 1,
  })
  @IsString({ message: '$t(common.validation.isString)' })
  @MinLength(1, { message: '$t(common.validation.required)' })
  title!: string;

  @ApiProperty({
    description: 'Ticket description',
    example: 'Users cannot login with email',
    required: false,
  })
  @IsOptional()
  @IsString({ message: '$t(common.validation.isString)' })
  description?: string;

  @ApiProperty({
    description: 'Ticket priority',
    enum: Priority,
    example: 'MEDIUM',
    required: false,
    default: 'MEDIUM',
  })
  @IsOptional()
  @IsEnum(Priority, { message: '$t(common.validation.isEnum)' })
  priority?: Priority;
}
