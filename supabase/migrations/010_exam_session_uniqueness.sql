-- Prevents a candidate from ever having two IN_PROGRESS exam_sessions rows
-- at once. Without this, two near-simultaneous requests to
-- GET /api/exam/questions for the same candidate (React Strict Mode's
-- double-invoked effect, a slow network prompting a retry, two open tabs)
-- can both see "no existing session" and both INSERT one, each independently
-- sampling its own question_ids. Every later request's
-- `.eq("status","IN_PROGRESS").maybeSingle()` lookup then finds two rows,
-- which Postgres/PostgREST treats as an error -- surfaced to the client as a
-- generic 500 that useExamSync silently swallows (no `success`, no
-- `expired`), producing the same "stuck on Initializing..." symptom as the
-- empty-question-bank incident this migration accompanies.
--
-- A partial unique index turns the loser of that race into a clean
-- unique_violation (Postgres code 23505) at INSERT time instead of two
-- coexisting rows; src/app/api/exam/questions/route.ts catches that code and
-- re-fetches the winner's session rather than erroring out.
create unique index if not exists exam_sessions_one_in_progress_idx
  on exam_sessions (candidate_id)
  where status = 'IN_PROGRESS';
