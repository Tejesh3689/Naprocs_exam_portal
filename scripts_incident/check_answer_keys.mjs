import { createClient } from "@supabase/supabase-js";
import fs from "fs";
const env = fs.readFileSync(new URL("../.env", import.meta.url), "utf8");
const get = (k) => { const m = env.match(new RegExp(`^${k}=(.*)$`, "m")); return m ? m[1].trim().replace(/^["']|["']$/g, "") : null; };
const supabase = createClient(get("SUPABASE_URL"), get("SUPABASE_SERVICE_ROLE_KEY"));

const driveId = process.argv[2];
const { data: questions } = await supabase.from("questions").select("id,type,title,options,correct_answer,test_cases").eq("drive_id", driveId);
const mcqs = questions.filter(q => q.type === "MCQ");
const coding = questions.filter(q => q.type === "CODING");

const badMcq = mcqs.filter(q => q.correct_answer === null || q.correct_answer === "" || !q.options || q.options.length === 0);
console.log(`MCQs: ${mcqs.length} total, ${badMcq.length} missing a correct_answer or options`);
badMcq.forEach(q => console.log("  BAD:", q.id, q.title));

const badCoding = coding.filter(q => !q.test_cases || q.test_cases.length === 0);
console.log(`Coding: ${coding.length} total, ${badCoding.length} missing test_cases`);
badCoding.forEach(q => console.log("  BAD:", q.id, q.title));

console.log("\nSample MCQ:", JSON.stringify(mcqs[0], null, 2).slice(0, 400));
