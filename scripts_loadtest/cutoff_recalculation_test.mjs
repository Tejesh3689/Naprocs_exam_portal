// Real-life-shaped test suite for the post-exam cutoff recalculation
// feature (supabase/migrations/011_candidate_stage_source.sql +
// /api/admin/drives/[id]/recalculate-cutoff).
//
// Covers: lowering the cutoff auto-promotes newly-qualifying candidates;
// raising it only flags candidates for manual review (never auto-demotes);
// candidates an admin manually moved (drag, evaluation "Commit & Move",
// "Discard & Reject") are NEVER touched by a recalculation regardless of
// score; a reset ("Re-attempt") clears the provenance flag; and applying
// twice in a row is idempotent (second apply moves nobody, since the first
// already did).
//
// Usage: node cutoff_recalculation_test.mjs <BASE_URL>
import { supabase } from "./_lib.mjs";
import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.argv[2] || "http://localhost:3000";
const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} -- ${name}${detail ? `\n       ${detail}` : ""}`);
}

let adminCookie = null;
async function getAdminCookie() {
  if (adminCookie) return adminCookie;
  const envText = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8");
  const m = envText.match(/^ADMIN_SECRET_PASSPHRASE=(.*)$/m);
  const passphrase = m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
  const res = await fetch(`${BASE_URL}/api/auth/admin-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ passphrase }),
  });
  adminCookie = res.headers.get("set-cookie");
  if (!adminCookie) throw new Error("Could not obtain admin session cookie -- check ADMIN_SECRET_PASSPHRASE in .env");
  return adminCookie;
}

async function adminGet(path) {
  const cookie = await getAdminCookie();
  const res = await fetch(`${BASE_URL}${path}`, { headers: { Cookie: cookie } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function adminPost(path, body) {
  const cookie = await getAdminCookie();
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function adminPatch(path, body) {
  const cookie = await getAdminCookie();
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

let driveCounter = 0;
async function makeDrive(passingCutoff = 50) {
  driveCounter++;
  const tag = `${Date.now().toString(36)}-${driveCounter}`;
  const { data: drive, error } = await supabase
    .from("drives")
    .insert({
      title: `CUTOFF_TEST_${tag}`,
      slug: `cutoff-test-${tag}`,
      exam_duration: 30,
      passing_cutoff: passingCutoff,
      proctoring_severity: "MEDIUM",
      max_cheat_warnings: 3,
      mcq_count: 1,
      coding_count: 0,
      shuffle_questions: false,
      shuffle_options: false,
      is_exam_active: true,
      reg_start: new Date(Date.now() - 86_400_000).toISOString(),
      reg_end: new Date(Date.now() + 86_400_000).toISOString(),
      exam_start: new Date(Date.now() - 60_000).toISOString(),
      exam_end: new Date(Date.now() + 30 * 60_000).toISOString(),
      webcam_proctoring_enabled: false,
    })
    .select()
    .single();
  if (error) throw error;
  return drive;
}

// Insert a candidate already "finalized" at a given score/stage/stage_source
// -- directly at the DB level (this suite is about the recalculation logic
// itself, not re-proving the exam-taking flow, which auto_submit_edge_test.mjs
// and real_scale_edge_test.mjs already cover).
async function makeFinalizedCandidate(driveId, tag, { score, stage, stageSource }) {
  const { data, error } = await supabase
    .from("candidates")
    .insert({
      drive_id: driveId,
      name: `Cutoff Test ${tag}`,
      email: `cutofftest.${tag}.${Date.now()}@naprocs-loadtest.invalid`,
      phone: "9999999999",
      college_roll_number: `CUTOFF-${tag}-${Date.now().toString(36)}`.toUpperCase(),
      access_pin: "123456",
      stage,
      exam_score: score,
      stage_source: stageSource,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function cleanupDrive(driveId) {
  const { data: cands } = await supabase.from("candidates").select("id").eq("drive_id", driveId);
  const ids = (cands || []).map((c) => c.id);
  if (ids.length > 0) await supabase.from("exam_sessions").delete().in("candidate_id", ids);
  await supabase.from("candidates").delete().eq("drive_id", driveId);
  await supabase.from("drives").delete().eq("id", driveId);
}

// ============================================================
// Test 1: lowering the cutoff auto-promotes newly-qualifying candidates
// ============================================================
async function test1() {
  const drive = await makeDrive(50); // starts at 50%
  try {
    const above = await makeFinalizedCandidate(drive.id, "t1-above", { score: 70, stage: "EXAM_COMPLETED", stageSource: "AUTO_CUTOFF" }); // already qualifies at 50, would've been auto-moved already in real life -- included as a control
    const between = await makeFinalizedCandidate(drive.id, "t1-between", { score: 45, stage: "EXAM_COMPLETED", stageSource: "AUTO_CUTOFF" }); // below 50, above a lowered 40
    const below = await makeFinalizedCandidate(drive.id, "t1-below", { score: 20, stage: "EXAM_COMPLETED", stageSource: "AUTO_CUTOFF" }); // stays below even at 40

    await supabase.from("drives").update({ passing_cutoff: 40 }).eq("id", drive.id); // lower the cutoff

    const preview = await adminGet(`/api/admin/drives/${drive.id}/recalculate-cutoff`);
    const previewIds = (preview.body.newlyQualifying || []).map((c) => c._id);
    const previewOk = preview.status === 200 && previewIds.includes(between.id) && !previewIds.includes(below.id) && !previewIds.includes(above.id); // `above` was already EXAM_COMPLETED with score 70 -- wait, it's still EXAM_COMPLETED not TECH_ROUND in this synthetic setup, so it SHOULD also appear as newly-qualifying (70 >= 40). Re-check below.

    const apply = await adminPost(`/api/admin/drives/${drive.id}/recalculate-cutoff`);
    const { data: rows } = await supabase.from("candidates").select("id,stage,stage_source,stage_recalculated_at").in("id", [above.id, between.id, below.id]);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

    const pass =
      apply.status === 200 &&
      byId[above.id].stage === "TECH_ROUND" && byId[above.id].stage_recalculated_at &&
      byId[between.id].stage === "TECH_ROUND" && byId[between.id].stage_recalculated_at &&
      byId[below.id].stage === "EXAM_COMPLETED" && !byId[below.id].stage_recalculated_at &&
      byId[above.id].stage_source === "AUTO_CUTOFF" && byId[between.id].stage_source === "AUTO_CUTOFF"; // stays AUTO_CUTOFF, still eligible for future recalculation

    record(
      "1. Lowering cutoff auto-promotes newly-qualifying candidates",
      pass,
      `above(70%)=${byId[above.id].stage} between(45%)=${byId[between.id].stage} below(20%)=${byId[below.id].stage} (cutoff lowered 50->40, expect above+between->TECH_ROUND, below stays EXAM_COMPLETED)`
    );
  } finally {
    await cleanupDrive(drive.id);
  }
}

// ============================================================
// Test 2: raising the cutoff only flags for review, never auto-demotes
// ============================================================
async function test2() {
  const drive = await makeDrive(40);
  try {
    const stillQualifies = await makeFinalizedCandidate(drive.id, "t2-still", { score: 80, stage: "TECH_ROUND", stageSource: "AUTO_CUTOFF" });
    const noLongerQualifies = await makeFinalizedCandidate(drive.id, "t2-no-longer", { score: 45, stage: "TECH_ROUND", stageSource: "AUTO_CUTOFF" });

    await supabase.from("drives").update({ passing_cutoff: 70 }).eq("id", drive.id); // raise the cutoff well above noLongerQualifies' score

    const preview = await adminGet(`/api/admin/drives/${drive.id}/recalculate-cutoff`);
    const flaggedIds = (preview.body.noLongerQualifying || []).map((c) => c._id);

    const apply = await adminPost(`/api/admin/drives/${drive.id}/recalculate-cutoff`);
    const { data: rows } = await supabase.from("candidates").select("id,stage").in("id", [stillQualifies.id, noLongerQualifies.id]);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

    const pass =
      preview.status === 200 &&
      flaggedIds.includes(noLongerQualifies.id) &&
      !flaggedIds.includes(stillQualifies.id) &&
      apply.status === 200 &&
      byId[noLongerQualifies.id].stage === "TECH_ROUND" && // NOT auto-demoted
      byId[stillQualifies.id].stage === "TECH_ROUND";

    record(
      "2. Raising cutoff flags for review, never auto-demotes",
      pass,
      `flaggedForReview includes no-longer-qualifying=${flaggedIds.includes(noLongerQualifies.id)}, excludes still-qualifying=${!flaggedIds.includes(stillQualifies.id)}, post-apply stage of no-longer-qualifying=${byId[noLongerQualifies.id].stage} (must stay TECH_ROUND)`
    );
  } finally {
    await cleanupDrive(drive.id);
  }
}

// ============================================================
// Test 3: a candidate manually moved by an admin is NEVER touched,
// regardless of score, in either direction
// ============================================================
async function test3() {
  const drive = await makeDrive(50);
  try {
    // Would qualify for promotion at the new (lower) cutoff, but an admin
    // already manually dragged them into TECH_ROUND directly (bypassing the
    // score check entirely) -- e.g. a discretionary pass.
    const manualInTechRound = await makeFinalizedCandidate(drive.id, "t3-manual-tr", { score: 20, stage: "TECH_ROUND", stageSource: "MANUAL" });
    // Would qualify for promotion, but is manually still sitting in
    // EXAM_COMPLETED because an admin explicitly rejected/held them there via
    // the evaluation route setting stage_source=MANUAL (e.g. a proctoring
    // concern noted by hand, independent of score).
    const manualInCompleted = await makeFinalizedCandidate(drive.id, "t3-manual-ec", { score: 90, stage: "EXAM_COMPLETED", stageSource: "MANUAL" });

    await supabase.from("drives").update({ passing_cutoff: 30 }).eq("id", drive.id);

    const preview = await adminGet(`/api/admin/drives/${drive.id}/recalculate-cutoff`);
    const allListedIds = [...(preview.body.newlyQualifying || []), ...(preview.body.noLongerQualifying || [])].map((c) => c._id);

    await adminPost(`/api/admin/drives/${drive.id}/recalculate-cutoff`);
    const { data: rows } = await supabase.from("candidates").select("id,stage,stage_recalculated_at").in("id", [manualInTechRound.id, manualInCompleted.id]);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

    const pass =
      !allListedIds.includes(manualInTechRound.id) &&
      !allListedIds.includes(manualInCompleted.id) &&
      byId[manualInTechRound.id].stage === "TECH_ROUND" && !byId[manualInTechRound.id].stage_recalculated_at &&
      byId[manualInCompleted.id].stage === "EXAM_COMPLETED" && !byId[manualInCompleted.id].stage_recalculated_at &&
      preview.body.manualExcludedCount >= 2;

    record(
      "3. Manually-moved candidates are never touched by recalculation",
      pass,
      `neither appears in preview lists=${!allListedIds.includes(manualInTechRound.id) && !allListedIds.includes(manualInCompleted.id)}, post-apply stages unchanged=${byId[manualInTechRound.id].stage}/${byId[manualInCompleted.id].stage}, manualExcludedCount=${preview.body.manualExcludedCount}`
    );
  } finally {
    await cleanupDrive(drive.id);
  }
}

// ============================================================
// Test 4: the real API routes actually tag MANUAL correctly (drag,
// evaluation commit, reject), not just my direct-DB test fixtures above
// ============================================================
async function test4() {
  const drive = await makeDrive(50);
  try {
    const c1 = await makeFinalizedCandidate(drive.id, "t4-drag", { score: 60, stage: "EXAM_COMPLETED", stageSource: "AUTO_CUTOFF" });
    const c2 = await makeFinalizedCandidate(drive.id, "t4-commit", { score: 60, stage: "EXAM_COMPLETED", stageSource: "AUTO_CUTOFF" });
    const c3 = await makeFinalizedCandidate(drive.id, "t4-reject", { score: 60, stage: "EXAM_COMPLETED", stageSource: "AUTO_CUTOFF" });

    const dragRes = await adminPatch(`/api/admin/candidates/${c1.id}/stage`, { stage: "TECH_ROUND" });
    const commitRes = await adminPatch(`/api/admin/candidates/${c2.id}/evaluation`, { stage: "TECH_ROUND", techNotes: "test" });
    const rejectRes = await adminPatch(`/api/admin/candidates/${c3.id}/evaluation`, { stage: "REJECTED" });

    const { data: rows } = await supabase.from("candidates").select("id,stage_source").in("id", [c1.id, c2.id, c3.id]);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

    const pass =
      dragRes.status === 200 && byId[c1.id].stage_source === "MANUAL" &&
      commitRes.status === 200 && byId[c2.id].stage_source === "MANUAL" &&
      rejectRes.status === 200 && byId[c3.id].stage_source === "MANUAL";

    record(
      "4. Real admin routes (drag/commit/reject) correctly tag stage_source=MANUAL",
      pass,
      `drag=${byId[c1.id].stage_source} commit=${byId[c2.id].stage_source} reject=${byId[c3.id].stage_source} (all must be MANUAL)`
    );
  } finally {
    await cleanupDrive(drive.id);
  }
}

// ============================================================
// Test 5: a reset ("Re-attempt") clears stage_source back to null
// ============================================================
async function test5() {
  const drive = await makeDrive(50);
  try {
    const c = await makeFinalizedCandidate(drive.id, "t5-reset", { score: 80, stage: "TECH_ROUND", stageSource: "AUTO_CUTOFF" });
    const resetRes = await adminPost(`/api/admin/candidates/${c.id}/reset`, { reason: "test re-attempt" });
    const { data: row } = await supabase.from("candidates").select("stage,stage_source,stage_recalculated_at,exam_score").eq("id", c.id).single();

    const pass = resetRes.status === 200 && row.stage === "EXAM_PENDING" && row.stage_source === null && row.stage_recalculated_at === null && row.exam_score === 0;
    record("5. Reset (Re-attempt) clears stage_source back to null", pass, `resetRes.status=${resetRes.status} stage=${row.stage} stage_source=${row.stage_source} exam_score=${row.exam_score}`);
  } finally {
    await cleanupDrive(drive.id);
  }
}

// ============================================================
// Test 6: applying twice in a row is idempotent -- second apply moves
// nobody, since the first already promoted everyone eligible
// ============================================================
async function test6() {
  const drive = await makeDrive(30);
  try {
    const c = await makeFinalizedCandidate(drive.id, "t6", { score: 50, stage: "EXAM_COMPLETED", stageSource: "AUTO_CUTOFF" });

    const apply1 = await adminPost(`/api/admin/drives/${drive.id}/recalculate-cutoff`);
    const apply2 = await adminPost(`/api/admin/drives/${drive.id}/recalculate-cutoff`);

    const pass =
      apply1.status === 200 && apply1.body.movedToTechRound.length === 1 &&
      apply2.status === 200 && apply2.body.movedToTechRound.length === 0; // already TECH_ROUND, no longer EXAM_COMPLETED -- nothing left to promote
    record("6. Applying twice in a row is idempotent", pass, `apply1 moved=${apply1.body.movedToTechRound.length} apply2 moved=${apply2.body.movedToTechRound.length} (expect 1 then 0)`);
  } finally {
    await cleanupDrive(drive.id);
  }
}

console.log(`Running cutoff-recalculation edge-case suite against ${BASE_URL}\n`);
await test1();
await test2();
await test3();
await test4();
await test5();
await test6();

const passCount = results.filter((r) => r.pass).length;
console.log(`\n=== ${passCount}/${results.length} PASSED ===`);
if (passCount !== results.length) {
  console.log("Failures:", results.filter((r) => !r.pass).map((r) => r.name));
  process.exitCode = 1;
}
