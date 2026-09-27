import { ApiProperty } from '@nestjs/swagger';
import { TicketResponseDto } from './ticket-response.dto';
import { TICKET_ACTIONS, TicketAction } from '../state-machine/allowed-actions';

/** GET :ref only; list and board responses do not carry allowedActions. */
export class TicketDetailResponseDto extends TicketResponseDto {
  @ApiProperty({
    description: 'Transition endpoints the caller may use on this ticket now (M25)',
    enum: TICKET_ACTIONS,
    isArray: true,
  })
  allowedActions!: TicketAction[];
}
