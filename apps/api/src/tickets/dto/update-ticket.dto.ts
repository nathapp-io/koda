import { IsString, IsOptional, IsEnum, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Priority, TicketStatus } from '../../common/enums';

export class UpdateTicketDto {
  @ApiProperty({
    description: 'Ticket title',
    example: 'Updated ticket title',
    minLength: 1,
    required: false,
  })
  @IsOptional()
  @IsString({ message: '$t(common.validation.isString)' })
  @MinLength(1, { message: '$t(common.validation.required)' })
  title?: string;

  @ApiProperty({
    description: 'Ticket description',
    example: 'Updated description',
    required: false,
  })
  @IsOptional()
  @IsString({ message: '$t(common.validation.isString)' })
  description?: string;

  @ApiProperty({
    description: 'Ticket priority',
    enum: Priority,
    example: 'HIGH',
    required: false,
  })
  @IsOptional()
  @IsEnum(Priority, { message: '$t(common.validation.isEnum)' })
  priority?: Priority;

  @ApiProperty({
    description: 'Ticket status',
    enum: TicketStatus,
    example: 'IN_PROGRESS',
    required: false,
  })
  @IsOptional()
  @IsEnum(TicketStatus, { message: '$t(common.validation.isEnum)' })
  status?: TicketStatus;
}
