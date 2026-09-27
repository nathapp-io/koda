/**
 * US-005 — slug format validation on the canonical CreateAgentDto.
 *
 * The service-local CreateAgentDto in `agents.service.ts` was removed in US-005.
 * All callers now import the canonical DTO from this folder. This file tests
 * the slug format validation and optional fields of the canonical DTO.
 */
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateAgentDto } from './create-agent.dto';

async function errorProperties(
  dtoClass: new () => object,
  raw: Record<string, unknown>,
): Promise<string[]> {
  const errors = await validate(plainToInstance(dtoClass, raw));
  return errors.map((error) => error.property);
}

describe('CreateAgentDto slug validation (US-005)', () => {
  describe('canonical CreateAgentDto (agents/dto/create-agent.dto.ts)', () => {
    it("rejects slug 'Bad Slug!'", async () => {
      const properties = await errorProperties(CreateAgentDto, {
        name: 'Bad Agent',
        slug: 'Bad Slug!',
      });

      expect(properties).toContain('slug');
    });

    it("accepts slug 'good-slug-1'", async () => {
      const properties = await errorProperties(CreateAgentDto, {
        name: 'Good Agent',
        slug: 'good-slug-1',
      });

      expect(properties).toEqual([]);
    });

    it('roles and capabilities stay optional on the canonical DTO', async () => {
      const properties = await errorProperties(CreateAgentDto, {
        name: 'Good Agent',
        slug: 'good-slug-1',
        roles: ['DEVELOPER'],
        capabilities: ['typescript'],
      });

      expect(properties).toEqual([]);
    });

    it('rejects uppercase, underscore and whitespace slug variants', async () => {
      for (const slug of ['Bad-Slug', 'bad_slug', 'bad slug', 'Bad Slug', 'bad-slug!']) {
        const properties = await errorProperties(CreateAgentDto, {
          name: 'Bad Agent',
          slug,
          roles: ['DEVELOPER'],
        });

        expect(properties).toContain('slug');
      }
    });
  });
});
