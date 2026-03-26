import { ApiProperty } from '@nestjs/swagger';

export class TicketLinkResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  ticketId: string;

  @ApiProperty()
  url: string;

  @ApiProperty()
  provider: string;

  @ApiProperty({ nullable: true, type: String })
  externalRef: string | null;

  @ApiProperty()
  createdAt: Date;
}
