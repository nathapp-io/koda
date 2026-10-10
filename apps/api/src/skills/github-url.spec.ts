import { ValidationAppException } from '@nathapp/nestjs-common';
import { parseGitHubUrl } from './github-url';

/** Returns what `fn` threw, or undefined when it returned normally. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('parseGitHubUrl (US-001)', () => {
  it('AC-1: normalizes a .git URL to lowercase owner, repo and gitUrl', () => {
    expect(parseGitHubUrl('https://github.com/NathApp-IO/Nax-Spec-Kit-Skills.git')).toEqual({
      owner: 'nathapp-io',
      repo: 'nax-spec-kit-skills',
      gitUrl: 'https://github.com/nathapp-io/nax-spec-kit-skills',
    });
  });

  it('AC-2: rejects a non-GitHub host with the skills.unsupportedHost prefix', () => {
    const error = thrownBy(() => parseGitHubUrl('https://gitlab.com/nathapp-io/skills'));
    expect(error).toBeInstanceOf(ValidationAppException);
    expect((error as ValidationAppException).prefix).toBe('skills.unsupportedHost');
  });

  it('AC-3: rejects a repo segment of ".." with the skills.unsupportedHost prefix', () => {
    const error = thrownBy(() => parseGitHubUrl('https://github.com/nathapp-io/..'));
    expect(error).toBeInstanceOf(ValidationAppException);
    expect((error as ValidationAppException).prefix).toBe('skills.unsupportedHost');
  });

  it('accepts a URL with a trailing slash and no .git suffix', () => {
    expect(parseGitHubUrl('https://github.com/Acme/Widgets/')).toEqual({
      owner: 'acme',
      repo: 'widgets',
      gitUrl: 'https://github.com/acme/widgets',
    });
  });

  it('accepts a trailing slash after the .git suffix', () => {
    expect(parseGitHubUrl('https://github.com/acme/widgets.git/')).toMatchObject({ repo: 'widgets' });
  });

  it.each([
    ['a repo that is only ".git"', 'https://github.com/acme/.git'],
    ['a repo of "."', 'https://github.com/acme/.'],
    ['an owner of ".."', 'https://github.com/../widgets'],
    ['a missing repo', 'https://github.com/acme'],
    ['a missing owner and repo', 'https://github.com/'],
    ['extra path segments', 'https://github.com/acme/widgets/tree/main'],
    ['an http scheme', 'http://github.com/acme/widgets'],
    ['an SSH URL', 'git@github.com:acme/widgets.git'],
    ['an empty string', ''],
  ])('rejects %s with the skills.unsupportedHost prefix', (_label, url) => {
    const error = thrownBy(() => parseGitHubUrl(url));
    expect(error).toBeInstanceOf(ValidationAppException);
    expect((error as ValidationAppException).prefix).toBe('skills.unsupportedHost');
  });
});
