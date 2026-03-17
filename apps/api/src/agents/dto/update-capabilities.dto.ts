import { IsArray, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateCapabilitiesDto {
  @ApiProperty({
    description: 'Agent capabilities (e.g. typescript, react, nodejs)',
    example: ['typescript', 'nestjs', 'react'],
  })
  @IsArray()
  @IsString({ each: true })
  capabilities!: string[];
}
