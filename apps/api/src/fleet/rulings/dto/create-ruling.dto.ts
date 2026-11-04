import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length, Matches } from 'class-validator';

export class CreateRulingDto {
  @ApiProperty({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9._:-]+$' })
  @IsString() @Length(1, 64) @Matches(/^[A-Za-z0-9._:-]+$/) declare itemId: string;

  @ApiProperty({ minLength: 1, maxLength: 2000 })
  @IsString() @Length(1, 2000) declare text: string;
}
