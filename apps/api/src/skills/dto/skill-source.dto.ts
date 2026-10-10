import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import type { SkillSourceDomain } from '../skill-catalog.domain';

export class SkillDto {
  @ApiProperty() declare id: string;
  @ApiProperty() declare name: string;
  @ApiProperty() declare description: string;
  @ApiProperty() declare dir: string;
}

export class SkillSourceDto {
  @ApiProperty() declare id: string;
  @ApiProperty() declare gitUrl: string;
  @ApiProperty() declare ref: string;
  @ApiProperty() declare path: string;
  @ApiProperty({ nullable: true }) declare resolvedSha: string | null;
  @ApiProperty({ nullable: true }) declare resolvedAt: Date | null;
  @ApiProperty({ enum: ['OK', 'RESOLVE_FAILED'] }) declare status: string;
  @ApiProperty({ nullable: true }) declare statusReason: string | null;
  @ApiProperty() declare createdAt: Date;
  @ApiProperty({ type: [SkillDto] }) declare skills: SkillDto[];

  static fromDomain(source: SkillSourceDomain): SkillSourceDto {
    return Object.assign(new SkillSourceDto(), {
      id: source.id,
      gitUrl: source.gitUrl,
      ref: source.ref,
      path: source.path,
      resolvedSha: source.resolvedSha,
      resolvedAt: source.resolvedAt,
      status: source.status,
      statusReason: source.statusReason,
      createdAt: source.createdAt,
      skills: source.skills.map(({ id, name, description, dir }) => ({ id, name, description, dir })),
    });
  }
}

export class SkillSourceListDto {
  @ApiProperty({ type: [SkillSourceDto] }) declare items: SkillSourceDto[];
}

export class CreateSkillSourceDto {
  @ApiProperty() @IsString() declare gitUrl: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(200) @Matches(/^[^\s]+$/) @Matches(/^(?!.*\.\.).*$/) declare ref: string;
  @ApiProperty({ description: 'Empty string or slash-separated safe directory path', maxLength: 200 })
  @IsString() @MaxLength(200) @Matches(/^(?:[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*)?$/) @Matches(/^(?!.*(?:^|\/)\.\.?($|\/)).*$/)
  declare path: string;
}
