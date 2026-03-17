import { IsArray, IsString, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateRolesDto {
  @ApiProperty({
    description: 'Agent roles (TRIAGER, DEVELOPER, REVIEWER)',
    example: ['DEVELOPER', 'REVIEWER'],
  })
  @IsArray()
  @IsString({ each: true })
  @IsIn(['TRIAGER', 'DEVELOPER', 'REVIEWER'], { each: true })
  roles!: string[];
}
