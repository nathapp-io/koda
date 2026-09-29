import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, Matches, MaxLength } from 'class-validator';

export class CreateFleetRepoDto {
  @ApiProperty() @IsString() @MaxLength(100) declare projectSlug: string;
  @ApiProperty({ enum: ['github', 'gitlab'] }) @IsIn(['github', 'gitlab']) declare provider: 'github' | 'gitlab';
  @ApiProperty({ description: 'Owner or namespace (GitLab: group/subgroup)' })
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/) declare owner: string;
  @ApiProperty() @Matches(/^[A-Za-z0-9._-]{1,100}$/) declare name: string;
}
