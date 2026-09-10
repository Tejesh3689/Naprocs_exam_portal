import { createClient } from "@supabase/supabase-js";
import fs from "fs";
const env = fs.readFileSync(new URL("../.env", import.meta.url), "utf8");
const get = (k) => { const m = env.match(new RegExp(`^${k}=(.*)$`, "m")); return m ? m[1].trim().replace(/^["']|["']$/g, "") : null; };
const supabase = createClient(get("SUPABASE_URL"), get("SUPABASE_SERVICE_ROLE_KEY"));

const driveId = process.argv[2];
const { data: candidates } = await supabase.from("candidates").select("id,name,stage,exam_score,last_active_at").eq("drive_id", driveId);
const candidateIds = candidates.map(c => c.id);

const { data: sessions } = await supabase.from("exam_sessions").select("*").in("candidate_id", candidateIds);
console.log("Total candidates:", candidates.length, "| Total exam_sessions rows:", sessions.length);

const statusCounts = sessions.reduce((a,s) => { a[s.status] = (a[s.status]||0)+1; return a; }, {});
console.log("Session status breakdown:", statusCounts);

const withNoSession = candidates.filter(c => !sessions.find(s => s.candidate_id === c.id));
console.log("Candidates with ZERO session rows (never even started):", withNoSession.length);

const withActivity = candidates.filter(c => c.last_active_at);
console.log("Candidates with any last_active_at (attempted login/sync):", withActivity.length);

// Look at a few sessions with responses to see if they actually answered anything
const sessionsWithResponses = sessions.filter(s => s.responses && Object.keys(s.responses).length > 0);
console.log("\nSessions with non-empty responses:", sessionsWithResponses.length);
if (sessionsWithResponses.length > 0) {
  const s = sessionsWithResponses[0];
  console.log("Sample session:", { id: s.id, status: s.status, end_reason: s.end_reason, question_ids: s.question_ids?.length, responses_keys: Object.keys(s.responses).length, start_time: s.start_time, updated_at: s.updated_at });
  console.log("Sample responses:", JSON.stringify(s.responses, null, 2).slice(0, 1500));
}
