import { Injectable } from '@nestjs/common';
import { CreateTicketLinkDto } from './dto/create-ticket-link.dto';
import { TicketLinkResponseDto } from './dto/ticket-link-response.dto';

export interface CreateTicketLinkResult {
  status: 200 | 201;
  link: TicketLinkResponseDto;
}

@Injectable()
export class TicketLinksService {
  async create(
    _slug: string,
    _ref: string,
    _dto: CreateTicketLinkDto,
  ): Promise<CreateTicketLinkResult> {
    throw new Error('Not implemented');
  }

  async findByTicket(
    _slug: string,
    _ref: string,
  ): Promise<TicketLinkResponseDto[]> {
    throw new Error('Not implemented');
  }

  async remove(_slug: string, _ref: string, _linkId: string): Promise<void> {
    throw new Error('Not implemented');
  }
}
