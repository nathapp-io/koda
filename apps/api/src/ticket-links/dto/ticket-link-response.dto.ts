import { ApiProperty } from '@nestjs/swagger';

export class TicketLinkResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  ticketId!: string;

  @ApiProperty()
  url!: string;

  @ApiProperty()
  provider!: string;

  @ApiProperty({ nullable: true, type: String })
  externalRef!: string | null;

  @ApiProperty({ nullable: true })
  prState!: string | null;

  @ApiProperty({ nullable: true })
  prNumber!: number | null;

  @ApiProperty({ nullable: true })
  prUpdatedAt!: Date | null;

  @ApiProperty()
  createdAt!: Date;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static from(link: any): TicketLinkResponseDto {
    return {
      id: link.id,
      ticketId: link.ticketId,
      url: link.url,
      provider: link.provider,
      externalRef: link.externalRef,
      prState: link.prState ?? null,
      prNumber: link.prNumber ?? null,
      prUpdatedAt: link.prUpdatedAt ?? null,
      createdAt: link.createdAt,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static fromMany(links: any[]): TicketLinkResponseDto[] {
    return links.map(link => TicketLinkResponseDto.from(link));
  }
}
