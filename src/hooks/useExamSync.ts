import { useState, useEffect, useRef, useCallback } from 'react';

export function useExamSync(candidateId: string, sessionId: string) {
  const [questions, setQuestions] = useState<any[]>([]);
  const [settings, setSettings] = useState<any>(null);
  const [responses, setResponses] = useState<Record<string, any>>({});
  const [internalSessionId, setInternalSessionId] = useState<string | null>(null);
  const [examStage, setExamStage] = useState<'MCQ' | 'CODING'>('MCQ');
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null);
  // Server-authoritative deadline for this candidate's session (start_time +
  // drive duration, capped by the drive's exam_end) -- computed once,
  // server-side, and never recomputed on the client. See src/lib/examTiming.ts.
  const [deadline, setDeadline] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  // Any hydration failure that ISN'T the "session expired" case -- an empty
  // question bank (503 EMPTY_QUESTION_BANK / UNRESOLVABLE_SESSION_QUESTIONS),
  // a 500, a 404, a network error. Previously there was no `else` branch here
  // at all: any of these left `questions` at `[]` forever with zero visible
  // error, indistinguishable from "still loading" -- see the 2026-09-09 SVCE
  // incident (dashboard just shows "Initializing Secure Sandbox
  // Environment..." either way). Surfacing this lets the dashboard render a
  // distinct, actionable error state instead.
  const [loadError, setLoadError] = useState<string | null>(null);

  const responsesRef = useRef(responses);

  // Sync internal refs securely tracking active component re-renders
  useEffect(() => {
    responsesRef.current = responses;
  }, [responses]);

  // Initial Data Hydration
  useEffect(() => {
    if (!candidateId) return;
    // Cancellation guard: without this, an in-flight fetch that resolves
    // AFTER a newer invocation (React Strict Mode double-invokes this effect
    // in dev, but the same race is possible in production on a slow network)
    // can blindly overwrite `responses` with stale `existingResponses` from
    // before the user answered anything, silently wiping out real answers.
    let cancelled = false;
    const initializeBank = async () => {
      try {
        const res = await fetch(`/api/exam/questions?candidateId=${candidateId}`);
        const data = await res.json();
        if (cancelled) return;
        if (data.success) {
           setQuestions(data.questions);
           if (data.settings) setSettings(data.settings);
           if (data.sessionId) setInternalSessionId(data.sessionId);
           if (data.currentStage) setExamStage(data.currentStage);
           if (data.existingResponses) setResponses(data.existingResponses);
           if (data.deadline) setDeadline(data.deadline);
        } else if (data.expired) {
           // Lazy-sweep on the server found this session already past its
           // deadline (abandoned/expired) -- surface it so the dashboard can
           // show a clear "session expired" state instead of a blank/broken UI.
           setSessionExpired(true);
        } else {
           // Any other failure shape (empty question bank, a 500, a 404 --
           // see route.ts's EMPTY_QUESTION_BANK / UNRESOLVABLE_SESSION_QUESTIONS
           // codes, or any thrown exception's generic 500). Include whatever
           // reference the server gave (session ID, drive title) so a
           // candidate has something concrete to hand support.
           const ref = data.sessionId ? ` (session ${data.sessionId})` : data.driveTitle ? ` (${data.driveTitle})` : "";
           setLoadError((data.error || "Failed to load your exam. Please contact your administrator.") + ref);
        }
      } catch (e) {
        if (!cancelled) {
          console.error("Hydration Error:", e);
          setLoadError("A network error prevented your exam from loading. Please check your connection and contact your administrator if this persists.");
        }
      }
    };
    initializeBank();
    return () => { cancelled = true; };
  }, [candidateId]);

  const pingSync = useCallback(async () => {
    const activeSession = internalSessionId || sessionId;
    if (!candidateId || !activeSession || Object.keys(responsesRef.current).length === 0) return;
    
    setIsSyncing(true);
    try {
      const res = await fetch('/api/exam/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: activeSession,
          candidateId,
          incomingResponses: responsesRef.current
        })
      });
      if (res.ok) {
        const data = await res.json().catch(() => null);
        if (data?.expired) {
          setSessionExpired(true);
        } else {
          setLastSyncTime(new Date());
        }
      }
    } catch (error) {
       console.error("Silent Sync Failure:", error);
    } finally {
       setIsSyncing(false);
    }
  }, [candidateId, sessionId, internalSessionId]);

  // Generic interval ping every 60 seconds
  useEffect(() => {
    const timer = setInterval(() => {
      pingSync();
    }, 60000);

    return () => clearInterval(timer);
  }, [pingSync]);

  const updateResponse = (questionId: string, payload: any) => {
    setResponses((prev: any) => ({ ...prev, [questionId]: { ...prev[questionId], ...payload } }));
  };

  const manualSync = () => {
    pingSync();
  };

  return { 
    questions, 
    settings, 
    responses, 
    examStage,
    setExamStage,
    updateResponse, 
    manualSync, 
    isSyncing,
    lastSyncTime,
    recoveredSessionId: internalSessionId,
    deadline,
    sessionExpired,
    loadError
  };
}
