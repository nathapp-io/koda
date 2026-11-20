/**
 * US-005 (K9): the labels the web's seven repo choosers offer.
 *
 * One owner/name can exist on several forges (an `acme/app` on gitlab.com and another on a
 * self-hosted GitLab), and every chooser used to label both `acme/app`, so a person could not tell
 * which repo they picked. `repoChoices` keeps the plain `owner/name` whenever it is unique and adds
 * the host only to the names two or more repos share; repo ids and permissions are untouched.
 */

/** A repo as the choosers get it: `FleetRepo` on the pages, a narrower local shape in a component. */
export interface RepoChoiceInput {
  id: string
  owner: string
  name: string
  /** Absent in some fixtures; a repo with no host is disambiguated by its id. */
  host?: string
}

/** One `<option>` (or `<SelectItem>`) of a repo chooser. */
export interface RepoChoice {
  value: string
  label: string
}

/** `owner/name`, the label every chooser used before hosts were shown. */
function fullName(repo: RepoChoiceInput): string {
  return `${repo.owner}/${repo.name}`
}

/**
 * Where the repo lives: `URL.host` plus its pathname without a trailing `/` when `host` parses as a
 * URL (`https://gitlab.example.com/gl/` reads `gitlab.example.com/gl`), the raw host when it does
 * not (`gitlab.internal`), and the repo id when the repo carries no host at all.
 */
function hostLabel(repo: RepoChoiceInput): string {
  const host = (repo.host ?? '').trim()
  if (host === '') return repo.id
  try {
    const url = new URL(host)
    return `${url.host}${url.pathname.replace(/\/+$/, '')}`
  }
  catch {
    return host
  }
}

/**
 * The `{ value, label }` choices of one repo list, in input order. A name two or more repos share
 * (compared case-insensitively, so `Acme/App` and `acme/app` collide) is labelled with its host.
 */
export function repoChoices(repos: readonly RepoChoiceInput[]): RepoChoice[] {
  const shared = new Map<string, number>()
  for (const repo of repos) {
    const key = fullName(repo).toLowerCase()
    shared.set(key, (shared.get(key) ?? 0) + 1)
  }
  return repos.map((repo) => {
    const label = fullName(repo)
    const collides = (shared.get(label.toLowerCase()) ?? 0) > 1
    return { value: repo.id, label: collides ? `${label} (${hostLabel(repo)})` : label }
  })
}
