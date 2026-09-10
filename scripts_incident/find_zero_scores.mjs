import { createClient } from "@supabase/supabase-js";
import fs from "fs";
const env = fs.readFileSync(new URL("../.env", import.meta.url), "utf8");
const get = (k) => { const m = env.match(new RegExp(`^${k}=(.*)$`, "m")); return m ? m[1].trim().replace(/^["']|["']$/g, "") : null; };
const supabase = createClient(get("SUPABASE_URL"), get("SUPABASE_SERVICE_ROLE_KEY"));

// Find drives with activity today
const today = new Date(); today.setHours(0,0,0,0);
const { data: drives } = await supabase.from("drives").select("id,title,exam_start,exam_end,passing_cutoff,created_at").order("created_at", { ascending: false }).limit(15);
console.log("Recent drives:");
drives.forEach(d => console.log(" ", d.title, "| exam:", d.exam_start, "->", d.exam_end, "| cutoff:", d.passing_cutoff, "| id:", d.id));
