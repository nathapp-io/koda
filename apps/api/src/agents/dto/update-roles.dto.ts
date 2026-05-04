import { IsArray, IsString, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { AGENT_ROLES } from '../../common/enums';

export class UpdateRolesDto {
  @ApiProperty({
    description: 'Agent roles',
    example: ['DEVELOPER', 'REVIEWER'],
  })
  @IsArray()
  @IsString({ each: true })
  @IsIn([...AGENT_ROLES], { each: true })
  roles!: string[];
}
