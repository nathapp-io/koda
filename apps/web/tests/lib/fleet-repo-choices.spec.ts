import { describe, expect, test } from '@jest/globals'
import { repoChoices } from '../../lib/fleet-repo-choices'
import type { RepoChoiceInput } from '../../lib/fleet-repo-choices'

/**
 * US-005 (K9): the web repo choosers label a repo `owner/name`, and only a NAME two repos share gets
 * the host appended, so seven choosers can tell `acme/app` on gitlab.com from `acme/app` elsewhere.
 */

/** The two-host fixture the page specs mount: one owner/name on two forges. */
const GITLAB_COM: RepoChoiceInput = { id: 'r1', owner: 'acme', name: 'app', host: 'https://gitlab.com' }
const GITLAB_SELF_HOSTED: RepoChoiceInput = { id: 'r2', owner: 'acme', name: 'app', host: 'https://gitlab.example.com' }
const TWO_HOSTS: RepoChoiceInput[] = [GITLAB_COM, GITLAB_SELF_HOSTED]

const labels = (repos: readonly RepoChoiceInput[]): string[] => repoChoices(repos).map((choice) => choice.label)

describe('US-005 repoChoices: the label of one repo', () => {
  test('AC-1: a repo whose owner/name is unique keeps the plain label and its id as value', () => {
    expect(repoChoices([{ id: 'r1', owner: 'acme', name: 'app', host: 'https://github.com' }])).toEqual([
      { value: 'r1', label: 'acme/app' },
    ])
  })

  test('AC-4: a repo outside the shared name is not decorated by the sharing of another name', () => {
    const other: RepoChoiceInput = { id: 'r3', owner: 'acme', name: 'other', host: 'https://gitlab.com' }

    expect(repoChoices([...TWO_HOSTS, other])).toEqual([
      { value: 'r1', label: 'acme/app (gitlab.com)' },
      { value: 'r2', label: 'acme/app (gitlab.example.com)' },
      { value: 'r3', label: 'acme/other' },
    ])
  })
})

describe('US-005 repoChoices: the label of a shared name', () => {
  test('AC-2: two hosts behind one owner/name each get their host, in input order', () => {
    expect(repoChoices(TWO_HOSTS)).toEqual([
      { value: 'r1', label: 'acme/app (gitlab.com)' },
      { value: 'r2', label: 'acme/app (gitlab.example.com)' },
    ])
  })

  test('AC-3: the shared name is matched case-insensitively and each label keeps its own casing', () => {
    expect(labels([{ id: 'r1', owner: 'Acme', name: 'App', host: 'https://gitlab.com' }, GITLAB_SELF_HOSTED])).toEqual([
      'Acme/App (gitlab.com)',
      'acme/app (gitlab.example.com)',
    ])
  })

  test('AC-5: a host that is not a URL is shown as it was given', () => {
    expect(labels([GITLAB_COM, { ...GITLAB_SELF_HOSTED, host: 'gitlab.internal' }])).toEqual([
      'acme/app (gitlab.com)',
      'acme/app (gitlab.internal)',
    ])
  })

  test('AC-6: a host URL keeps the host and its path without the trailing slash', () => {
    expect(labels([GITLAB_COM, { ...GITLAB_SELF_HOSTED, host: 'https://gitlab.example.com/gl/' }])).toEqual([
      'acme/app (gitlab.com)',
      'acme/app (gitlab.example.com/gl)',
    ])
  })

  test('AC-7: a shared name with no host at all falls back to each repo id', () => {
    expect(labels([
      { id: 'r1', owner: 'acme', name: 'app' },
      { id: 'r2', owner: 'acme', name: 'app' },
    ])).toEqual(['acme/app (r1)', 'acme/app (r2)'])
  })

  test('AC-7 (edge): one repo with a host and one without decorate only the one missing it', () => {
    expect(labels([GITLAB_COM, { id: 'r2', owner: 'acme', name: 'app' }])).toEqual([
      'acme/app (gitlab.com)',
      'acme/app (r2)',
    ])
  })

  test('edge: an empty list yields no choices', () => {
    expect(repoChoices([])).toEqual([])
  })
})
