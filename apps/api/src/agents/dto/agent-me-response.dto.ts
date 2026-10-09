import { ApiProperty } from '@nestjs/swagger';
import { AgentResponseDto } from './agent-response.dto';

/** S4c US-001: one non-deleted project on an agent's roster (GET /agents/me). */
export class AgentMeProjectDto {
  @ApiProperty()
  slug!: string;

  @ApiProperty()
  name!: string;
}

/** The agent fields AgentResponseDto.from reads; the agent row satisfies it. */
export interface AgentProfileRecord {
  id: string;
  name: string;
  slug: string;
  status: string;
  maxConcurrentTickets: number;
  roles: unknown[];
  capabilities: unknown[];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * S4c US-001: the agent's own profile (GET /agents/me). Same fields as
 * AgentResponseDto plus the non-deleted projects on its roster, slug-ordered.
 */
export class AgentMeResponseDto extends AgentResponseDto {
  @ApiProperty({ type: AgentMeProjectDto, isArray: true })
  projects!: AgentMeProjectDto[];

  static fromMe(
    agent: AgentProfileRecord,
    projects: readonly { slug: string; name: string }[],
  ): AgentMeResponseDto {
    return {
      ...AgentResponseDto.from(agent),
      projects: projects.map((p) => ({ slug: p.slug, name: p.name })),
    };
  }
}
