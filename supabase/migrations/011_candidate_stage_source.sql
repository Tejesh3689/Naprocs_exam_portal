-- Tracks WHY a candidate is in their current `stage`, so a post-exam
-- cutoff change can safely re-run the EXAM_COMPLETED/TECH_ROUND decision
-- without ever touching a candidate an admin has already made a manual call
-- on (drag-and-drop in the Kanban board, the "Commit & Move" evaluation
-- button, or "Discard & Reject").
--
-- 'AUTO_CUTOFF': stage was last set by finalizeSession's score-vs-cutoff
--   check (src/lib/examTiming.ts) -- eligible for a future recalculation.
-- 'MANUAL': an admin explicitly set this candidate's stage some other way --
--   permanently excluded from any automatic recalculation from this point
--   on, even if they're later reset and re-take the exam (the reset flow
--   clears this back to null, and the next finalizeSession run sets it to
--   AUTO_CUTOFF again).
--
-- Backfill for existing rows, best-effort (this feature doesn't exist yet,
-- so there's no ground truth to recover -- these are reasonable defaults,
-- not certainties):
--   EXAM_COMPLETED / TECH_ROUND -> 'AUTO_CUTOFF'. This is the only bucket a
--     future recalculation ever touches, and it's how most candidates in it
--     got there (a few may have been manually dragged in pre-feature; worst
--     case a future recalculation reconsiders those too, which is a minor,
--     disclosed tradeoff for historical data only).
--   HR_ROUND / SELECTED / REJECTED -> 'MANUAL'. Nothing in this codebase
--     ever moves a candidate into these stages automatically -- only the
--     admin's "Commit & Move" / "Discard & Reject" actions do, so this is
--     unambiguous, and it doesn't matter anyway: the recalculation query
--     never looks at these stages regardless of stage_source.
--   EXAM_PENDING -> left null (not yet decided).
--
-- Run this once in the Supabase dashboard: SQL Editor -> New query -> Run.
-- Assumes 001-010 already ran.

alter table candidates
  add column if not exists stage_source text check (stage_source in ('AUTO_CUTOFF', 'MANUAL')),
  add column if not exists stage_recalculated_at timestamptz;

update candidates
  set stage_source = 'AUTO_CUTOFF'
  where stage in ('EXAM_COMPLETED', 'TECH_ROUND')
    and stage_source is null;

update candidates
  set stage_source = 'MANUAL'
  where stage in ('HR_ROUND', 'SELECTED', 'REJECTED')
    and stage_source is null;
