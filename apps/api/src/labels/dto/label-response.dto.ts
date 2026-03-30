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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static from(label: any): LabelResponseDto {
    return {
      id: label.id,
      projectId: label.projectId,
      name: label.name,
      color: label.color,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static fromMany(labels: any[]): LabelResponseDto[] {
    return labels.map(l => LabelResponseDto.from(l));
  }
}
