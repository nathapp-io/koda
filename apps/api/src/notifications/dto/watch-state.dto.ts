import { ApiProperty } from '@nestjs/swagger';

export class WatchStateDto {
  @ApiProperty({ description: 'Whether the caller receives activity notifications for this ticket' }) watching: boolean;
  @ApiProperty({ description: 'Unmuted watchers' }) count: number;
}
