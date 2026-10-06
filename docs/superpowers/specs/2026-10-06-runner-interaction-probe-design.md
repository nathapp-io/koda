# Runner interaction-plugin probe (#207) — Design

Closes the remaining part of koda #207. PR #211 (merged 2026-10-04) shipped fix directions 1 and 3: a bounded,
sanitized `nax.stderr` lifecycle event when PLAN produces no PRD or RUN no status file, and the documented
`naxCommand` wrapper plus private `nax.env` for the service environment (`docs/deployment/runner.md`). This document
covers direction 2: detect, before a job runs, that the machine's resolved nax configuration cannot initialise its
interaction plugin in the runner's environment, and keep jobs off that runner.

## Goal

A runner whose nax interaction plugin cannot initialise (the 2026-10-04 case: `telegram` configured, the service
environment lacks `NAX_TELEGRAM_TOKEN`) reports it in its capabilities, placement does not send it jobs that would
use that configuration, and the admin dashboard shows why. Today the runner reports itself healthy, takes the job,
and the job fails with `no prd.json produced`.

## Success criteria

1. With nax that carries the new field, a runner whose base nax config has a failing interaction plugin reports
   `capabilities.interaction = { ok: false, plugin: 'telegram', code: 'TELEGRAM_NOT_CONFIGURED' }` and logs a probe
   warning `interaction telegram: TELEGRAM_NOT_CONFIGURED`.
2. A job dispatched with no profiles stays QUEUED on such a runner with misfit `interaction`; a pinned dispatch to it
   answers 201 (the misfit is not permanent).
3. A named profile whose resolved config fails the check is still reported, with
   `profiles[name].interaction.ok === false`, and placement gives misfit `interaction` for jobs naming it.
4. The post-checkout job check refuses a job whose effective chain (repo config included) fails, with stateReason
   `capability mismatch: interaction <plugin> (<code>)`, before nax spawns.
5. The admin dashboard's `runner_unhealthy` item for that runner carries an `interaction` condition (project scope
   sees `configuration`, unchanged rule).
6. Fixing the environment and refreshing capabilities clears all of the above without a restart of the API.
7. Older nax (field absent) and older runners (fields absent) change nothing: absent means unknown, never a misfit.
8. The check costs no network call and no model call.

## Rulings (user, 2026-10-06)

- **R1** A failing interaction plugin **blocks placement** (not warn-only, and #207 is not closed as done by #211).
- **R2** The check lives in nax as a new `interaction` field on `nax config --json` (approach A); not a new nax
  command (B), not koda re-implementing plugin rules from a list of required env vars (C). koda never duplicates
  plugin-specific rules (#211).
- **R3** Jobs with no profiles run on the machine's base config, which the probe did not check; the base result is
  carried as a new optional protocol field and placement adds misfit `interaction` for them (not pre-start-only).
- **R4** Branch `fix/207-interaction-probe`; #207 stays open until the live check (§6.3) passes.

## Ground truth (verified 2026-10-06)

- nax `main`: `packages/nax/src/interaction/init.ts` `initInteractionChain` builds the plugin from
  `config.interaction.plugin` and calls `init()`; a throw is logged as `Failed to initialize interaction plugin` and
  aborts the run. Plugins: `cli` (init skips when stdin is not a TTY; `initInteractionChain` skips cli entirely when
  headless), `telegram` (init only resolves `botToken`/`chatId` from config or env and throws
  `TELEGRAM_NOT_CONFIGURED`; the comment states there is no network call at init), `webhook` (init validates `url` and
  `secret`, throws `WEBHOOK_URL_MISSING` / `WEBHOOK_SECRET_MISSING`; binds nothing). Removed `auto` throws
  `INTERACTION_PLUGIN_REMOVED`, unknown names `INTERACTION_PLUGIN_UNKNOWN`.
- nax `packages/nax/src/cli/config-json.ts` emits `{ profile, profileChain, sources, requirements, config }`, exit 0 on
  success. `nax config --json` resolves config but does not initialise plugins (why #211 could not probe it).
- koda runner `capabilities/nax-probe.ts` resolves each `<naxHome>/profiles/*.json` with
  `config -d <emptyDir> --profile <name> --json`; a failing profile is **omitted** with warning
  `profile <name> skipped: <code>`. It never resolves the base config without a profile.
- koda API `fleet/jobs/placement-rules.ts:52-54`: a profile name the runner does not report is treated as
  repo-provided and skipped. **Omitting a profile therefore does not block placement**; only the post-checkout job
  check (`capabilities/job-check.ts`) catches it. A job with `profiles: []` passes the profile loop on any runner.
- koda API `fleet/common/capabilities-core.ts` `parseCapabilitiesCore` destructures known keys and returns a clean
  copy: unknown top-level keys are dropped, so new optional fields are wire-compatible in both directions without a
  `FLEET_PROTOCOL_VERSION` bump.
- Dashboard: `attention-runners.ts` builds `runner_unhealthy` conditions (`offline`, `credential`, `stale_nax`);
  `attention-rules.ts:42` replaces every non-offline condition with `configuration` for project scope;
  severity is `error` when a credential condition coincides with the runner blocking queued jobs
  (`providerBlockedRunnerIds` from `attention-unplaceable.ts`).

## 1. nax contract

New field on the `nax config --json` document, sibling of `requirements`:

```ts
interaction: {
  plugin: string | null;               // config.interaction.plugin, null when there is no interaction config
  status: 'ok' | 'failed' | 'skipped';
  code?: string;                       // failed only
  message?: string;                    // failed only, redacted, <= 300 chars
}
```

- `skipped`: no `interaction` config, or plugin `cli` while headless (the same rule `initInteractionChain` applies;
  headless = stdin not a TTY, which is always true under the runner).
- Otherwise nax creates the plugin with the same factory `initInteractionChain` uses (export `createInteractionPlugin`
  from `init.ts` or move it to a shared module), calls `init(config.interaction.config ?? {})`, then always
  `destroy()` when the plugin has one. `ok` on success.
- `failed`: `code` = the thrown `NaxError` code; any other throw (including a schema `parse` error) =
  `INTERACTION_INIT_FAILED`. `message` passes through nax's existing secret redaction and is truncated.
- Must not log through the run logger (no `Initialized ... plugin` info line, no error line) and must not make a
  network call; the check runs inside `config --json`, which is a read-only command.
- Exit code and the rest of the document are unchanged: a failing plugin is data, not a command failure.
- The field is computed from the same resolved config the command prints (`-d`, `--profile` chain honoured).
- Delivery: nax SPEC (spec-kit) -> `nax plan` -> `nax run`, each billed step with explicit approval, then a nax PATCH
  release on approval. The nax checkout is in use by another session at the time of writing; the nax SPEC is drafted
  when it is free.

## 2. Protocol (`packages/fleet-protocol`)

```ts
/** #207: nax's verdict on initialising the resolved config's interaction plugin (`nax config --json` `interaction`). */
export interface InteractionCheck {
  ok: boolean;
  plugin: string | null;
  code?: string;
}

export interface ProfileNeeds {
  protocol: NaxProtocol;
  providers: string[];
  sandbox: boolean;
  interaction?: InteractionCheck;      // absent: nax too old to say
}

export interface RunnerCapabilities {
  // ...existing fields...
  interaction?: InteractionCheck;      // the base config (no profile); absent: nax too old to say
}
```

- `ok` = nax `status !== 'failed'` (`skipped` is ok). `message` is not carried: it is free text, and the code plus
  plugin name are enough for placement, the dashboard and i18n. The runner logs the message locally.
- No `FLEET_PROTOCOL_VERSION` bump (ground truth: unknown keys are dropped by an older API).

## 3. Runner (`apps/runner`)

### 3.1 Parsing

`capabilities/nax-json.ts`: `parseInteraction(json): InteractionCheck | undefined` reads `interaction` from a
`config --json` document. Absent or malformed -> `undefined` (unknown), never a failure: a malformed field from a
future nax must not make every profile look broken. `parseRequirements`/`toProfileNeeds` carry it into
`ProfileNeeds.interaction`.

### 3.2 Probe (`capabilities/nax-probe.ts`)

- Also resolve the base config once: `config -d <emptyDir> --json` (no `--profile`), in parallel with the existing
  scans. Its `interaction` becomes `capabilities.interaction` (omitted when unknown). A failing base resolve is a
  warning (`base config resolve failed (<code>)`) and leaves the field absent.
- Per profile: keep the existing behaviour for resolve failures (omitted, `profile <name> skipped: <code>`); a
  resolved profile carries its `interaction`.
- Warnings for every `ok: false`: `interaction <plugin> failed for the base config: <code>` and
  `interaction <plugin> failed for profile <name>: <code>`; the nax `message` is appended in parentheses after
  `sanitizeDiagnostic` (it is already redacted by nax; sanitising again is the runner's rule for free text).
- `boundReport` is unaffected in practice (a few dozen bytes per profile); no new shedding rule.

### 3.3 Job check (`capabilities/job-check.ts`)

After `parseRequirements` on the job's chain resolved in the clone, and before `firstMismatch` runs: if the document's `interaction` is known and `status === 'failed'`, return
`capability mismatch: interaction <plugin> (<code>)`. Order relative to the existing checks: trust, resolve,
**interaction**, then protocol / providers / sandbox. This is the exact check (nax merged the real chain, repo config
included); placement's per-profile check (§4) is an approximation.

## 4. API (`apps/api`)

### 4.1 Validator (`fleet/common/capabilities-core.ts`)

Strict like `approvals` (D271): `interaction` (top level and inside each profile), when present, must be an object
with exactly `ok` (boolean), `plugin` (string <= 64 chars or null) and optionally `code` (string matching
`^[A-Z0-9_]{1,64}$`); anything else fails the whole report (`fail('interaction')`, `fail('profile <name>')`). The
clean copy keeps the field only when present.

### 4.2 Placement (`fleet/jobs/placement-rules.ts`)

- `MisfitReason` gains `'interaction'`; **not** in `PERMANENT_MISFITS` (an env fix plus a re-probe clears it, so a
  pinned dispatch answers 201 and the job queues, like `provider_unavailable`).
- In `capabilityMisfit`, inside the per-profile loop after the sandbox check:
  `if (needs.interaction?.ok === false) return 'interaction';`
- After the loop: `if (job.profiles.length === 0 && caps.interaction?.ok === false) return 'interaction';`
- A job that names profiles is judged on those profiles only, not on the base result: each reported profile's result
  already includes the base config it overlays.
- **Accepted approximation:** each profile is judged alone, but nax merges a chain in order, so a chain `a,b` where
  `b` replaces `a`'s broken plugin would be blocked although it would run. Rare; the job check (§3.3) is exact.
- Every consumer of `MisfitReason` follows: `PlacementMisfitDto` enum, the dashboard `MISFIT_REASONS` list, the
  OpenAPI document and the generated CLI client (regenerated, not hand-edited), `apps/web/lib/fleet-types.ts`.

### 4.3 Dashboard (`fleet/dashboard`)

- `CONDITION_TYPES` gains `'interaction'`; `RunnerCondition` gains optional `plugin`, `code` and `profile`
  (absent `profile` = base config). DTO and OpenAPI follow.
- `attention-runners.ts`: one condition per failing check — the base config first, then profiles by name — capped
  at the first 5 with no new total field (a runner with many broken profiles almost always has one broken base).
- Severity: today `error` when a credential condition coincides with the runner blocking queued jobs. Generalise the
  blocked set so `interaction` misfits also add the runner (`PROVIDER_REASONS` -> a `RUNNER_FIXABLE_REASONS` set of
  `provider_missing`, `provider_unavailable`, `interaction`), and the error rule becomes "a credential or interaction
  condition and the runner blocks queued jobs".
- Project scope is unchanged: `attention-rules.ts:42` already maps any non-offline condition to `configuration`.

## 5. Web and CLI

- en + zh strings: misfit `interaction` ("The runner's nax interaction plugin cannot start (check the service
  environment)") and the `interaction` runner condition, rendered with plugin, code and profile (or "base config").
  The locale parity test enforces both languages.
- `fleet-types.ts` unions; any `switch`/record over `MisfitReason` or `ConditionType` gets the new member (the type
  checker finds them).
- CLI: regenerated client; `koda fleet status` prints the condition through its existing generic condition rendering
  (verify; add a case if it switches on the type).
- `docs/deployment/runner.md`: replace "A general plugin-initialization dry probe requires nax support" with what the
  probe now reports, the nax version that carries it, and that the wrapper remains the way to supply env.

## 6. Testing

### 6.1 nax

Unit tests for the check: no interaction config (skipped); cli headless (skipped); telegram with and without env
(ok / `TELEGRAM_NOT_CONFIGURED`); webhook without url / without secret; `auto` (`INTERACTION_PLUGIN_REMOVED`);
unknown plugin; a non-NaxError throw (`INTERACTION_INIT_FAILED`); `destroy()` always called; message redacted and
truncated; no fetch performed. `config --json` test: field present, exit 0 on a failing plugin, `--profile` chain
honoured.

### 6.2 koda

- Protocol / validator: valid top-level and per-profile fields kept; extra keys, non-boolean `ok`, bad `code`, long
  `plugin` rejected; absent kept absent.
- Placement table: named profile `ok: false` -> `interaction`; no profiles + base `ok: false` -> `interaction`;
  profiles named + base `ok: false` + profile ok -> fits; fields absent -> fits; pinned dispatch -> 201 and queued.
- Runner: probe with `FakeNaxCli` (base ok/failed/absent, profile ok/failed/absent, base resolve failure) and warning
  text; job check refusal reason and its order after resolve.
- Dashboard: condition built for base and profile failures, cap of 5, severity error when the runner blocks a queued
  job through `interaction`, project scope shows `configuration`.
- Web: Jest for the labels; locale parity; existing fleet E2E stays green (no new E2E: the state depends on the
  runner's environment).

### 6.3 Live check (koda-wk, after the nax release)

1. Runner service on the released nax; remove `NAX_TELEGRAM_*` from the service env file; refresh capabilities.
2. Probe warning present; `GET /fleet/dashboard` shows `runner_unhealthy` with the `interaction` condition.
3. Dispatch a no-profile PLAN: stays QUEUED, dispatch dry-run misfit `interaction`.
4. Restore the env, refresh capabilities: the job places and runs.

## 7. Rollout

nax release -> koda API -> runners (API first, as for protocol v2). The koda PR may merge before the nax release
(every new field is optional and absent means unknown); the live check needs the released nax. An older API given a
newer runner drops the fields and places as today.

## Out of scope

- Other env a nax config reads at runtime outside the interaction plugin (none known to fail at startup today). If
  one appears, the same pattern applies: nax reports it in `config --json`, koda carries it.
- Exact chain evaluation in placement (sending whole chains to the API).
- Any change to how env reaches the service (the #211 wrapper stays the supported way).
