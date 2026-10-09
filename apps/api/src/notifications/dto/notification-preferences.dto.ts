import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsOptional, ValidateNested } from 'class-validator';
import { NOTIFICATION_CATEGORIES, NotificationCategory } from '../notification.types';

/** S4b §3.1: one category's optional in-app and email switches. */
export class NotificationPreferenceItemDto {
  @ApiProperty({ enum: NOTIFICATION_CATEGORIES })
  @IsIn(NOTIFICATION_CATEGORIES)
  category: NotificationCategory;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  inApp?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  email?: boolean;
}

/** S4b §3.1: PUT body. Either field may be omitted; only supplied fields are written. */
export class NotificationPreferencesDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  emailEnabled?: boolean;

  @ApiPropertyOptional({ type: [NotificationPreferenceItemDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(NOTIFICATION_CATEGORIES.length)
  @ValidateNested({ each: true })
  @Type(() => NotificationPreferenceItemDto)
  items?: NotificationPreferenceItemDto[];
}

export class NotificationPreferenceViewItemDto {
  @ApiProperty({ enum: NOTIFICATION_CATEGORIES })
  category: NotificationCategory;

  @ApiProperty()
  inApp: boolean;

  @ApiProperty()
  email: boolean;
}

export class NotificationPreferencesViewDto {
  @ApiProperty()
  emailAvailable: boolean;

  @ApiProperty()
  emailEnabled: boolean;

  @ApiProperty({ type: [NotificationPreferenceViewItemDto] })
  items: NotificationPreferenceViewItemDto[];
}
