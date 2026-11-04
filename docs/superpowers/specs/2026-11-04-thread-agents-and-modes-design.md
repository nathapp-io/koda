# Thread agents and modes: `nax chat` parity for koda threads (#368 + #369)

Date: 2026-11-04. Status: design, awaiting approval. Issues: #368 (ACP backends), #369 (interactive coding threads).
#371 (C10 credential vault) was split out to its own later spec (user ruling 2026-11-04).

## Intent

koda threads are the chat surface of the fleet: a person (or an agent) talks to a coding agent that runs on a fleet
runner, grounded in a repo, a project or a workspace. Today a thread can only use koda's native agent, and only
read: it can brainstorm, read code and write docs, but it cannot edit code or run commands. `nax chat` already does
all of that on one machine.

The user has not started using koda day to day yet. The bar for this slice is **parity with `nax chat`**: the same
four agents, the same three permission modes, credentials kept on the machine running the agent. Anything beyond
`nax chat` (a central credential vault, new review flows) is out.

## Goals

1. A thread can run on any of the four agents `nax chat` offers: koda's native agent, and Claude Code, Codex and
   Cursor over ACP (`@nathapp/nax-agent-acp`).
2. A thread runs in one of three modes, as `nax chat` does:
   - `read`: today's behaviour (read code, write docs). The default.
   - `ask`: the agent may edit files and run shell commands, and every mutating action first appears in the
     thread as an approve/deny card.
   - `full`: the agent edits and runs commands without asking.
3. The mode can change between turns, like `nax chat`'s mode toggle.
4. Who may use `ask` and `full` is governed by koda permissions, configurable like every other key.
5. A runner advertises which ACP agents it can actually start (installed and logged in) and their models; the web
   new-thread form offers only those.

## Non-goals

- The central credential vault (#371). Credentials stay on the runner: the agent's own login for ACP, the runner's
  nax auth store (or its existing `credentials.source: exec` config) for native.
- A new place for code changes to go. Thread changes keep using the thread's worktree and the existing publish
  (commit to `feat/<feature>`) and discard actions. No PR creation from a thread, no hand-off to a RUN in this slice.
- New tools for ACP agents beyond what a koda thread already has. ACP agents bring their own file, shell and skill
  tools.
- Per-agent sandboxing beyond what `nax chat` does (see Constraints: ACP agents run unsandboxed).

## Anti-goals (failure even if it works)

- A developer, or an agent's key, reaching `full` mode without holding the `full` key, through a wildcard grant,
  an ownable-key path, or a mode change between turns.
- An approve/deny card that koda shows as decided while the session never received the decision (the agent hangs
  or proceeds on its own).
- A thread offering an agent the runner cannot start, so the first turn fails with a confusing error.

## Decisions (user, 2026-11-04)

- Bundle #368 + #369 into ONE nax run spec; #371 becomes its own spec afterwards.
- All four agents (native, Claude Code, Codex, Cursor).
- Parity with `nax chat` is the bar.
- `full` mode is included.
- `full` mode is allowed for ACP agents too, although ACP agents run **unsandboxed on the runner host** (as in
  `nax chat`, `allowUnsandboxed: true`). The user accepts this for koda's runners.
- Who may use the modes follows koda's existing configurable permissions. Default for `full`: **owner and project
  admin**.
- nax#2444 is done (closed 2026-10-12): `acpBackend` serves a session's declared tools to the ACP agent over its
  loopback tool host, pre-approved. So ACP is not limited to REPO threads: PROJECT and WORKSPACE threads may use
  ACP agents too, with koda's tools served through the tool host.

## Current state (verified 2026-11-04 on koda `7093ced1`, nax `f5902e425`)

- Runner refuses ACP: `ThreadSessionFactory.open` returns `backend_unavailable` for any `acp` backend
  (`apps/runner/src/thread/session-factory.ts:89`); the session profile is hard-coded `read` (`:116`).
- Runner capability probe reports `threadBackends: { native: <models>, acp: [] }` unconditionally
  (`apps/runner/src/capabilities/nax-probe.ts:161-167`).
- Protocol: `ThreadAgent = 'claude' | 'codex'` (no Cursor), `ThreadBackend = native | acp{agent}`,
  `ThreadAssign` has no mode field, `ThreadAnswerPayload { requestId, text }` is text only
  (`packages/fleet-protocol/src/threads.ts:12,21-26,70-97`). `ThreadFailReason` already has
  `backend_unavailable` and `agent_not_logged_in`.
- API: `acp` accepted only on REPO threads, agent `claude|codex`; PROJECT/WORKSPACE native-only citing nax#2444
  (`apps/api/src/fleet/threads/thread-input.ts:19-27,72-74,90`). Thread approvals already flow: the runner forwards
  nax-agent `approval_requested` / `approval_resolved` / `question` events as thread lines, the API ingests them,
  and `THREAD_ANSWER` reaches `session.answer(requestId, { text })` (`apps/runner/src/thread/thread-job-run.ts:921-932`).
- nax-agent: `AnswerReply = { decision: 'allow' | 'deny' } | { text }` (`packages/nax-agent/src/session/agent-session-types.ts:169`);
  profile `ask` = every mutating action is approved through `answer()` (`:18`). koda pins `@nathapp/nax-agent`
  `0.91.7` and does not depend on `@nathapp/nax-agent-acp`; both are published `latest 0.91.7`,
  `canary 0.91.8-canary.1`.
- Web: the new-thread form's backend picker offers native models only (`apps/web/pages/threads/new.vue:125-137`,
  `apps/web/lib/thread-create.ts:105-111`).
- Publish: `publishThreadDocs` commits every changed regular file in the thread worktree onto `feat/<feature>` with
  the message `docs(<feature>): spec from koda thread "<title>"` (`apps/runner/src/thread/thread-publish.ts`).
- Permissions: thread keys live in `apps/api/src/permissions/catalog.ts:96-108,235+`; the developer role holds
  `thread.create` and `thread.*.own` (`apps/api/src/permissions/system-roles.ts:86-87`); project admin and owner
  hold `*`.

## How `nax chat` does it (reference, nax `f5902e425`)

- Agents `claude | codex | cursor`; installed check `launchCandidateKind(agent, env)` (local binary or `npx`
  fallback); not-logged-in = an open failing with `AGENT_SESSION_AUTH_REQUIRED`
  (`packages/nax/src/chat/acp/acp-catalog.ts`).
- Model catalog per agent: a probe opens a tool-less, memory-only `ask` session, reads `backend.capabilities`, then
  closes (20 s timeout) (`chat/acp/acp-probe.ts`); models and effort levels are also learned from successful opens.
- `acpBackend({ agent, allowUnsandboxed: true, inheritEnv: true, model?, effort? })`
  (`chat/acp/acp-session-options.ts:61-68`).
- Modes: native opens profile `full`, with a guarded posture adding ask rules; ACP guarded → profile `ask`,
  full → profile `full` (`chat/chat-mode.ts`, `acp-session-options.ts:70`). Profiles `none|read|review` are
  enforced per ACP agent through mode, env or disallowed tools (`nax-agent-acp/src/client/registry.ts:23-53`).
- ACP turns are recorded into the chat transcript (`chat/acp/acp-recorder.ts`).

## Design

### 1. Dependency bump (the #367 prerequisite)

Bump `@nathapp/nax-agent` to `0.91.8-canary.1` and add `@nathapp/nax-agent-acp` `0.91.8-canary.1` to
`apps/runner`, exact pins. Move both to the stable release when it ships (a later chore, not this slice).

### 2. ACP agents on the runner (#368)

- **Advertise:** the runner's capability probe reports, per agent (`claude`, `codex`, `cursor`), whether it can be
  launched and whether it is logged in, plus its models and effort levels, using the same approach as `nax chat`
  (launch-candidate check, then a short tool-less probe session; an auth-required failure means "not logged in").
  My call (builder check Q3), following `nax chat`: "launchable" is `launchCandidateKind` answering a kind, so the
  `npx` fallback counts. The model probe session (which may run `npx` and fetch from npm) runs in the background
  with `nax chat`'s 20 s timeout and never delays or fails the runner's start; until it answers, a launchable agent
  is advertised without a model list.
  `threadBackends.acp` carries only agents that are launchable; a launchable but not-logged-in agent is reported
  as such so the web can explain why it is unavailable. The probe must stay bounded (it runs at runner start and
  re-probe) and must never fail the runner's start.
- **Protocol:** `ThreadAgent` gains `cursor`. `ThreadBackends.acp` changes from an empty list to the per-agent
  entries above (shape is the builder's, within the existing capability size limits).
- **Open:** `ThreadSessionFactory.open` opens an `acp` backend through `acpBackend` with the thread's model and
  effort, `allowUnsandboxed: true` and `inheritEnv: true`, and the session profile from the thread's mode (§3).
  The thread's koda tool set (the koda tool proxies, skill tools, and for REPO threads the read tools and
  `write_doc`) is passed as the session's declared tools, which `acpBackend` serves over its tool host
  (nax#2444). Failures map to existing reasons: agent cannot be launched → `backend_unavailable`; auth required →
  `agent_not_logged_in`.
- **Transcript and cost:** ACP turns land in the thread log the same way native turns do, and the thread's cost
  cap applies to ACP turns using the session's usage events (the ACP backend prices each turn's usage through one
  cost meter per agent process, nax-agent-acp `client/backend.ts`). My call (builder check Q4): an agent that
  reports no usage is not refused; its turns count as zero against the cap, and the thread shows its cost as
  "not reported". ACP agents bill the runner user's own agent login, not koda; `nax chat` has no cap at all.
- **API:** accept `acp` with `claude | codex | cursor` for REPO, PROJECT and WORKSPACE threads (drop the
  nax#2444 restriction), and place the thread only on a runner whose capabilities list that agent as available.
- **Web:** the new-thread form gets an agent picker (native, Claude Code, Codex, Cursor) with each agent's models;
  agents that no eligible runner can start are shown disabled with the reason (not installed / not logged in).

### 3. Thread modes (#369)

- **Modes:** `read | ask | full`, stored on the thread, default `read`. Mapping to the nax-agent session profile:

  | Mode | Native | ACP |
  |:--|:--|:--|
  | `read` | `read` (today) | `read` |
  | `ask` | `ask` | `ask` |
  | `full` | `full` (runner's sandbox config applies) | `full` (unsandboxed) |

  ACP sessions get **no embedder sandbox in any mode, for all three agents**: the runner opens `acpBackend` exactly
  as `nax chat` does (`{ agent, allowUnsandboxed: true, inheritEnv: true, model?, effort? }`, no sandbox option;
  nax `chat/acp/acp-session-options.ts:61-68`: "the agent gets the whole environment and none of nax's own
  sandbox"). So `full` on ACP means no path or network limits beyond the agent's own, and `ask` means every mutating
  action is approved but still runs unsandboxed once approved. (Builder check Q1; answered by parity.)

  Builder: if nax-agent's native `ask` profile behaves differently from `nax chat`'s guarded posture in a way that
  matters, match `nax chat`'s behaviour and record the choice.
- **Tools by mode:** in `ask` and `full`, the native agent gets nax-agent's edit and shell tools on top of today's
  thread tools; ACP agents bring their own. In `read`, nothing changes.
- **Where changes go:** edits happen only in the thread's own worktree. They leave through the existing publish
  action (commit to `feat/<feature>`) or are dropped by discard. The publish commit message stops saying "docs"
  when the commit contains non-doc paths (wording is the builder's).
- **Changing mode:** a thread's mode can change between turns, never during a turn. The change takes effect at
  the next turn. The thread log records who changed it, from what, to what. The switch follows `nax chat`'s
  state machine (nax `chat/session-switch.ts`): a mode change is never applied in place (the profile is fixed at
  open); the runner closes the session and reopens the **same session id** with the new profile, so the
  conversation continues. If that reopen fails it rolls back by reopening on the old mode; if even that fails it
  starts a new session on the old mode and the thread log shows a notice that context was lost. (Builder check Q2;
  answered by parity.)
- **Assign:** `ThreadAssign` carries the mode the runner must open the next session with.

### 4. Approvals in `ask` mode

- Every `approval_requested` event from the session shows in the thread as a card with what the agent wants to do
  (tool, command or file) and Approve / Deny.
- The answer reaches the session as a real decision: `THREAD_ANSWER` gains a decision form
  (`{ requestId, decision: 'allow' | 'deny' }`), passed to `session.answer(requestId, { decision })`. The existing
  text answer for questions stays.
- Who may answer: the existing `thread.answer` key (and its own-form for the thread's creator), unchanged.
- An approval left unanswered keeps the turn waiting; ending the turn or the session cancels it, as today.

### 5. Permissions

- Two new catalog keys, project scope, NOT ownable: `thread.mode.ask` and `thread.mode.full`. They are required to
  create a thread in, or switch a thread to, that mode (create and the mode-change route both check). `read` needs
  no new key.
- Defaults: `thread.mode.full` → owner and project admin (both already hold `*`; no other role gets it).
  `thread.mode.ask` → developer and above (my call: it is the supervised mode).
- They must be configurable through roles and bindings like every other key, and approvable for agents through the
  normal approval policy (an agent asking for `ask`/`full` waits for its approval by default).
- The developer role's `thread.*.own` own-form grant must NOT cover these keys (they are not ownable).

## Constraints

- ACP agents run unsandboxed on the runner host in every mode (user-accepted). The runner machine must have the
  agent installed and logged in under the runner's user; koda never stores ACP credentials.
- Runner is Bun-only; nax-agent and nax-agent-acp are consumed as published npm packages at exact pins.
- The existing thread invariants stay: one turn at a time, the thread worktree is the only write surface the koda
  publish/discard actions touch, cost cap per thread, approvals relayed as thread lines.
- The `thread` log stream and capability report limits (`THREAD_STREAM_LIMITS`, the 64 KiB capability budget)
  still bound everything added.

## Left to the builder

- The exact capability shape for ACP agents, probe timeouts and caching, and how a re-probe is triggered.
- Whether a mode change reopens the session with a resume/hand-off or reconfigures it in place, provided the
  conversation continues.
- The web layout of the agent picker, the mode control and the approval card.
- Commit message wording for code publishes.
- Story split (target: one nax run, about 12-14 stories across api, runner, web and protocol).

## Out of scope, recorded

- #371 C10 credential vault: its own spec next.
- Interaction with nax#2788 (login-only forge identity) and koda #394 (ruling guards): unrelated.
