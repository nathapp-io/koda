/**
 * The story's scoped spec imports `ThreadJobRun` from here; the implementation lives in `src/thread/` beside the
 * rest of the thread kit (feature `fleet-s5a-thread-host`'s expected file). This module is an import-path alias
 * only — it holds no behaviour.
 */
export {
  ThreadJobRun,
  THREAD_EVENTS_FILE,
  type ThreadCommandOutcome,
  type ThreadHostDeps,
  type ThreadLogInput,
  type ThreadLogShipping,
  type ThreadOpenInput,
  type ThreadRunDeps,
  type ThreadRunSetup,
  type ThreadRunTuning,
  type ThreadSessionOpener,
  type ThreadSkillsInput,
  type ThreadWorktreeInput,
} from '../thread/thread-job-run';
