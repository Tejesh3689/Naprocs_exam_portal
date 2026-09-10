# Webcam & Microphone Proctoring — Rule Book

**Status:** Live. Migration applied; verified end-to-end on real hardware across two
laptops (real cameras, real detections, admin review).
**Scope:** Desktop/laptop browsers only. Not built or tested for mobile.

An internal reference for exactly what this system watches for, the exact numeric
thresholds it uses, and why each one is set where it is. Any change to a number below
should be a reviewable diff to this file, not a buried constant.

---

## 1. What this is (and isn't)

- **Is:** periodic webcam snapshots (evidence trail) + client-side face/gaze/noise
  detection that feeds the *same* `cheat_warnings` counter and severity ladder that
  tab-switch/fullscreen-exit already use.
- **Is not:** continuous video recording, precise eye-gaze-point tracking, or audio
  recording/transcription. All three were deliberately rejected — see §4.

Everything runs **client-side only**. The server never runs face detection; it only
stores whatever snapshot and event type the browser already decided to send.

---

## 2. The signals and their thresholds

| Signal | Detected via | Flag threshold | Cooldown | Escalation |
|---|---|---|---|---|
| `SNAPSHOT` | n/a — always fires | every 60s | n/a | Not a violation. Baseline evidence that the candidate was present throughout, independent of any flag. |
| `NO_FACE` | MediaPipe Face Landmarker, face count = 0 | absent ≥5 consecutive seconds | 20s before re-flagging | Full severity chain — can trigger a HIGH-severity drive's instant auto-submit. |
| `MULTIPLE_FACES` | face count ≥2 (`numFaces: 3`, `minFaceDetectionConfidence: 0.4` — see §3a) | present ≥3 consecutive seconds | 20s | Full severity chain. |
| `LOOKING_AWAY` | coarse head-yaw proxy (see §3) | sustained ≥5 consecutive seconds | 20s | **Warn-only.** Always routes through the MEDIUM/LOW branch, **never** the HIGH instant-submit branch — regardless of the drive's configured severity. |
| `HIGH_NOISE` | Web Audio `AnalyserNode` RMS volume (mic requested with `echoCancellation`/`noiseSuppression`/`autoGainControl` explicitly **off** — see note below) | above threshold ≥3 consecutive seconds | 20s | Full severity chain. No audio is ever recorded, buffered, or uploaded — only this derived boolean. |

### 2b. Two independent warning caps, not one shared counter

**FIXED 2026-09-10.** `cheat_warnings` (the number persisted per candidate and shown in the
admin UI) is a *combined total*, but the cap that actually decides auto-submission is split
into two independent counters, each checked against `settings.maxCheatWarnings` (per-drive
config, default `3`):

- **`lookingAwayWarnings`** — only `LOOKING_AWAY` increments this one.
- **`otherWarnings`** — every other MEDIUM/LOW-branch violation (`NO_FACE`, `MULTIPLE_FACES`,
  `HIGH_NOISE`, tab-switch, fullscreen-exit) increments this one.

A drive auto-submits as soon as **either** counter reaches the cap — e.g. with the default
cap of 3, a candidate can accumulate up to 3 looking-away warnings *and* 3 of everything else
(6 total) before termination, but 3 tab-switches alone is already enough, independent of how
many looking-away warnings also happened. This is what keeps `LOOKING_AWAY`'s
false-positive-prone signal (§3) from either being ignored (too lenient) or from silently
eating into a shared budget that then also blocks the candidate for genuine violations of a
completely different kind (too strict/confusing).

Previously both categories fed one shared `cheatWarnings` counter, and the auto-submit check
itself was only ever wired up for `proctoringSeverity === 'MEDIUM'` — `LOW`-severity drives
(a normal, admin-selectable option) never enforced any cap at all, so a candidate's warning
count could climb past the configured max (7, 12, arbitrarily high) with the exam never
auto-submitting. See `useEffect` on `lookingAwayWarnings`/`otherWarnings` in
`src/app/exam/dashboard/page.tsx` for the current (reactive, severity-agnostic-except-HIGH)
check.

All constants live in one place: `src/hooks/useProctoringCapture.ts`, top of file. Changing
a number means editing it there **and** this table in the same change.

Detection runs as three independent loops, all client-side:

- **Fast loop, ~every 1.5s** — face count + looking-away check. Purely in-memory; no
  network call unless a threshold actually trips.
- **Slow loop, every 60s** — always uploads one evidence snapshot, regardless of any flag.
- **Noise loop, every 500ms** — cheap RMS sampling on the mic track.

A tripped threshold uploads exactly one evidence frame with the violation, via
`POST /api/exam/proctoring`.

**Admin side is polling, not push:** both admin surfaces (Proctoring Overview roster,
per-candidate gallery/tab) re-fetch every **30s** while open, instead of requiring a manual
page refresh — same `setInterval` idiom the Live Control Center already used for candidate
status. Not real-time (WebSocket/SSE) — a 30s-old view is an accepted tradeoff for staying
consistent with the rest of the admin UI's polling pattern rather than introducing a new
transport just for this feature.

**Debugging detection in the field:** `useProctoringCapture.ts` logs to the browser console
(`console.debug`) whenever the detected face count or the looking-away boolean changes —
not every tick, to avoid flooding the console over a full exam. Open devtools during a live
test to see exactly what the model is seeing in real time; this was a total black box before
and made "X isn't detecting" reports impossible to root-cause remotely.

---

## 3. Why `LOOKING_AWAY` is a coarse proxy, and why it can't hard-terminate

Precise webcam gaze-point tracking is unreliable enough that a commercial proctoring
vendor (AutoProctor) publicly explains why they dropped eyeball tracking over false-positive
complaints. Published error rates for webcam-based gaze estimation run 2–6° of visual angle
even under good conditions, and degrade further with typical laptop webcam resolution,
uneven lighting, or head movement.

Given that, this system does **not** try to compute where on the screen someone is looking.
Instead it computes one number: the horizontal offset of the nose-tip landmark (MediaPipe
landmark index `1`) from the midpoint of the two face-edge landmarks (indices `234` and
`454`), normalized by face width. If that ratio exceeds `0.18` for 5+ consecutive seconds,
the candidate is classified as looking away. This is a **head-yaw** proxy, not eye tracking —
someone can move their head without their eyes ever leaving the screen and still trip it,
and vice versa.

Because this signal is coarser and more failure-prone than face-presence detection, it is
hard-wired in `handleProctoringViolation` (`src/app/exam/dashboard/page.tsx`) to only ever
increment the warning counter — never the instant-submit path — no matter what the drive's
`proctoring_severity` is set to. A candidate should never lose their entire exam to one
misfired head-turn heuristic.

Sources: [Why we don't Use Eyeball Tracking in our AI Proctoring](https://blog.autoproctor.co/why-we-dont-use-eyeball-tracking-in-our-ai-proctoring/), [Webcam-based gaze estimation for computer screen interaction](https://www.frontiersin.org/journals/robotics-and-ai/articles/10.3389/frobt.2024.1369566/full)

---

## 2a. Why the microphone is requested with AGC/noise-suppression/echo-cancellation off

Verified via isolated testing (a real loud, constant tone fed through Chromium's
fake-audio-capture): with the browser's *default* `getUserMedia({audio: true})`
constraints, Chrome's automatic gain control actively normalizes perceived
volume, causing the measured RMS of a genuinely loud, constant signal to
fluctuate between roughly `0.12` and `0.34` instead of holding steady near its
true value (`~0.65`) — sometimes dropping below the `0.15` threshold entirely
and resetting the sustained-duration counter. Real ambient noise (someone
talking nearby) would be hit by exactly the same effect, undermining
`HIGH_NOISE` detection in ways that would look like "it just doesn't detect"
with no obvious cause.

Fix: `src/app/exam/page.tsx`'s `getUserMedia` call explicitly requests
`{ echoCancellation: false, noiseSuppression: false, autoGainControl: false }`
on the audio track. Same isolated test with these constraints produced a
stable `~0.65` RMS and a correct, on-time detection. The dashboard's
continuous monitoring hook reuses this same granted stream, so no separate
change was needed there.

---

## 3a. Multi-face detection is best-effort, not a guaranteed catch

Real-world testing found `MULTIPLE_FACES` firing less reliably than expected. This is not
a logic bug — `faces.length >= 2` in `useProctoringCapture.ts` is structurally correct — it's
a detection-sensitivity limitation: MediaPipe's `numFaces` option caps how many faces *can*
be returned, but every returned face still individually has to clear
`minFaceDetectionConfidence` (library default `0.5`). Two real faces sharing one laptop
webcam's narrow field of view are typically smaller, off-angle, or partially cropped compared
to a single centered face, which lowers each one's confidence score — the second face can
simply fail to clear the bar.

Tuned in response: `numFaces` raised to `3` (margin for a bystander), and
`minFaceDetectionConfidence` lowered to `0.4` — for the continuous dashboard hook only, not
the one-time login-page face check, where the stricter default is fine since it only needs one
clear face. This is a genuine improvement, not a guaranteed fix: exact reliability still
depends on camera quality, framing, and lighting that this codebase has no control over. The
new change-triggered debug logging (below) is what actually lets this be verified/recalibrated
against real footage instead of guessed at.

---

## 4. Explicitly rejected approaches

| Rejected | Why |
|---|---|
| Continuous full video recording | ~600 concurrent candidates × 90 min would run into hundreds of GB per drive, versus ~5GB/drive for snapshots. Not needed for spot-review. |
| Precise eye-gaze-point tracking | False-positive rate, per §3. |
| Recording/transcribing microphone audio | Raises the DPDP Act sensitive-data bar significantly for no real benefit over a derived loud/quiet signal. |
| Server-side face detection | Would mean streaming video frames to the server continuously; client-side WASM inference (MediaPipe Tasks Vision) keeps this entirely local until a threshold actually trips. |

---

## 5. Consent and retention (India DPDP Act, 2023)

Facial/biometric data is sensitive personal data under India's DPDP Act. Consent for it:

- Must be **specific and standalone** — never bundled with the existing anti-cheat
  acknowledgment. The Device Check screen (`src/app/exam/page.tsx`) shows a separate,
  unchecked-by-default checkbox for this.
- Must state purpose and retention. Current copy: snapshots are "retained for review and
  deleted afterward."
- **Enforcement of that retention today is manual**, not automatic:
  - An admin can purge one candidate's snapshots at any time (`DELETE
    /api/admin/candidates/[id]/proctoring`, exposed as a "Purge Snapshots" button in both
    the per-candidate Proctoring tab and the Proctoring Overview gallery).
  - Deleting a drive cascades and removes all of that drive's proctoring snapshots and
    events (`src/app/api/admin/drives/[id]/route.ts`).
  - **Not yet built:** a scheduled automatic purge after N days. This needs Supabase-side
    cron/Edge Function scheduling — an infra decision outside this codebase change. Until
    that exists, retention is only as good as an admin remembering to purge.

---

## 6. Where this lives in the codebase

| Piece | File |
|---|---|
| Schema (new table, column, bucket) | `supabase/migrations/006_proctoring.sql` — applied |
| Detection engine + rule thresholds | `src/hooks/useProctoringCapture.ts` |
| Candidate device-check + consent | `src/app/exam/page.tsx` |
| Violation escalation wiring | `src/app/exam/dashboard/page.tsx` (`handleProctoringViolation`) |
| Evidence ingestion | `src/app/api/exam/proctoring/route.ts` |
| Per-candidate gallery + purge | `src/app/api/admin/candidates/[id]/proctoring/route.ts` |
| Drive-wide roster counts | `src/app/api/admin/drives/[id]/proctoring-summary/route.ts` |
| Admin: per-candidate Proctoring tab | `src/app/admin/drive/page.tsx` |
| Admin: drive-wide Proctoring Overview | `src/app/admin/proctoring/page.tsx` |
| Full-screen snapshot viewer (shared) | `src/components/proctoring/ProctoringLightbox.tsx` |
| Flag type/icon/label metadata (shared) | `src/lib/proctoringFlags.ts` |
| Per-drive on/off toggle | `src/app/admin/drives/page.tsx`, `src/app/admin/settings/page.tsx` |

---

## 7. Known gaps / follow-ups

- No automated retention purge (§5) — manual purge only.
- `LOOKING_AWAY`'s `0.18` offset ratio and every threshold/cooldown number above are
  starting points, not values calibrated against real candidate footage. Expect to tune
  them as more live drives use this feature, using the admin gallery plus the new
  change-triggered debug console logging to sanity-check false-positive rate.
- Admin views are 30s-polled, not push/real-time (§2) — acceptable for spot-review, not
  suitable if a future requirement needs sub-second live monitoring.
- This does not fix the pre-existing, unrelated gap where tab-switch/fullscreen violation
  *reasons* are never persisted to the database (only the numeric count) — out of scope for
  this feature.
- Desktop/laptop only. No mobile browser testing or UI accommodation was done.
