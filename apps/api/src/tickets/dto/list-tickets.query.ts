import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsString } from 'class-validator';
import { KodaPageQuery } from '../../common/dto/koda-page.query';
import { Priority, TicketStatus, TicketType } from '../../common/enums';

// 'true'/'false' become booleans; anything else is left as-is so @IsBoolean rejects it.
const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;

export class ListTicketsQuery extends KodaPageQuery {
  @ApiPropertyOptional({ enum: TicketStatus })
  @IsOptional()
  @IsEnum(TicketStatus)
  status?: TicketStatus;

  @ApiPropertyOptional({ enum: TicketType })
  @IsOptional()
  @IsEnum(TicketType)
  type?: TicketType;

  @ApiPropertyOptional({ enum: Priority })
  @IsOptional()
  @IsEnum(Priority)
  priority?: Priority;

  @ApiPropertyOptional({ description: 'User id of the assignee, or "self" for the caller (user or agent)' })
  @IsOptional()
  @IsString()
  assignedTo?: string;

  @ApiPropertyOptional({ type: Boolean, description: 'Only tickets with no user or agent assignee' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  unassigned?: boolean;
}
