import { ApiProperty } from '@nestjs/swagger';

export class LabelResponseDto {
  @ApiProperty({ example: 'label-123' })
  id!: string;

  @ApiProperty({ example: 'proj-123' })
  projectId!: string;

  @ApiProperty({ example: 'typescript' })
  name!: string;

  @ApiProperty({ example: '#0066CC', nullable: true })
  color!: string | null;
}
