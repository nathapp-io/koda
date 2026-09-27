/**
 * US-003 — slug format validation on both CreateAgentDto classes.
 *
 * Two DTOs carry the same name: the service-local one exported by
 * `agents.service.ts` (currently bound to POST /api/agents) and the canonical
 * one in this folder (`agents/dto/create-agent.dto.ts`, canonical from US-005).
 * Both must reject malformed slugs and accept kebab-case ones.
 */
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateAgentDto as ServiceLocalCreateAgentDto } from '../agents.service';
import { CreateAgentDto as CanonicalCreateAgentDto } from './create-agent.dto';

async function errorProperties(
  dtoClass: new () => object,
  raw: Record<string, unknown>,
): Promise<string[]> {
  const errors = await validate(plainToInstance(dtoClass, raw));
  return errors.map((error) => error.property);
}

describe('US-003 CreateAgentDto slug validation', () => {
  describe('canonical CreateAgentDto (agents/dto/create-agent.dto.ts)', () => {
    it("AC3: rejects slug 'Bad Slug!'", async () => {
      const properties = await errorProperties(CanonicalCreateAgentDto, {
        name: 'Bad Agent',
        slug: 'Bad Slug!',
      });

      expect(properties).toContain('slug');
    });

    it("AC4: accepts slug 'good-slug-1'", async () => {
      const properties = await errorProperties(CanonicalCreateAgentDto, {
        name: 'Good Agent',
        slug: 'good-slug-1',
      });

      expect(properties).toEqual([]);
    });

    it('AC4 boundary: roles and capabilities stay optional on the canonical DTO', async () => {
      const properties = await errorProperties(CanonicalCreateAgentDto, {
        name: 'Good Agent',
        slug: 'good-slug-1',
        roles: ['DEVELOPER'],
        capabilities: ['typescript'],
      });

      expect(properties).toEqual([]);
    });
  });

  describe('service-local CreateAgentDto (exported from agents.service.ts)', () => {
    it("AC3: rejects slug 'Bad Slug!'", async () => {
      const properties = await errorProperties(ServiceLocalCreateAgentDto, {
        name: 'Bad Agent',
        slug: 'Bad Slug!',
        roles: ['DEVELOPER'],
      });

      expect(properties).toContain('slug');
    });

    it('AC3 boundary: rejects uppercase, underscore and whitespace slug variants', async () => {
      for (const slug of ['Bad-Slug', 'bad_slug', 'bad slug', 'Bad Slug', 'bad-slug!']) {
        const properties = await errorProperties(ServiceLocalCreateAgentDto, {
          name: 'Bad Agent',
          slug,
          roles: ['DEVELOPER'],
        });

        expect(properties).toContain('slug');
      }
    });

    it("AC4: accepts slug 'good-slug-1'", async () => {
      const properties = await errorProperties(ServiceLocalCreateAgentDto, {
        name: 'Good Agent',
        slug: 'good-slug-1',
        roles: ['DEVELOPER'],
      });

      expect(properties).toEqual([]);
    });
  });
});
