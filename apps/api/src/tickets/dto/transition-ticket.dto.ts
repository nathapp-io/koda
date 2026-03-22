import { IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { TicketStatus } from '../../common/enums';

export class TransitionTicketDto {
  @ApiProperty({
    description: 'New ticket status',
    enum: TicketStatus,
    example: 'VERIFIED',
  })
  @IsEnum(TicketStatus)
  status!: TicketStatus;
}
