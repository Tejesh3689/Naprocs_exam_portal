// Seeds a disposable "LOADTEST_*" drive + a small real question bank (5 MCQ,
// 1 coding problem with 3 test cases, all independently verified solvable in
// every supported language) + N fake candidate rows, directly via the
// service-role Supabase client (bypassing registration entirely -- this test
// exercises exam-taking concurrency, not registration).
//
// Usage: node seed.mjs <candidateCount> [durationMinutes]
//   node seed.mjs 10        (dry run)
//   node seed.mjs 600 20    (full run, 20-minute exam window)
//
// Writes scripts_loadtest/loadtest_state.json for run.mjs and cleanup.mjs to
// consume. Run cleanup.mjs when done -- this leaves real rows in production
// tables until you do.
import { supabase, saveState } from "./_lib.mjs";

const count = parseInt(process.argv[2] || "10", 10);
const durationMinutes = parseInt(process.argv[3] || "15", 10);
const runTag = Date.now().toString(36);

console.log(`Seeding LOADTEST drive for ${count} candidates, ${durationMinutes}-minute window (runTag=${runTag})...`);

const now = new Date();
const examStart = new Date(now.getTime() - 60_000); // already "open" by 1 min
const examEnd = new Date(now.getTime() + (durationMinutes + 5) * 60_000); // buffer past the intended run

const { data: drive, error: driveError } = await supabase
  .from("drives")
  .insert({
    title: `LOADTEST_${runTag}`,
    slug: `loadtest-${runTag}`,
    exam_duration: durationMinutes,
    passing_cutoff: 0,
    proctoring_severity: "LOW",
    max_cheat_warnings: 3,
    mcq_count: 5,
    coding_count: 1,
    shuffle_questions: true,
    shuffle_options: true,
    is_exam_active: true,
    reg_start: new Date(now.getTime() - 86_400_000).toISOString(),
    reg_end: new Date(now.getTime() + 86_400_000).toISOString(),
    exam_start: examStart.toISOString(),
    exam_end: examEnd.toISOString(),
    webcam_proctoring_enabled: false,
  })
  .select()
  .single();
if (driveError) throw driveError;
console.log(`Drive created: ${drive.id} ("${drive.title}")`);

// --- MCQ bank (5) ---
const mcqDefs = [
  { title: "Arithmetic Check 1", content: "What is 12 + 8?", options: ["18", "19", "20", "21"], correctIndex: 2 },
  { title: "Arithmetic Check 2", content: "What is 9 * 3?", options: ["24", "25", "26", "27"], correctIndex: 3 },
  { title: "Arithmetic Check 3", content: "What is 100 / 4?", options: ["20", "25", "30", "35"], correctIndex: 1 },
  { title: "Arithmetic Check 4", content: "What is 7 - 15?", options: ["-8", "-7", "8", "7"], correctIndex: 0 },
  { title: "Arithmetic Check 5", content: "What is 2 to the power of 5?", options: ["16", "32", "64", "10"], correctIndex: 1 },
];

const { data: mcqRows, error: mcqError } = await supabase
  .from("questions")
  .insert(
    mcqDefs.map((q) => ({
      drive_id: drive.id,
      type: "MCQ",
      title: q.title,
      content: q.content,
      options: q.options,
      correct_answer: String(q.correctIndex),
    }))
  )
  .select();
if (mcqError) throw mcqError;
console.log(`Inserted ${mcqRows.length} MCQ questions.`);

// --- Coding question (1), 3 test cases, comma-separated "a,b" -> sum ---
// Solvable in every supported language -- see run.mjs's SOLUTIONS map, one
// genuinely-correct program per language (javascript/python/java/c/cpp),
// verified against these exact test cases.
const testCases = [
  { input: "3,4", expectedOutput: "7", isHidden: false, weight: 1 },
  { input: "10,20", expectedOutput: "30", isHidden: false, weight: 1 },
  { input: "-5,5", expectedOutput: "0", isHidden: true, weight: 1 },
];

const { data: codingRows, error: codingError } = await supabase
  .from("questions")
  .insert([
    {
      drive_id: drive.id,
      type: "CODING",
      title: "Sum of Two Numbers",
      content: "Read two comma-separated integers (e.g. \"3,4\") and print their sum.",
      boilerplate_code: "function sum(a, b) {\n  // Read the input from stdin and print your answer to stdout.\n  return a + b;\n}\n",
      test_cases: testCases,
    },
  ])
  .select();
if (codingError) throw codingError;
console.log(`Inserted ${codingRows.length} coding question (id=${codingRows[0].id}).`);

// --- Candidates ---
const FIXED_PIN = "123456";
const candidateInserts = Array.from({ length: count }, (_, i) => ({
  drive_id: drive.id,
  name: `LoadTest Candidate ${i}`,
  email: `loadtest.${runTag}.${i}@naprocs-loadtest.invalid`,
  phone: "9999999999",
  // Uppercased to match the normalization exam-login applies to the
  // identifier before lookup (`.toUpperCase()` for a non-email identifier) --
  // without this every login 401s with "Invalid credentials" even though the
  // row genuinely exists, just cased differently.
  college_roll_number: `LOADTEST-${runTag}-${i}`.toUpperCase(),
  access_pin: FIXED_PIN,
  stage: "EXAM_PENDING",
}));

// Insert in chunks -- a single 600-row insert works fine on Postgres, but
// chunking keeps any one request small and gives partial progress visibility.
const CHUNK = 200;
const insertedCandidates = [];
for (let i = 0; i < candidateInserts.length; i += CHUNK) {
  const chunk = candidateInserts.slice(i, i + CHUNK);
  const { data, error } = await supabase.from("candidates").insert(chunk).select("id,email,college_roll_number");
  if (error) throw error;
  insertedCandidates.push(...data);
  console.log(`  inserted candidates ${i}-${i + chunk.length - 1}`);
}

const state = {
  runTag,
  driveId: drive.id,
  driveTitle: drive.title,
  codingQuestionId: codingRows[0].id,
  examStart: drive.exam_start,
  examEnd: drive.exam_end,
  durationMinutes,
  accessPin: FIXED_PIN,
  // Correct answer per MCQ, matched by title (option order is never
  // shuffled server-side today -- see admin/questions/page.tsx's
  // shuffleOptions flag, which is stored but not actually applied anywhere
  // -- but matching by title instead of index is a one-line safety net if
  // that ever changes).
  mcqAnswerKey: mcqDefs.map((q) => ({ title: q.title, correctText: q.options[q.correctIndex] })),
  candidates: insertedCandidates.map((c) => ({
    candidateId: c.id,
    identifier: c.college_roll_number,
    accessPin: FIXED_PIN,
  })),
};
saveState(state);

console.log(`\nSeed complete: ${insertedCandidates.length} candidates on drive ${drive.id}.`);
console.log(`State written to scripts_loadtest/loadtest_state.json`);
console.log(`Exam window: ${drive.exam_start} -> ${drive.exam_end}`);
console.log(`\nNext: node run.mjs <BASE_URL>`);
