import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NOTIFICATION_CATEGORIES, NotificationCategory } from '../notification.types';

export class NotificationDto {
  @ApiProperty() id: string;
  @ApiProperty({ enum: NOTIFICATION_CATEGORIES }) category: NotificationCategory;
  @ApiProperty({ description: 'ticket_assigned, ticket_mentioned, ticket_commented, ticket_status_changed, job_*, approval_requested, budget_*, runner_offline, credential_expiring' })
  kind: string;
  @ApiProperty({ description: 'English fallback; the web renders from kind + params' }) title: string;
  @ApiPropertyOptional({ nullable: true, type: String }) body: string | null;
  @ApiProperty({ description: 'In-app path, e.g. /koda/tickets/KODA-12' }) link: string;
  @ApiProperty({ type: 'object', additionalProperties: { oneOf: [{ type: 'string' }, { type: 'number' }] } })
  params: Record<string, string | number>;
  @ApiPropertyOptional({ nullable: true, type: String }) projectId: string | null;
  @ApiPropertyOptional({ nullable: true, type: String }) actorId: string | null;
  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' }) readAt: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
}

export class NotificationPageDto {
  @ApiProperty() total: number;
  @ApiProperty() current: number;
  @ApiProperty() size: number;
  @ApiProperty() hasNext: boolean;
  @ApiProperty() hasPrev: boolean;
  @ApiProperty({ type: [NotificationDto] }) records: NotificationDto[];
}

export class UnreadCountDto {
  @ApiProperty() count: number;
}
