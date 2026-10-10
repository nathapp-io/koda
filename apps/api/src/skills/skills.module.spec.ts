import { Test, TestingModule } from '@nestjs/testing';
import { GlobalStubsModule } from '../common/test-helpers/global-stubs.module';
import { GitHubSkillResolver } from './github-skill-resolver';
import { SKILL_RESOLVER } from './skill-resolver';
import { SkillsModule } from './skills.module';

/**
 * US-003 — DI guard for the skill catalog module.
 *
 * `bun run test` runs without a database, so a missing provider or an accidental
 * cycle in SkillsModule must surface here rather than in the DB-backed suites.
 */
describe('US-003 SkillsModule', () => {
  let moduleRef: TestingModule;

  afterEach(async () => {
    await moduleRef?.close();
  });

  it('US-003 AC1: compiles and resolves SKILL_RESOLVER to a GitHubSkillResolver', async () => {
    moduleRef = await Test.createTestingModule({ imports: [GlobalStubsModule, SkillsModule] }).compile();
    expect(moduleRef.get(SKILL_RESOLVER)).toBeInstanceOf(GitHubSkillResolver);
  });
});
