import { createClient } from "@supabase/supabase-js";
import fs from "fs";
const env = fs.readFileSync(new URL("../.env", import.meta.url), "utf8");
const get = (k) => { const m = env.match(new RegExp(`^${k}=(.*)$`, "m")); return m ? m[1].trim().replace(/^["']|["']$/g, "") : null; };
const supabase = createClient(get("SUPABASE_URL"), get("SUPABASE_SERVICE_ROLE_KEY"));

// Questions created recently (today), grouped by drive_id
const { data: recentQ } = await supabase.from("questions").select("id,drive_id,type,created_at").order("created_at", { ascending: false }).limit(30);
console.log("Most recently created questions (any drive):");
recentQ.forEach(q => console.log(" ", q.created_at, "| drive_id:", q.drive_id, "| type:", q.type));

// Cross check: which drives do these recent question drive_ids belong to?
const uniqueDriveIds = [...new Set(recentQ.map(q => q.drive_id))];
const { data: drivesForQ } = await supabase.from("drives").select("id,title").in("id", uniqueDriveIds);
console.log("\nThose drive_ids resolve to:");
drivesForQ.forEach(d => console.log(" ", d.id, "->", d.title));
