import { ApiProperty, type ApiPropertyOptions } from '@nestjs/swagger';
import { Allow } from 'class-validator';
import type { ChatThreadKind, ThreadBackend } from '../../common/thread-jobs';
import { ThreadDto, ThreadDetailDto } from './thread.dto';

export class CreateWorkspaceThreadDto {
  @Allow() @ApiProperty({ required: false, enum: ['WORKSPACE'] }) kind?: ChatThreadKind;
  @Allow() @ApiProperty({ required: false, description: 'Not allowed on workspace threads' }) repoId?: string;
  @Allow() @ApiProperty({ required: false, description: 'Not allowed on workspace threads' }) feature?: string;
  @Allow() @ApiProperty({ required: false, description: 'Not allowed on workspace threads' }) baseRef?: string;
  @Allow() @ApiProperty({ required: false, minLength: 1, maxLength: 100 }) homeProject?: string;
  @Allow() @ApiProperty({ minLength: 1, maxLength: 200 }) title: string;
  @Allow() @ApiProperty({ required: false, default: 5 }) maxCostUsd?: number;
  @Allow() @ApiProperty({ type: 'object', additionalProperties: true }) backend: ThreadBackend;
}

const homeProjectSchema: ApiPropertyOptions = { type: 'object', required: ['slug', 'name'], properties: { slug: { type: 'string' }, name: { type: 'string' } } };
export class WorkspaceThreadDto extends ThreadDto {
  @ApiProperty(homeProjectSchema) homeProject: { slug: string; name: string };
}
export class WorkspaceThreadDetailDto extends ThreadDetailDto {
  @ApiProperty(homeProjectSchema) homeProject: { slug: string; name: string };
}
export class WorkspaceThreadListDto {
  @ApiProperty({ type: [WorkspaceThreadDto] }) items: WorkspaceThreadDto[];
  @ApiProperty() threadsEnabled: boolean;
}
