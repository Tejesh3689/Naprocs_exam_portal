"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useExamStore } from "@/store/examStore";
import { useExamSync } from "@/hooks/useExamSync";
import { useProctoringCapture, ProctoringViolationType } from "@/hooks/useProctoringCapture";
import { motion, AnimatePresence } from "framer-motion";
import Editor from "@monaco-editor/react";
import { 
  AlertTriangle, ChevronLeft, ChevronRight, Clock, 
  LayoutDashboard, CheckCircle2, Circle, Menu, Code, ShieldAlert
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

// Multi-language coding round. JavaScript keeps using the question's own
// boilerplateCode + the existing in-process vm grading, unchanged. The other
// four run as a full program via a self-hosted Piston instance: the code
// reads `input` from stdin and must print its answer to stdout -- the
// standard convention across languages, since a "call this function" contract
// doesn't translate cleanly across JS/Python/Java/C/C++ signatures.
const LANGUAGE_LABELS: Record<string, string> = {
  javascript: "JavaScript (Node.js)",
  python: "Python 3",
  java: "Java",
  c: "C",
  cpp: "C++",
};

const MONACO_LANGUAGE_MAP: Record<string, string> = {
  javascript: "javascript",
  python: "python",
  java: "java",
  c: "c",
  cpp: "cpp",
};

// Mirrors the EndReason union in src/lib/examTiming.ts (minus
// ABANDONED_TIMEOUT, which only the server-side lazy sweep ever assigns).
// Threaded through handleViolationSubmit/handleSubmit into the submit POST
// body so the server can finally record *why* a session ended, not just
// that it did -- previously only a client-side console.warn.
type SubmitReasonCode = 'MANUAL' | 'TIME_EXPIRED' | 'VIOLATION_HIGH_SEVERITY' | 'VIOLATION_MEDIUM_CAP';

const LANGUAGE_STARTERS: Record<string, string> = {
  python: "# Read the input from stdin and print your answer to stdout.\nline = input()\n",
  java: "import java.util.Scanner;\n\npublic class Main {\n    public static void main(String[] args) {\n        Scanner sc = new Scanner(System.in);\n        // Read the input from stdin and print your answer via System.out.println.\n    }\n}\n",
  c: "#include <stdio.h>\n\nint main(void) {\n    // Read the input from stdin and print your answer via printf.\n    return 0;\n}\n",
  cpp: "#include <iostream>\nusing namespace std;\n\nint main() {\n    // Read the input from stdin and print your answer via cout.\n    return 0;\n}\n",
};

export default function ExamDashboard() {
  const router = useRouter();
  
  const {
    isAuthenticated, candidate, lookingAwayWarnings, otherWarnings,
    incrementLookingAwayWarning, incrementOtherWarning, logout, mediaStream
  } = useExamStore();
  
  // Real auth tracking - no more "anonymous" fallbacks
  const sessionId = candidate ? `session-${candidate.id}` : ""; 
  const candidateId = candidate?.id || "";

  // New Auto-Sync Hook Integration
  const {
    questions,
    settings,
    responses,
    examStage,
    setExamStage,
    updateResponse,
    manualSync,
    isSyncing,
    recoveredSessionId,
    deadline,
    sessionExpired,
    loadError
  } = useExamSync(candidateId, sessionId);

  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [timeLeft, setTimeLeft] = useState(3600);
  // Wall-clock timestamp (ms) this candidate's session must end by --
  // server-authoritative, computed once on the server and never recomputed
  // client-side. Replaces the old client-derived "timerInitialized" model,
  // which reseeded from scratch on every page load (see PROCTORING_RULEBOOK
  // history / examTiming.ts for why).
  const [deadlineTs, setDeadlineTs] = useState<number | null>(null);
  const [showWarningModal, setShowWarningModal] = useState(false);
  const [showStageTransitionModal, setShowStageTransitionModal] = useState(false);
  const [showFinalSubmitModal, setShowFinalSubmitModal] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [isTerminated, setIsTerminated] = useState(false);
  const [testResults, setTestResults] = useState<any[] | null>(null);
  const [runningTests, setRunningTests] = useState(false);
  const [finalCandidateData, setFinalCandidateData] = useState<{name: string, roll: string} | null>(null);
  const [violationMessage, setViolationMessage] = useState(
    "System detected you switched tabs or left the secure environment. This incident has been logged."
  );

  // Derive stage-specific questions
  const stageQuestions = (questions || []).filter(q => q.type === examStage);

  // Persist a proctoring violation immediately, not just on the next periodic
  // sync tick -- cheat warnings previously lived only in client-side Zustand
  // state (never written to candidates.cheat_warnings), so a refresh reset the
  // count to 0 and an admin reviewing a candidate afterward had no visibility
  // into how many violations actually occurred. Reuses the already
  // load-tested /api/exam/sync route rather than adding a new endpoint.
  const persistCheatWarning = async (count: number) => {
    const activeSession = recoveredSessionId || sessionId;
    if (!candidateId || !activeSession) return;
    try {
      await fetch('/api/exam/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: activeSession,
          candidateId,
          incomingResponses: responses,
          cheatWarnings: count,
        }),
      });
    } catch (e) {
      console.error("Failed to persist cheat warning:", e);
    }
  };

  const unansweredCount = stageQuestions.filter(q => {
     const res = responses[q._id];
     if (!res) return true;
     if (q.type === 'MCQ') return !res.selectedOption;
     if (q.type === 'CODING') return !res.codeStr || res.codeStr.trim() === '';
     return false;
  }).length;

  // Reset index if stage changes or if index is out of bounds for the current stage
  useEffect(() => {
    setCurrentQuestionIndex(0);
  }, [examStage]);

  // Seed the wall-clock deadline from the server-authoritative value (see
  // src/lib/examTiming.ts). This is what makes the countdown survive a
  // refresh correctly: it's the candidate's own session.deadline, computed
  // once at session creation, not re-derived from "now" on every mount.
  useEffect(() => {
    if (deadline) {
      setDeadlineTs(new Date(deadline).getTime());
    }
  }, [deadline]);

  // Redirect out if the server's lazy sweep found this session already
  // expired (abandoned past its deadline) before we ever got a deadline to
  // seed a live countdown from.
  useEffect(() => {
    if (sessionExpired && !isSubmitted) {
      alert("Your exam session has expired. Please contact your administrator.");
      logout();
      router.replace('/exam');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionExpired]);

  // Auth Context Check - STRICT ENFORCEMENT
  useEffect(() => {
    if (!isAuthenticated && !isSubmitted) router.replace('/exam');
  }, [isAuthenticated, isSubmitted, router]);

  // Anti-Cheat: Visibility API & Context blocks
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden && !isSubmitted && !isTerminated) {
        setViolationMessage("System detected you switched tabs or left the secure environment. This incident has been logged.");
        if (settings?.proctoringSeverity === 'HIGH') {
           setIsTerminated(true);
           persistCheatWarning(1);
           handleViolationSubmit("Tab Switch (Strict Violation)", 'VIOLATION_HIGH_SEVERITY');
        } else {
           incrementOtherWarning();
           persistCheatWarning(useExamStore.getState().cheatWarnings);
           setShowWarningModal(true);
        }
      }
    };

    const handleFullscreenChange = () => {
       if (!document.fullscreenElement && !isSubmitted && !isTerminated) {
          setViolationMessage("System detected you exited fullscreen mode. This incident has been logged.");
          if (settings?.proctoringSeverity === 'HIGH') {
             setIsTerminated(true);
             persistCheatWarning(1);
             handleViolationSubmit("Fullscreen Exit (Strict Violation)", 'VIOLATION_HIGH_SEVERITY');
          } else {
             incrementOtherWarning();
             persistCheatWarning(useExamStore.getState().cheatWarnings);
             setShowWarningModal(true);
          }
       }
    };
    const blockEvent = (e: Event) => e.preventDefault();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    document.addEventListener("contextmenu", blockEvent);
    document.addEventListener("copy", blockEvent);
    document.addEventListener("paste", blockEvent);
    
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      document.removeEventListener("contextmenu", blockEvent);
      document.removeEventListener("copy", blockEvent);
      document.removeEventListener("paste", blockEvent);
    };
  }, [incrementOtherWarning, settings, isSubmitted, isTerminated]);

  // Webcam/Mic Proctoring: routes through the exact same warning/escalation
  // chain as tab-switch/fullscreen above (increment{LookingAway,Other}Warning
  // -> persistCheatWarning -> warn-modal or handleViolationSubmit), per
  // PROCTORING_RULEBOOK.md. LOOKING_AWAY is hard-wired to never hit the
  // HIGH-severity instant-submit branch, regardless of drive severity --
  // webcam gaze detection has well-documented false-positive rates even in
  // commercial proctoring products, so it only ever counts toward the
  // warning tally, never auto-terminates a candidate on its own.
  const handleProctoringViolation = useCallback((type: ProctoringViolationType) => {
    if (isSubmitted || isTerminated) return;
    const REASONS: Record<ProctoringViolationType, string> = {
      NO_FACE: "No face was visible in your webcam feed.",
      MULTIPLE_FACES: "More than one face was detected in your webcam feed.",
      LOOKING_AWAY: "You appeared to look away from the screen for a sustained period.",
      HIGH_NOISE: "Elevated ambient noise was detected on your microphone.",
    };
    const SUBMIT_REASONS: Record<ProctoringViolationType, string> = {
      NO_FACE: "No Face Detected (Strict Violation)",
      MULTIPLE_FACES: "Multiple Faces Detected (Strict Violation)",
      LOOKING_AWAY: "Looking Away From Screen",
      HIGH_NOISE: "Elevated Ambient Noise (Strict Violation)",
    };
    setViolationMessage(`${REASONS[type]} This incident has been logged.`);
    const canHardTerminate = type !== "LOOKING_AWAY";
    if (canHardTerminate && settings?.proctoringSeverity === 'HIGH') {
      setIsTerminated(true);
      persistCheatWarning(1);
      handleViolationSubmit(SUBMIT_REASONS[type], 'VIOLATION_HIGH_SEVERITY');
    } else {
      if (type === "LOOKING_AWAY") {
        incrementLookingAwayWarning();
      } else {
        incrementOtherWarning();
      }
      persistCheatWarning(useExamStore.getState().cheatWarnings);
      setShowWarningModal(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSubmitted, isTerminated, settings]);

  useProctoringCapture({
    stream: mediaStream,
    candidateId,
    sessionId: recoveredSessionId || sessionId,
    enabled: !!settings?.webcamProctoringEnabled && !isSubmitted && !isTerminated,
    onViolation: handleProctoringViolation,
  });

  // Auto-submit once EITHER category's cap is reached: LOOKING_AWAY warnings
  // and every other violation type (tab-switch, fullscreen-exit, NO_FACE,
  // MULTIPLE_FACES, HIGH_NOISE) are capped independently, per
  // PROCTORING_RULEBOOK.md's "warn-only" carve-out for LOOKING_AWAY -- a
  // candidate should never lose their exam to one misfired head-turn
  // heuristic, but also shouldn't be able to rack up 7, 12+ warnings and keep
  // going just because no single legacy shared counter ever tripped.
  //
  // Runs reactively (not only inside the warning modal's "Acknowledge &
  // Resume" click handler) so the cap can't be dodged by leaving the modal
  // open indefinitely, and applies to both MEDIUM and LOW severity drives --
  // previously this check was hard-gated to `proctoringSeverity === 'MEDIUM'`
  // only, so LOW-severity drives never enforced any cap at all regardless of
  // how high the warning count climbed. HIGH-severity drives never reach
  // here for non-LOOKING_AWAY violations (they hard-terminate on the first
  // hit above), so this effect is a no-op for them except via LOOKING_AWAY,
  // which is intentional.
  useEffect(() => {
    if (isSubmitted || isTerminated || !settings) return;
    const cap = settings.maxCheatWarnings ?? 3;
    if (lookingAwayWarnings >= cap || otherWarnings >= cap) {
      setShowWarningModal(false);
      handleViolationSubmit("Max Warnings Exceeded", 'VIOLATION_MEDIUM_CAP');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookingAwayWarnings, otherWarnings, settings, isSubmitted, isTerminated]);

  // Visible self-view feed: purely cosmetic, reuses the same granted stream
  // the detection hook above already consumes -- no second camera request.
  // Candidates see themselves on camera so they know they're being watched,
  // without the UI revealing anything about detection cadence or logic.
  //
  // A callback ref, not a plain ref + useEffect(..., [mediaStream]): the
  // <video> element only mounts once `settings` finishes loading and
  // webcamProctoringEnabled flips true, which happens *after* mediaStream is
  // already stable (it was granted back on the Device Check screen). A
  // useEffect keyed on mediaStream never re-fires once the element shows up
  // later, since the dependency itself never changes again -- the stream was
  // real, it just never got attached. A callback ref fires exactly when the
  // node mounts, sidestepping the ordering problem entirely.
  const bindSelfView = useCallback(
    (el: HTMLVideoElement | null) => {
      if (el) el.srcObject = mediaStream;
    },
    [mediaStream]
  );

  // Timer Implementation with Auto-Submit Watchdog. `setInterval` here is
  // only the re-render trigger, never the source of truth for remaining
  // time: each tick recomputes timeLeft from Date.now() against the
  // server-issued deadlineTs, so a throttled/backgrounded tab (Chrome can
  // drop a hidden tab's interval to ~1 execution/minute) still snaps to the
  // true remaining time the instant it fires, instead of a drifted count.
  useEffect(() => {
    if (deadlineTs === null) return;
    const tick = () => setTimeLeft(Math.max(0, Math.floor((deadlineTs - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [deadlineTs]);

  useEffect(() => {
    // When time hits 0 and the deadline has actually been seeded, trigger auto-submit
    if (deadlineTs !== null && timeLeft === 0 && !isSubmitted && !isSubmitting) {
       console.warn("DUE DATE REACHED: Initiating Auto-Submission sequence...");
       handleViolationSubmit("Time Expired", 'TIME_EXPIRED');
    }
  }, [timeLeft, deadlineTs, isSubmitted, isSubmitting]);

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60).toString().padStart(2, "0");
    const s = (seconds % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  };

  // Intentional minimum-time-on-task gate: the final-submit button in the
  // CODING stage stays disabled until at least half the exam's total
  // duration has elapsed. examDuration is in minutes, timeLeft is in
  // seconds, so this is examDuration*60/2 = examDuration*30.
  const CODING_MIN_TIME_SECONDS = (settings?.examDuration || 0) * 30;

  /** 
   * HackerRank-Style Secure Evaluation Generator
   * Wraps student code in an isolated functional test runner
   */
  const generateWrappedCode = (studentCode: string, testCases: any[]) => {
    const funcMatch = studentCode.match(/function\s+([a-zA-Z0-9_$]+)/);
    const entryPoint = funcMatch ? funcMatch[1] : null;

    return `
      (function(global) {
        try {
          ${studentCode}
          
          global.RESULTS = [];
          const cases = ${JSON.stringify(testCases)};
          const entry = "${entryPoint}";

          for (let i = 0; i < cases.length; i++) {
             const tc = cases[i];
             const res = { index: i, actual: null, error: null, runtime: 0, status: 3 }; 
             const start = Date.now();
             try {
                if (!entry || typeof eval(entry) !== 'function') {
                   throw new Error("Function signature has been modified. Please reset to default.");
                }
                
                // Smart Input Dispatch
                let args = [];
                const rawInput = (tc.input || "").trim();
                if (rawInput.startsWith('[') || rawInput.startsWith('{')) {
                  args = [JSON.parse(rawInput)];
                } else {
                  args = rawInput.split(',').map(v => {
                     const s = v.trim();
                     if (!isNaN(s) && s !== "" && !s.startsWith("0b") && !s.startsWith("0x")) return Number(s);
                     if (s === 'true') return true;
                     if (s === 'false') return false;
                     return s;
                  });
                }

                let actual = eval(entry)(...args);
                if (actual === undefined) throw new Error("Logic returned undefined. Use return, not console.log.");

                // Comparison Normalization
                if (typeof actual === 'number' && !Number.isInteger(actual)) {
                   actual = parseFloat(actual.toFixed(5));
                }
                if (Array.isArray(actual) || (actual !== null && typeof actual === 'object')) {
                   actual = JSON.stringify(actual);
                }

                res.actual = String(actual).trim();
             } catch(e) {
                res.error = e.message;
                res.status = 11; // Runtime Internal Error
             }
             res.runtime = Date.now() - start;
             global.RESULTS.push(res);
          }
        } catch(e) {
           throw new Error("COMPILATION_ERROR: " + e.message);
        }
      })(this);
    `;
  };

  const handleViolationSubmit = async (reason: string, reasonCode: SubmitReasonCode = 'MANUAL') => {
     console.warn(`AUTO-SUBMIT: ${reason}`);
     await handleSubmit(true, undefined, reasonCode);
  };

  const runLocalTests = async () => {
    if (!currentQ || currentQ.type !== 'CODING' || runningTests) return;
    setRunningTests(true);
    setTestResults(null); // Clear previous results

    try {
      const language = responses[currentQ._id]?.language || 'javascript';
      const studentCode = responses[currentQ._id]?.codeStr || (language === 'javascript' ? currentQ.boilerplateCode : LANGUAGE_STARTERS[language]) || "";

      const res = await fetch("/api/exam/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentCode,
          questionId: currentQ._id,
          language
        })
      });

      const data = await res.json();
      if (data.success) {
        setTestResults(data.results);
      } else {
        console.error(data.message || "Evaluation Fault");
        // Convert global faults into a UI-friendly error for the first result index
        setTestResults([{ 
          index: 0, 
          error: data.message || "Execution Fault", 
          verdict: data.verdict 
        }]);
      }
    } catch (e) {
       console.error("Network Latency Fault");
    } finally {
      setRunningTests(false);
    }
  };

  const handleSubmit = async (isViolation: boolean = false, forceStage?: 'MCQ' | 'CODING', reasonCode: SubmitReasonCode = 'MANUAL') => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    
    // Determine context (Partial Stage Submit vs Final Submission)
    const targetStage = forceStage || examStage;
    const isStageTransition = targetStage === 'MCQ' && !isViolation;

    // Use the legitimate sessionId from the sync engine
    const activeSession = recoveredSessionId || sessionId;
    
    // Clone responses for evaluation
    const finalEvaluatedResponses = { ...responses };

    // 1. Evaluate Coding Questions (Server-Side)
    if (!isStageTransition || isViolation) {
      for (const q of (questions || [])) {
        if (q.type === 'CODING' && finalEvaluatedResponses[q._id]) {
          try {
            const language = finalEvaluatedResponses[q._id].language || 'javascript';
            const studentCode = finalEvaluatedResponses[q._id].codeStr || (language === 'javascript' ? q.boilerplateCode : LANGUAGE_STARTERS[language]) || "";

            const res = await fetch("/api/exam/evaluate", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                studentCode,
                questionId: q._id,
                language
              })
            });

            const evalData = await res.json();
            
            if (!evalData.success) {
               finalEvaluatedResponses[q._id] = {
                  ...finalEvaluatedResponses[q._id],
                  testsPassed: 0,
                  totalTests: (q.testCases || []).length,
                  verdict: evalData.verdict || "FAILED",
                  evalError: evalData.message
               };
               continue;
            }

            // The server now handles the passed count logic
            const results = evalData.results;
            let passedCount = 0;
            let passedWeight = 0;
            let totalWeight = 0;

            (q.testCases || []).forEach((tc: any, idx: number) => {
               const r = results.find((res: any) => res.index === idx);
               const w = tc.weight || 1;
               totalWeight += w;

               if (r?.passed) {
                  passedCount++;
                  passedWeight += w;
               }
            });

            const weightedScore = totalWeight > 0 ? (passedWeight / totalWeight) * 100 : 0;
            
            const currentRecord = responses[q._id];
            const previousBest = currentRecord.score || 0;

            finalEvaluatedResponses[q._id] = {
              ...finalEvaluatedResponses[q._id],
              testsPassed: passedCount,
              totalTests: (q.testCases || []).length,
              score: Math.max(previousBest, Math.round(weightedScore)),
              results: results 
            };

          } catch (e) {
            console.error("Critical Evaluation Failure:", e);
          }
        }
      }
    }

    try {
      const res = await fetch('/api/exam/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: recoveredSessionId || sessionId,
          candidateId,
          finalResponses: finalEvaluatedResponses,
          stageAction: forceStage === 'MCQ' ? 'MCQ_SUBMIT' : 'FULL_SUBMIT',
          reason: reasonCode
        })
      });
      
      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || "Submission rejected by server");
      }

      if (isStageTransition) {
         setExamStage('CODING');
         setShowStageTransitionModal(false);
      } else {
         if (candidate) {
            setFinalCandidateData({ name: candidate.name, roll: candidate.collegeRollNumber });
         }
         setIsSubmitted(true);
         if (isViolation) setIsTerminated(true);
         logout();
      }
    } catch (e: any) {
      console.error("Submit API Failure:", e);
      alert(`Submission Failed: ${e.message}. Please try again once or contact support.`);
    } finally {
      setIsSubmitting(false);
    }
  };

  // 1. Success Screen View
  if (isSubmitted) {
    return (
      <div className="h-screen w-full flex items-center justify-center bg-background p-6 relative overflow-hidden">
        <div className="absolute inset-0 bg-noise opacity-[0.03] pointer-events-none z-0" />
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-primary/20 blur-[120px] rounded-full mix-blend-screen pointer-events-none" />
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-emerald-500/10 blur-[100px] rounded-full mix-blend-screen pointer-events-none" />

        <motion.div 
          initial={{ opacity: 0, scale: 0.9, filter: "blur(10px)" }}
          animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          className="w-full max-w-2xl z-10"
        >
          <Card className="border-border/50 bg-card/60 backdrop-blur-xl shadow-2xl relative overflow-hidden text-center">
            <div className="absolute top-0 left-0 w-full h-1.5 bg-gradient-to-r from-emerald-500 via-primary to-emerald-500" />
            
            <div className="pt-12 pb-8 px-8 space-y-6">
              <motion.div 
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: "spring", stiffness: 200, damping: 20, delay: 0.3 }}
                className="mx-auto bg-emerald-500/10 p-5 rounded-full w-20 h-20 flex items-center justify-center mb-4 relative"
              >
                <div className="absolute inset-0 rounded-full bg-emerald-500/20 animate-ping opacity-20" />
                <CheckCircle2 className="h-10 w-10 text-emerald-500" />
              </motion.div>

              <div className="space-y-2">
                <h1 className={`text-4xl font-semibold tracking-tighter bg-clip-text text-transparent ${isTerminated ? 'bg-gradient-to-br from-destructive to-destructive/70' : 'bg-gradient-to-br from-foreground to-foreground/70'}`}>
                  {isTerminated ? 'Assessment Terminated' : 'Mission Accomplished'}
                </h1>
                <p className="text-lg text-muted-foreground">
                  {isTerminated 
                    ? 'Your exam was automatically submitted due to multiple proctoring violations or security policy breaches.' 
                    : 'Your assessment has been securely submitted and encrypted.'}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-4 py-8 border-y border-border/40">
                <div className="text-left space-y-1">
                  <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-bold">Candidate Trace</p>
                  <p className="text-lg font-medium">{finalCandidateData?.name || "Candidate"}</p>
                </div>
                <div className="text-right space-y-1">
                  <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-bold">University ID</p>
                  <p className="text-lg font-mono font-medium">{finalCandidateData?.roll || "N/A"}</p>
                </div>
              </div>

              <div className="space-y-6 pt-4">
                <div className="p-4 rounded-xl bg-primary/5 border border-primary/20 text-sm text-foreground/80 leading-relaxed italic">
                  "Your telemetry and responses have been logged for final evaluation. Please close this window or return to the main portal. Results will be communicated through your placement coordinator."
                </div>
                
                <div className="flex flex-col sm:flex-row gap-4">
                  <Button 
                    variant="outline" 
                    className="flex-1 h-12 text-base font-medium transition-all hover:bg-muted/50"
                    onClick={() => router.replace('/')}
                  >
                    Return to Portal
                  </Button>
                  <Button 
                    className="flex-1 h-12 text-base font-medium shadow-lg shadow-primary/20 transition-all hover:scale-[1.02] active:scale-[0.98]"
                    onClick={() => window.close()}
                  >
                    Exit Dashboard
                  </Button>
                </div>
              </div>
            </div>
          </Card>
        </motion.div>
      </div>
    );
  }

  // 2a. Load Error View -- distinct from the loading spinner below on
  // purpose. Before this, any hydration failure other than "session expired"
  // (empty question bank, a 500, a network error) left `questions` at `[]`
  // forever with no error surfaced, so this exact screen kept showing
  // "Initializing..." indefinitely with zero way for the candidate (or
  // support, reading a bug report) to tell "still loading" apart from
  // "loaded, and it's broken." See the 2026-09-09 SVCE incident.
  if (loadError) {
    return (
      <div className="h-screen w-full flex flex-col items-center justify-center bg-background text-center p-8 space-y-4">
        <AlertTriangle className="h-10 w-10 text-destructive" />
        <p className="font-mono text-destructive max-w-lg">{loadError}</p>
        <Button variant="outline" onClick={() => window.location.reload()}>
          Retry
        </Button>
      </div>
    );
  }

  // 2. Loading State View
  if (!questions || questions.length === 0) {
    return (
      <div className="h-screen w-full flex items-center justify-center bg-background font-mono text-primary animate-pulse">
        Initializing Secure Sandbox Environment...
      </div>
    );
  }

  // 3. Main Dashboard View
  const currentQ = stageQuestions[currentQuestionIndex];
  const isAnswered = (id: string) => !!responses[id];

  if (!currentQ && stageQuestions.length === 0) {
     return (
        <div className="h-screen w-full flex items-center justify-center bg-background font-mono text-primary">
           Synchronizing Section Content...
        </div>
     );
  }

  return (
    <div className="h-screen w-full flex bg-background overflow-hidden relative selection:bg-none font-sans">
      <div className="absolute inset-0 bg-noise opacity-[0.03] pointer-events-none z-0" />

      {/* Warning Modal */}
      <Dialog open={showWarningModal && !isTerminated} onOpenChange={setShowWarningModal}>
        <DialogContent className="border-destructive/30 bg-destructive/5 backdrop-blur-2xl sm:max-w-md">
          <DialogHeader className="pt-4 text-center">
             <div className="h-16 w-16 rounded-full bg-destructive/10 border border-destructive/20 flex items-center justify-center mb-6 mx-auto">
                <AlertTriangle className="h-8 w-8 text-destructive animate-pulse" />
             </div>
             <DialogTitle className="text-2xl font-bold text-destructive tracking-tight">Proctoring Violation</DialogTitle>
             <DialogDescription render={<div />} className="text-base text-foreground/80 mt-2">
                {violationMessage}
                <br/><br/>
                {settings?.proctoringSeverity !== 'HIGH' ? (
                   <span className="font-bold text-destructive">
                     Looking-away warnings: {lookingAwayWarnings} / {settings?.maxCheatWarnings}.{" "}
                     Other warnings: {otherWarnings} / {settings?.maxCheatWarnings}.
                     <br/>
                     Reaching either limit will terminate your session.
                   </span>
                ) : (
                  "Multiple violations will lead to automatic submission."
                )}
             </DialogDescription>
          </DialogHeader>
          <DialogFooter className="sm:justify-center pb-2 pt-6 bg-destructive/5 border-destructive/20">
             <Button variant="destructive" className="w-full h-12 font-bold shadow-2xl shadow-destructive/20" onClick={() => {
                // Just dismiss -- the cap check runs reactively (see the
                // useEffect on lookingAwayWarnings/otherWarnings above), so it
                // fires even if this button is never clicked.
                setShowWarningModal(false);
             }}>
                Acknowledge & Resume
             </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Stage Transition Modal */}
      <Dialog open={showStageTransitionModal && !isTerminated} onOpenChange={setShowStageTransitionModal}>
        <DialogContent className="border-primary/30 bg-card/60 backdrop-blur-2xl sm:max-w-md">
          <DialogHeader className="pt-4 text-center">
             <div className="h-16 w-16 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center mb-6 mx-auto">
                <CheckCircle2 className="h-8 w-8 text-primary animate-pulse" />
             </div>
              <DialogTitle className="text-2xl font-bold tracking-tight">Finalize MCQ Section?</DialogTitle>
             <DialogDescription render={<div />} className="text-base text-foreground/80 mt-2">
                You are about to submit the objective section and proceed to the programming sandbox.
                <br/><br/>
                {unansweredCount > 0 ? (
                  <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg text-amber-500 text-sm font-medium flex items-center gap-3">
                     <AlertTriangle className="h-5 w-5" />
                     Attention: {unansweredCount} questions are still unanswered.
                  </div>
                ) : (
                  <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-lg text-emerald-500 text-sm font-medium flex items-center gap-3">
                     <CheckCircle2 className="h-5 w-5" />
                     Perfect! All questions in this section have been answered.
                  </div>
                )}
                <br/>
                <span className="font-bold text-primary">
                  Note: You cannot return to edit MCQs after this transition.
                </span>
             </DialogDescription>
          </DialogHeader>
          <DialogFooter className="sm:justify-center pb-2 pt-6 flex flex-col sm:flex-row gap-3">
             <Button variant="outline" className="flex-1 h-12" onClick={() => setShowStageTransitionModal(false)}>
                Back to Review
             </Button>
             <Button className="flex-1 h-12 font-bold shadow-2xl shadow-primary/20" onClick={() => handleSubmit(false, 'MCQ')}>
                {isSubmitting ? "Syncing..." : "Confirm & Proceed"}
             </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Final Submit Modal */}
      <Dialog open={showFinalSubmitModal && !isTerminated} onOpenChange={setShowFinalSubmitModal}>
        <DialogContent className="border-emerald-500/30 bg-card/60 backdrop-blur-2xl sm:max-w-md">
          <DialogHeader className="pt-4 text-center">
             <div className="h-16 w-16 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mb-6 mx-auto">
                <ShieldAlert className="h-8 w-8 text-emerald-500 animate-pulse" />
             </div>
             <DialogTitle className="text-2xl font-bold tracking-tight">Final Submission</DialogTitle>
             <DialogDescription render={<div />} className="text-base text-foreground/80 mt-2">
                You are about to submit your entire assessment for evaluation.
                <br/><br/>
                {unansweredCount > 0 ? (
                  <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg text-amber-500 text-sm font-medium flex items-center gap-3">
                     <AlertTriangle className="h-5 w-5" />
                     Warning: {unansweredCount} coding problems are still unattempted.
                  </div>
                ) : (
                  <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-lg text-emerald-500 text-sm font-medium flex items-center gap-3">
                     <CheckCircle2 className="h-5 w-5" />
                     All programming tasks have been attempted.
                  </div>
                )}
                <br/>
                Once submitted, your responses will be encrypted and transmitted for final grading.
             </DialogDescription>
          </DialogHeader>
          <DialogFooter className="sm:justify-center pb-2 pt-6 flex flex-col sm:flex-row gap-3">
             <Button variant="outline" className="flex-1 h-12" onClick={() => setShowFinalSubmitModal(false)}>
                Continue Coding
             </Button>
             <Button className="flex-1 h-12 font-bold bg-emerald-500 hover:bg-emerald-600 shadow-2xl shadow-emerald-500/20" onClick={() => handleSubmit(false, 'CODING')}>
                {isSubmitting ? "Finalizing..." : "Submit Everything"}
             </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Sidebar Navigation */}
      <AnimatePresence initial={false}>
        {isSidebarOpen && (
          <motion.aside
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 320, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            className="h-full border-r border-border/40 bg-card/40 backdrop-blur shrink-0 z-10 hidden md:flex flex-col relative"
          >
            <div className="p-5 border-b border-border/40 flex items-center justify-between">
              <div className="flex items-center gap-3 text-foreground/80">
                <LayoutDashboard className="h-5 w-5 text-primary" />
                <h2 className="font-medium tracking-tight text-lg">
                   {examStage === 'MCQ' ? 'Objective Bank' : 'Coding Sandbox'}
                </h2>
              </div>
              {isSyncing && <span className="flex h-2 w-2 rounded-full bg-emerald-500 animate-pulse" title="Telemetry Sync Active" />}
            </div>

            {settings?.webcamProctoringEnabled && (
              <div className="p-4 border-b border-border/40 shrink-0">
                <div className="relative aspect-video rounded-lg overflow-hidden border border-border/50 bg-black">
                  <video ref={bindSelfView} autoPlay muted playsInline className="w-full h-full object-cover" />
                  <div className="absolute top-1.5 left-1.5 flex items-center gap-1.5 bg-black/60 rounded-full px-2 py-0.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                    <span className="text-[9px] font-bold uppercase tracking-widest text-white/90">Monitoring Active</span>
                  </div>
                </div>
              </div>
            )}

            <ScrollArea className="flex-1 p-5">
              <div className="grid grid-cols-5 gap-2 pb-10">
                {stageQuestions.map((q, i) => {
                  const answered = isAnswered(q._id);
                  const active = currentQuestionIndex === i;
                  return (
                    <button
                      key={q._id}
                      onClick={() => setCurrentQuestionIndex(i)}
                      className={`
                        aspect-square rounded-md text-xs font-semibold flex items-center justify-center transition-all border
                        ${active ? 'border-primary ring-2 ring-primary/30 bg-primary text-primary-foreground transform scale-[1.05]' 
                                 : answered ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30 font-bold' 
                                 : 'bg-input/20 border-border/50 text-muted-foreground hover:bg-muted/80'}
                      `}
                    >
                      {i + 1}
                    </button>
                  );
                })}
              </div>
            </ScrollArea>
          </motion.aside>
        )}
      </AnimatePresence>

      <main className="flex-1 flex flex-col h-full bg-background relative z-10 w-full overflow-hidden">
        <header className="h-16 px-6 border-b border-border/40 bg-card/40 backdrop-blur flex items-center justify-between shrink-0">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" onClick={() => setIsSidebarOpen(!isSidebarOpen)} className="hidden md:flex">
              <Menu className="h-5 w-5" />
            </Button>
            <h1 className="font-semibold tracking-tight text-lg flex items-center gap-2">
              Section: {examStage} 
              <span className="text-muted-foreground text-sm font-normal">— Concept {currentQuestionIndex + 1} / {stageQuestions.length}</span>
            </h1>
          </div>
          
          <div className={`flex items-center gap-2 px-4 py-2 rounded-lg font-mono font-medium ${timeLeft < 300 ? 'bg-destructive/10 text-destructive animate-pulse' : 'bg-primary/10 text-primary'}`}>
            <Clock className="h-4 w-4" />
            {formatTime(timeLeft)}
          </div>
        </header>

        <div className="flex-1 overflow-auto p-4 md:p-8">
          <motion.div
            key={`${examStage}-${currentQ?._id || 'loading'}`}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="max-w-5xl mx-auto space-y-8"
          >
            <div className="space-y-4">
              <div className={`inline-flex px-3 py-1 rounded-full border font-semibold text-[10px] tracking-widest uppercase ${currentQ?.type === 'CODING' ? 'bg-accent/10 border-accent/20 text-accent' : 'bg-primary/10 border-primary/20 text-primary'}`}>
                {currentQ?.type === 'CODING' ? 'Programming Sandbox' : 'Objective Assessment'}
              </div>
              <h2 className="text-3xl md:text-4xl font-semibold tracking-tight leading-tight text-foreground/90">
                {currentQ?.title}
              </h2>
              <div className="prose prose-invert max-w-none text-foreground/70 font-medium leading-relaxed pb-6 border-b border-border/40" dangerouslySetInnerHTML={{ __html: currentQ?.content || '' }} />
            </div>

            {currentQ?.type === 'MCQ' && currentQ.options && (
              <RadioGroup 
                value={responses[currentQ?._id || ""]?.selectedOption || ""} 
                onValueChange={(val) => updateResponse(currentQ?._id || "", { selectedOption: val })}
                className="space-y-3"
              >
                {currentQ.options.map((opt: string, i: number) => {
                  const checked = responses[currentQ?._id || ""]?.selectedOption === opt;
                  return (
                    <Label 
                      key={i} 
                      className={`flex items-center space-x-4 p-5 rounded-2xl border border-border/50 cursor-pointer transition-all duration-200 ${checked ? 'bg-primary/10 border-primary ring-1 ring-primary/30' : 'bg-card/40 hover:bg-muted/40 hover:border-border/80'}`}
                    >
                      <RadioGroupItem value={opt} id={`opt-${i}`} className="sr-only" />
                      <div className={`h-5 w-5 rounded-full border-2 flex items-center justify-center transition-colors ${checked ? 'border-primary' : 'border-muted-foreground/30'}`}>
                        {checked && <div className="h-2.5 w-2.5 rounded-full bg-primary" />}
                      </div>
                      <span className="text-base font-medium">{opt}</span>
                    </Label>
                  );
                })}
              </RadioGroup>
            )}

            {currentQ?.type === 'CODING' && (
              <>
              {(() => {
                const qid = currentQ?._id || "";
                const currentLanguage = responses[qid]?.language || 'javascript';
                const codeByLanguage = responses[qid]?.codeByLanguage || {};

                const handleLanguageChange = (newLang: string) => {
                  const oldLang = currentLanguage;
                  const oldCode = responses[qid]?.codeStr ?? (oldLang === 'javascript' ? currentQ?.boilerplateCode : LANGUAGE_STARTERS[oldLang]) ?? "";
                  const nextCodeByLanguage = { ...codeByLanguage, [oldLang]: oldCode };
                  const newCode = nextCodeByLanguage[newLang] ?? (newLang === 'javascript' ? (currentQ?.boilerplateCode || "") : LANGUAGE_STARTERS[newLang]) ?? "";
                  updateResponse(qid, { language: newLang, codeByLanguage: nextCodeByLanguage, codeStr: newCode });
                  setTestResults(null); // Stale results from the previous language no longer apply
                };

                return (
                  <>
                  {currentLanguage !== 'javascript' && (
                    <div className="flex items-start gap-3 p-4 rounded-xl border border-accent/20 bg-accent/[0.03] text-xs text-muted-foreground">
                      <Code className="h-4 w-4 text-accent shrink-0 mt-0.5" />
                      <span>
                        <strong className="text-accent">{LANGUAGE_LABELS[currentLanguage]} convention:</strong> read the input from stdin
                        (e.g. <code className="font-mono bg-black/20 px-1 rounded">input()</code>, <code className="font-mono bg-black/20 px-1 rounded">Scanner</code>,
                        <code className="font-mono bg-black/20 px-1 rounded"> scanf</code>, <code className="font-mono bg-black/20 px-1 rounded">cin</code> depending
                        on your language) and print your answer to stdout.
                      </span>
                    </div>
                  )}
                  <div className="rounded-2xl overflow-hidden border border-border/50 shadow-2xl shadow-black/80 bg-[#1e1e1e] h-[550px] relative">
                    <div className="h-10 bg-muted/20 border-b border-border/30 flex items-center px-4 justify-between shrink-0">
                       <div className="flex items-center gap-2">
                          <Code className="h-4 w-4 text-accent" />
                          <Select value={currentLanguage} onValueChange={handleLanguageChange}>
                             <SelectTrigger className="h-7 w-[168px] text-[10px] uppercase tracking-widest font-bold border-none bg-transparent hover:bg-white/5 mr-2">
                                <SelectValue />
                             </SelectTrigger>
                             <SelectContent>
                                {Object.entries(LANGUAGE_LABELS).map(([key, label]) => (
                                   <SelectItem key={key} value={key} className="text-xs">{label}</SelectItem>
                                ))}
                             </SelectContent>
                          </Select>
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={runningTests}
                            onClick={runLocalTests}
                            className="h-7 text-[10px] uppercase tracking-widest font-bold bg-accent/20 text-accent hover:bg-accent hover:text-accent-foreground border-accent/30"
                          >
                             {runningTests ? "Executing..." : "Run Test Suite"}
                          </Button>
                       </div>
                       <div className="flex gap-1.5">
                          <div className="h-2 w-2 rounded-full bg-destructive/40" />
                          <div className="h-2 w-2 rounded-full bg-amber-500/40" />
                          <div className="h-2 w-2 rounded-full bg-emerald-500/40" />
                       </div>
                    </div>
                    <Editor
                      height="calc(100% - 40px)"
                      language={MONACO_LANGUAGE_MAP[currentLanguage]}
                      theme="vs-dark"
                      value={responses[qid]?.codeStr ?? (currentLanguage === 'javascript' ? currentQ?.boilerplateCode : LANGUAGE_STARTERS[currentLanguage]) ?? ""}
                      onChange={(val) => {
                        const nextCodeByLanguage = { ...codeByLanguage, [currentLanguage]: val || "" };
                        updateResponse(qid, { codeStr: val || "", language: currentLanguage, codeByLanguage: nextCodeByLanguage });
                      }}
                      options={{
                        minimap: { enabled: false },
                    fontSize: 15, 
                    fontFamily: 'var(--font-geist-mono)', 
                    padding: { top: 20 }, 
                    contextmenu: false,
                    lineNumbersMinChars: 3,
                    smoothScrolling: true,
                    cursorSmoothCaretAnimation: "on"
                  }}
                  onMount={(editor) => {
                     // Bind blur event to manual sync
                     editor.onDidBlurEditorText(() => manualSync());
                  }}
                    />
                  </div>
                  </>
                );
              })()}

              {/* Test Case Laboratory Section */}
              <div className="space-y-4 pt-6">
                <div className="flex items-center gap-2 mb-2">
                   <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                   <h4 className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Test Case Laboratory</h4>
                </div>
                
                {testResults && (
                  <div className={`flex items-center gap-4 border p-4 rounded-2xl mb-6 shadow-xl shadow-black/20 animate-in fade-in slide-in-from-top-4 duration-500 ${testResults.length > (currentQ.testCases || []).filter((tc: any) => !tc.isHidden).length ? 'bg-emerald-500/5 border-emerald-500/10' : 'bg-card/60 border-border/40'}`}>
                    <div className={`h-12 w-12 rounded-2xl flex items-center justify-center shadow-inner ${testResults.length > (currentQ.testCases || []).filter((tc: any) => !tc.isHidden).length ? 'bg-emerald-500/10 text-emerald-500' : 'bg-blue-500/10 text-blue-500'}`}>
                      {testResults.length > (currentQ.testCases || []).filter((tc: any) => !tc.isHidden).length ? <ShieldAlert className="h-6 w-6" /> : <Code className="h-6 w-6" />}
                    </div>
                    <div className="space-y-0.5">
                      <p className="text-[10px] uppercase font-bold text-muted-foreground tracking-widest opacity-60">
                         {testResults.some(r => r.isHidden) ? 'Complete Submission Diagnostics' : 'Public Logic Verification'}
                      </p>
                      <p className="text-lg font-bold tracking-tight">
                         Successfully Satisfied {testResults.filter(r => r.passed).length} of {testResults.length} Guards
                      </p>
                    </div>
                    <div className="ml-auto text-3xl font-black italic opacity-10">
                       {Math.round((testResults.filter(r => r.passed).length / testResults.length) * 100)}%
                    </div>
                  </div>
                )}
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                   {(currentQ.testCases || []).map((tc: any, originalIdx: number) => {
                      const result = testResults?.find((r: any) => r.index === originalIdx);
                      // Skip hidden ones ONLY if we don't have a result for them (during "Run Code")
                      if (tc.isHidden && !result) return null;

                      const isCorrect = result?.passed;
                      
                      return (
                        <div key={originalIdx} className={`p-4 rounded-xl border transition-all ${result ? (isCorrect ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-destructive/30 bg-destructive/5') : 'border-border/30 bg-card/40'}`}>
                           <div className="flex justify-between items-center mb-3">
                              <div className="flex items-center gap-2">
                                <span className="text-[10px] font-bold text-muted-foreground/60 uppercase">
                                   {tc.isHidden ? "Hidden Layer Verification" : `Sample Case #${originalIdx + 1}`}
                                </span>
                                {tc.isHidden && <ShieldAlert className="h-3 w-3 text-muted-foreground/50" />}
                              </div>
                              {result && (
                                <div className="flex items-center gap-2">
                                  <span className="text-[9px] font-mono text-muted-foreground/50">{result.runtime}ms</span>
                                  <span className={`text-[9px] font-bold uppercase tracking-tighter px-2 py-0.5 rounded-full ${isCorrect ? 'bg-emerald-500/20 text-emerald-500' : 'bg-destructive/20 text-destructive'}`}>
                                     {isCorrect ? 'Accepted' : result.error ? 'Runtime Error' : 'Wrong Answer'}
                                  </span>
                                </div>
                              )}
                           </div>
                           <div className="space-y-2">
                              <div className="flex flex-col gap-1">
                                 <span className="text-[9px] font-bold text-muted-foreground uppercase opacity-60">Input</span>
                                 <pre className="text-[11px] font-mono p-2 bg-black/20 rounded-md border border-white/5 overflow-hidden truncate">
                                    {tc.isHidden ? "[ HIDDEN LOGIC ]" : tc.input}
                                 </pre>
                              </div>
                              <div className="flex flex-col gap-1">
                                 <span className="text-[9px] font-bold text-muted-foreground uppercase opacity-60">Expected Output</span>
                                 <pre className="text-[11px] font-mono p-2 bg-emerald-500/5 rounded-md border border-emerald-500/10 text-emerald-500/80 overflow-hidden truncate">
                                    {tc.isHidden ? "[ HIDDEN EXPECTED ]" : tc.expectedOutput}
                                 </pre>
                              </div>
                              {result && (
                                 <div className="flex flex-col gap-1 pt-2">
                                    <span className={`text-[9px] font-bold uppercase tracking-widest opacity-60 ${isCorrect ? 'text-emerald-500' : 'text-destructive'}`}>Your Output</span>
                                    <pre className={`text-[11px] font-mono p-2 rounded-md border overflow-hidden truncate ${isCorrect ? 'bg-emerald-500/5 border-emerald-500/10 text-emerald-500' : 'bg-destructive/5 border-destructive/10 text-destructive'}`}>
                                       {result.error || String(result.actual)}
                                    </pre>
                                 </div>
                              )}
                           </div>
                        </div>
                      );
                   })}
                </div>

                {testResults && currentQ.testCases?.some((tc: any) => tc.isHidden) && (
                   <div className="flex items-center justify-between px-5 py-3 bg-black/40 rounded-2xl border border-white/5 shadow-inner group">
                      <div className="flex items-center gap-3">
                         <div className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                         <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground group-hover:text-foreground transition-colors">Background Verification Layer</span>
                      </div>
                      <div className="flex items-center gap-2 font-mono text-[11px]">
                         <span className="text-emerald-500/80">{testResults.filter(r => currentQ.testCases[r.index].isHidden && r.passed).length}</span>
                         <span className="opacity-20">/</span>
                         <span className="text-muted-foreground/60">{currentQ.testCases.filter((tc: any) => tc.isHidden).length}</span>
                         <span className="ml-1 text-[9px] text-muted-foreground/40 uppercase tracking-tighter">Guards Satisfied</span>
                      </div>
                   </div>
                )}

                {(!currentQ.testCases || currentQ.testCases.filter((t: any) => !t.isHidden).length === 0) && (
                      <div className="col-span-2 p-6 text-center border border-dashed border-border/30 rounded-2xl italic text-muted-foreground/50 text-xs">
                         This programming sandbox uses hidden logic verification only. No public test cases available for this concept.
                      </div>
                   )}
                </div>
              </>
            )}
          </motion.div>
        </div>

        <footer className="h-20 px-6 border-t border-border/40 bg-card/60 backdrop-blur flex items-center justify-between shrink-0 z-10">
          <Button variant="outline" size="lg" onClick={() => setCurrentQuestionIndex(Math.max(0, currentQuestionIndex - 1))} disabled={currentQuestionIndex === 0} className="h-12 px-6 border-border/50">
            <ChevronLeft className="h-5 w-5 mr-2" /> Previous
          </Button>
 
          {currentQuestionIndex === stageQuestions.length - 1 ? (
             <div className="flex flex-col items-end gap-1">
               <Button 
                 size="lg" 
                 onClick={() => examStage === 'MCQ' ? setShowStageTransitionModal(true) : setShowFinalSubmitModal(true)} 
                 disabled={isSubmitting || (examStage === 'CODING' && (timeLeft > CODING_MIN_TIME_SECONDS))}
                 className={`${examStage === 'MCQ' ? 'bg-primary shadow-primary/20' : 'bg-emerald-500 shadow-emerald-500/20'} text-white font-semibold px-10 h-12 shadow-lg active:scale-95 transition-all disabled:opacity-50 disabled:grayscale`}
               >
                 {isSubmitting ? "Encrypting Matrix..." : examStage === 'MCQ' ? "Finish & Proceed to Coding" : "Submit Final Assessment"}
               </Button>
               {examStage === 'CODING' && timeLeft > CODING_MIN_TIME_SECONDS && (
                  <span className="text-[10px] font-bold text-destructive/70 uppercase tracking-widest animate-pulse">
                     Final submission unlocks in {formatTime(timeLeft - CODING_MIN_TIME_SECONDS)}
                  </span>
               )}
             </div>
          ) : (
            <Button size="lg" onClick={() => setCurrentQuestionIndex(Math.min(stageQuestions.length - 1, currentQuestionIndex + 1))} className="px-10 h-12 shadow-lg shadow-primary/10">
              Next Stage <ChevronRight className="h-5 w-5 ml-2" />
            </Button>
          )}
        </footer>
      </main>
    </div>
  );
}
