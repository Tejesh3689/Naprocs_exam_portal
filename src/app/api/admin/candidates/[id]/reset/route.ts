import { NextResponse } from 'next/server';
import supabase from '@/lib/supabase';
import { purgeProctoringForCandidate } from '@/lib/proctoringPurge';
import { requireAdmin } from '@/lib/adminAuth';

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const unauthorized = await requireAdmin();
    if (unauthorized) return unauthorized;

    const params = await context.params;
    const { id } = params;

    // Optional audit context from the "Re-attempt" dialog (see
    // admin/control-center/page.tsx). Parsed defensively -- the original
    // caller of this endpoint sent no body at all, and that older call
    // pattern must keep working.
    let reason: string | undefined;
    let resetBy: string | undefined;
    try {
      const body = await req.json();
      reason = body?.reason;
      resetBy = body?.resetBy;
    } catch {
      // no JSON body sent -- fine, audit fields just stay null
    }

    // 1. Clear Candidate Status and Session Locks, and record who/when/why
    // this reset happened (best-effort audit -- see supabase/migrations/
    // 009_candidate_reset_audit.sql for why last_reset_by is free text).
    const { data: candidate, error: candidateError } = await supabase
      .from('candidates')
      .update({
        stage: 'EXAM_PENDING',
        exam_score: 0,
        cheat_warnings: 0,
        current_session_id: null,
        last_active_at: null,
        score_logic: 0,
        score_architecture: 0,
        score_linguistic: 0,
        score_mission: 0,
        last_reset_at: new Date().toISOString(),
        last_reset_reason: reason ?? null,
        last_reset_by: resetBy ?? null,
        // Clear the stage-provenance flag too -- a fresh attempt hasn't been
        // decided yet by anyone, auto or manual. finalizeSession sets it
        // back to AUTO_CUTOFF the next time this candidate completes.
        stage_source: null,
        stage_recalculated_at: null,
      })
      .eq('id', id)
      .select()
      .maybeSingle();

    if (candidateError) throw candidateError;

    if (!candidate) {
      return NextResponse.json({ success: false, error: 'Candidate not found' }, { status: 404 });
    }

    // 2. Purge this attempt's webcam/mic proctoring evidence -- a fresh
    // attempt shouldn't carry over the previous attempt's flags/snapshots
    // (e.g. a re-attempt granted specifically because of an accidental
    // webcam dropout shouldn't leave that dropout's NO_FACE flags sitting
    // on the candidate's record looking like an unresolved violation).
    await purgeProctoringForCandidate(id);

    // 3. Wipe all existing exam sessions for this candidate to ensure a fresh start
    const { error: sessionError } = await supabase.from('exam_sessions').delete().eq('candidate_id', id);
    if (sessionError) throw sessionError;

    console.log(`[Admin] Reset performed for candidate: ${candidate.email} (${id})${reason ? ` -- reason: ${reason}` : ''}`);

    return NextResponse.json({
      success: true,
      message: 'Candidate attempt reset successfully and sessions purged.'
    });
  } catch (error) {
    console.error("Reset API Exception:", error);
    return NextResponse.json({ success: false, error: 'Reset operation failed' }, { status: 500 });
  }
}
