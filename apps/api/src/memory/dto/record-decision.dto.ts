import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MinLength } from 'class-validator';

export class RecordDecisionDto {
  @ApiProperty({ description: 'Project ID the decision belongs to' })
  @IsString()
  @MinLength(1)
  projectId!: string;

  @ApiProperty({ description: 'ID of the user or agent making the decision' })
  @IsString()
  @MinLength(1)
  actorId!: string;

  @ApiProperty({ description: 'Short topic/subject of the decision' })
  @IsString()
  @MinLength(1)
  topic!: string;

  @ApiProperty({ description: 'The decision that was made' })
  @IsString()
  @MinLength(1)
  decision!: string;

  @ApiProperty({ required: false, description: 'Why the decision was made' })
  @IsOptional()
  @IsString()
  rationale?: string;

  @ApiProperty({ required: false, description: 'ID of the source record (e.g. ticket, comment) this decision came from' })
  @IsOptional()
  @IsString()
  sourceId?: string;
}
