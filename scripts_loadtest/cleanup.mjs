// Deletes everything seed.mjs created (mirrors the cascade in
// /api/admin/drives/[id]/route.ts's DELETE handler): exam_sessions for the
// test candidates, the candidates themselves, the test questions, and
// finally the drive row. Run after run.mjs (and after you're done inspecting
// scripts_loadtest/report_*.json).
//
// Usage: node cleanup.mjs
import { supabase, loadState } from "./_lib.mjs";

const state = loadState();
console.log(`Cleaning up LOADTEST drive ${state.driveId} ("${state.driveTitle}")...`);

const { data: driveCandidates, error: candLookupError } = await supabase
  .from("candidates")
  .select("id")
  .eq("drive_id", state.driveId);
if (candLookupError) throw candLookupError;

const candidateIds = (driveCandidates || []).map((c) => c.id);
console.log(`Found ${candidateIds.length} candidates to remove.`);

if (candidateIds.length > 0) {
  // Chunk the .in() filter -- a few hundred UUIDs is fine in one query, but
  // stay well clear of any URL/query-size edge cases.
  const CHUNK = 200;
  for (let i = 0; i < candidateIds.length; i += CHUNK) {
    const chunk = candidateIds.slice(i, i + CHUNK);
    const { error } = await supabase.from("exam_sessions").delete().in("candidate_id", chunk);
    if (error) throw error;
  }
  console.log("Deleted exam_sessions.");

  for (let i = 0; i < candidateIds.length; i += CHUNK) {
    const chunk = candidateIds.slice(i, i + CHUNK);
    const { error } = await supabase.from("candidates").delete().in("id", chunk);
    if (error) throw error;
  }
  console.log("Deleted candidates.");
}

const { error: questionsError } = await supabase.from("questions").delete().eq("drive_id", state.driveId);
if (questionsError) throw questionsError;
console.log("Deleted questions.");

const { error: driveError } = await supabase.from("drives").delete().eq("id", state.driveId);
if (driveError) throw driveError;
console.log("Deleted drive.");

console.log("\nCleanup complete. Production tables are clear of load-test data.");
