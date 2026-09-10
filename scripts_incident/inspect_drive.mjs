import { createClient } from "@supabase/supabase-js";
import fs from "fs";
const env = fs.readFileSync(new URL("../.env", import.meta.url), "utf8");
const get = (k) => { const m = env.match(new RegExp(`^${k}=(.*)$`, "m")); return m ? m[1].trim().replace(/^["']|["']$/g, "") : null; };
const supabase = createClient(get("SUPABASE_URL"), get("SUPABASE_SERVICE_ROLE_KEY"));

const driveId = process.argv[2];
const { data: drive } = await supabase.from("drives").select("*").eq("id", driveId).maybeSingle();
console.log("DRIVE:", drive.title, "| mcq_count:", drive.mcq_count, "coding_count:", drive.coding_count, "cutoff:", drive.passing_cutoff);

const { data: questions } = await supabase.from("questions").select("id,type,title,correct_answer").eq("drive_id", driveId);
console.log("Questions in bank:", questions.length, "-> types:", questions.reduce((a,q)=>{a[q.type]=(a[q.type]||0)+1;return a;},{}));
console.log("Sample question correct_answer values:", questions.slice(0,5).map(q => ({ id: q.id, type: q.type, correct_answer: q.correct_answer })));

const { data: candidates } = await supabase.from("candidates").select("id,name,email,college_roll_number,stage,exam_score,cheat_warnings").eq("drive_id", driveId);
console.log("\nCandidates:", candidates.length);
candidates.forEach(c => console.log(" ", c.name, "|", c.stage, "| score:", c.exam_score, "| warnings:", c.cheat_warnings));
