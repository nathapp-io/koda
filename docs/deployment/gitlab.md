# GitLab fleet repositories

This guide covers registering and operating GitLab repositories in the koda fleet. GitLab.com is the default; self-hosted instances are supported subject to the host restrictions below. Fleet credentials are stored per repository, separately from the GitLab token used for ticket sync.

## Create a bot account

Use a dedicated GitLab user for the write token. koda treats the write token's GitLab identity as its bot identity: it uses that identity when recognizing its own merge requests and comments. A human-account write token is accepted only with `--confirm-bot`; koda shows a warning because work opened manually by that person can be treated as koda's own work.

Add the bot user to the project with the **Developer** role or above. For private repositories, make sure the account can access the project. Create two personal or access tokens for that user and store them in protected files readable only by the operator running the CLI:

- **Read token:** `read_api` and `read_repository` scopes.
- **Write token:** `api` and `write_repository` scopes.

Do not paste tokens into command arguments or commit token files. The CLI reads token contents from files, or from stdin when the path is `-`.

## Register a repository

Run as a global administrator. For GitLab.com:

```bash
koda fleet repo add <group/app> --provider gitlab \
  --read-token-file /secure/path/gitlab-read-token \
  --write-token-file /secure/path/gitlab-write-token
```

For a self-hosted instance, add its HTTPS base URL (not its `/api/v4` URL):

```bash
koda fleet repo add <group/app> --provider gitlab --host https://gitlab.corp.example \
  --read-token-file /secure/path/gitlab-read-token \
  --write-token-file /secure/path/gitlab-write-token
```

The repo path can include nested groups, for example `group/subgroup/app`. If the write token belongs to a human account, explicitly confirm that choice:

```bash
koda fleet repo add <group/app> --provider gitlab --confirm-bot \
  --read-token-file /secure/path/gitlab-read-token \
  --write-token-file /secure/path/gitlab-write-token
```

`--confirm-bot` confirms the account is intentionally being used as the bot identity; it does not change the account's identity or remove the warning. The API validates the project and both tokens during registration. Keep the returned repo ID for credential rotation and other repo-specific operations.

## Rotate credentials

Create replacement token files with the same required scopes, then rotate both or either credential. Rotation is available to a global administrator:

```bash
koda fleet repo credentials <repoId> \
  --read-token-file /secure/path/new-gitlab-read-token \
  --write-token-file /secure/path/new-gitlab-write-token
```

For a human-account write token, pass `--confirm-bot` when replacing it. A successful rotation clears the invalid state for the credentials replaced and evicts cached credentials for that repository.

## Token health and remediation

A GitLab `401` marks the token used for that call **invalid** until it is rotated. Check the GitLab credentials shown for the repository, then replace the rejected token with a newly issued token that has the required scopes. A token expiring within **14 days** is shown as **expiring**; renew it before expiry and rotate it in koda. If GitLab cannot provide an expiry date, koda cannot report an expiry warning for that token.

A token health warning is not fixed by retrying a job. A running job is not updated when credentials are rotated; retry or redispatch work that failed with the old credential.

## FIX and default-branch protection

A FIX job requires the repository's **default branch** to be protected, with the bot unable to push to it. This prevents FIX from writing directly to the default branch. If an operator intentionally needs to permit FIX without that protection, the repo's `fixAllowUnprotected` override must be on. This override is specific to FIX; prefer protecting the branch and granting the bot the minimum role needed.

## Self-hosted GitLab host restrictions

Use an HTTPS host URL. Private and LAN hosts are allowed. Loopback, link-local, and cloud-metadata addresses are refused. koda checks resolved addresses when credentials are saved and again for outbound calls, and GitLab requests do not follow redirects. The token is sent only to the exact host registered for the repository.

Until nax issue #2957 ships, the host name must contain `gitlab`. A self-hosted name without `gitlab` is refused at registration with `gitlab_host_unclassified`; use a GitLab-identifying host name until nax can explicitly classify the forge.

## Known differences from GitHub

GitLab has no comment-only token scope, so **REVIEW jobs use the write token**. The review workflow's existing guard prevents it from pushing, but the credential itself has write scope. Other read-only work uses the read token; do not weaken that separation.

koda **polls GitLab instead of receiving GitLab webhooks**. Merge request and review state updates therefore follow the existing polling behavior rather than arriving through inbound GitLab events.
