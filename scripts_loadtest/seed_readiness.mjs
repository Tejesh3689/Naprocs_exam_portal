// Purpose-built for the pre-exam readiness check: seeds a DISPOSABLE drive
// configured to match the REAL nap_klu_2026 drive's settings exactly (30
// MCQ, 2 Coding, HIGH proctoring severity, max_cheat_warnings 3,
// webcam_proctoring_enabled true) at the REAL candidate count -- so the
// readiness test reflects actual tomorrow-scale load, not the lighter
// settings used in scripts_loadtest/seed.mjs's general-purpose harness.
//
// Usage: node seed_readiness.mjs <candidateCount> [durationMinutes]
import { supabase, saveState } from "./_lib.mjs";

const count = parseInt(process.argv[2] || "388", 10);
const durationMinutes = parseInt(process.argv[3] || "15", 10);
const runTag = Date.now().toString(36);

console.log(`Seeding READINESS drive for ${count} candidates matching nap_klu_2026's real config (runTag=${runTag})...`);

const now = new Date();
const examStart = new Date(now.getTime() - 60_000);
const examEnd = new Date(now.getTime() + (durationMinutes + 10) * 60_000);

const { data: drive, error: driveError } = await supabase
  .from("drives")
  .insert({
    title: `READINESS_${runTag}`,
    slug: `readiness-${runTag}`,
    exam_duration: durationMinutes,
    passing_cutoff: 70,
    proctoring_severity: "HIGH", // matches nap_klu_2026 exactly
    max_cheat_warnings: 3,
    mcq_count: 30, // matches nap_klu_2026 exactly
    coding_count: 2, // matches nap_klu_2026 exactly
    shuffle_questions: true,
    shuffle_options: true,
    is_exam_active: true,
    reg_start: new Date(now.getTime() - 86_400_000).toISOString(),
    reg_end: new Date(now.getTime() + 86_400_000).toISOString(),
    exam_start: examStart.toISOString(),
    exam_end: examEnd.toISOString(),
    webcam_proctoring_enabled: true, // matches nap_klu_2026 exactly
  })
  .select()
  .single();
if (driveError) throw driveError;
console.log(`Drive created: ${drive.id} ("${drive.title}")`);

// --- 30 MCQs (matching the real count) ---
const mcqDefs = Array.from({ length: 30 }, (_, i) => ({
  title: `Arithmetic Check ${i}`,
  content: `What is ${i} + 1?`,
  options: [String(i), String(i + 1), String(i + 2), String(i + 3)],
  correctIndex: 1,
}));

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

// --- 2 coding questions (matching the real count) -- different problems so
// candidates plausibly submit different code per question, closer to real
// usage than reusing one problem twice.
const codingDefs = [
  {
    title: "Sum of Two Numbers",
    content: "Read two comma-separated integers and print their sum.",
    boilerplate_code: "function sum(a, b) {\n  return a + b;\n}\n",
    test_cases: [
      { input: "3,4", expectedOutput: "7", isHidden: false, weight: 1 },
      { input: "10,20", expectedOutput: "30", isHidden: false, weight: 1 },
      { input: "-5,5", expectedOutput: "0", isHidden: true, weight: 1 },
    ],
  },
  {
    title: "Product of Two Numbers",
    content: "Read two comma-separated integers and print their product.",
    boilerplate_code: "function product(a, b) {\n  return a * b;\n}\n",
    test_cases: [
      { input: "3,4", expectedOutput: "12", isHidden: false, weight: 1 },
      { input: "10,20", expectedOutput: "200", isHidden: false, weight: 1 },
      { input: "-5,5", expectedOutput: "-25", isHidden: true, weight: 1 },
    ],
  },
];

const { data: codingRows, error: codingError } = await supabase
  .from("questions")
  .insert(codingDefs.map((c) => ({ drive_id: drive.id, type: "CODING", ...c })))
  .select();
if (codingError) throw codingError;
console.log(`Inserted ${codingRows.length} coding questions (ids: ${codingRows.map((c) => c.id).join(", ")}).`);

// --- Candidates ---
const FIXED_PIN = "123456";
const candidateInserts = Array.from({ length: count }, (_, i) => ({
  drive_id: drive.id,
  name: `Readiness Candidate ${i}`,
  email: `readiness.${runTag}.${i}@naprocs-loadtest.invalid`,
  phone: "9999999999",
  college_roll_number: `READY-${runTag}-${i}`.toUpperCase(),
  access_pin: FIXED_PIN,
  stage: "EXAM_PENDING",
}));

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
  codingQuestionIds: codingRows.map((c) => c.id),
  codingDefs,
  examStart: drive.exam_start,
  examEnd: drive.exam_end,
  durationMinutes,
  accessPin: FIXED_PIN,
  mcqAnswerKey: mcqDefs.map((q) => ({ title: q.title, correctText: q.options[q.correctIndex] })),
  candidates: insertedCandidates.map((c) => ({
    candidateId: c.id,
    identifier: c.college_roll_number,
    accessPin: FIXED_PIN,
  })),
};
saveState(state);

console.log(`\nSeed complete: ${insertedCandidates.length} candidates on drive ${drive.id}.`);
console.log(`Matches nap_klu_2026: 30 MCQ, 2 Coding, HIGH severity, max_cheat_warnings=3, webcam=true.`);
console.log(`Exam window: ${drive.exam_start} -> ${drive.exam_end}`);
