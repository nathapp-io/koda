import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateFleetRepoDto, GITLAB_FIELDS_ON_GITHUB } from './create-fleet-repo.dto';

/**
 * US-004: the create body's own rules.
 *
 * The options mirror the global pipe (`useAppGlobalPipes()`) and the approval command's own
 * validation (`parseBody`): one error at a time, and a property the DTO does not declare is
 * dropped.
 */
const PIPE_OPTIONS = { whitelist: true, stopAtFirstError: true, forbidUnknownValues: false } as const;

const validate = (raw: unknown) => validateSync(plainToInstance(CreateFleetRepoDto, raw), PIPE_OPTIONS);

const github = { projectSlug: 'web', provider: 'github', owner: 'acme', name: 'app' };
const gitlab = { projectSlug: 'web', provider: 'gitlab', owner: 'acme', name: 'app', readToken: 'glpat-read', writeToken: 'glpat-write' };

describe('CreateFleetRepoDto', () => {
  it('accepts a GitHub body', () => {
    expect(validate(github)).toEqual([]);
  });

  it('accepts a GitLab body with both tokens', () => {
    expect(validate(gitlab)).toEqual([]);
  });

  it('accepts a GitLab body with a host and the bot confirmation', () => {
    expect(validate({ ...gitlab, host: 'https://gitlab.example.com', confirmBotAccount: true })).toEqual([]);
  });

  it.each([
    ['the read token', { readToken: undefined }],
    ['the write token', { writeToken: undefined }],
    ['an empty read token', { readToken: '' }],
    ['an over-long write token', { writeToken: 'x'.repeat(513) }],
  ])('refuses a GitLab body without %s', (_label, over) => {
    expect(validate({ ...gitlab, ...over }).length).toBeGreaterThan(0);
  });

  it.each([
    ['the host', { host: 'https://gitlab.example.com' }],
    ['the read token', { readToken: 'glpat-read' }],
    ['the write token', { writeToken: 'glpat-write' }],
    ['the bot confirmation', { confirmBotAccount: true }],
  ])('refuses a GitHub body that carries %s', (_label, over) => {
    const errors = validate({ ...github, ...over });
    expect(errors.length).toBeGreaterThan(0);
    expect(Object.values(errors[0].constraints ?? {})).toContain(GITLAB_FIELDS_ON_GITHUB);
  });
});
