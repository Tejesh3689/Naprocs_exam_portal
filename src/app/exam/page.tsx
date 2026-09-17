"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { motion, AnimatePresence } from "framer-motion";
import { ShieldAlert, Maximize, Play, Lock, CheckCircle2, ArrowLeft, Clock, Video, Circle, XCircle, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { useExamStore } from "@/store/examStore";
import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import { PROCTORING_WASM_BASE_URL, PROCTORING_MODEL_ASSET_URL } from "@/hooks/useProctoringCapture";
import { loginIdentifierSchema } from "@/lib/validators";

const loginSchema = z.object({
  identifier: loginIdentifierSchema,
  pin: z.string().length(6, "PIN must be exactly 6 digits."),
});

export default function ExamLoginPage() {
  const router = useRouter();
  const { login, isAuthenticated, setFullscreen, setMediaStream } = useExamStore();
  // Read directly from the store rather than destructuring `candidate` /
  // `sessionToken` reactively above -- this page renders the LOGIN form
  // before a new login, so those two are only ever relevant as a one-shot
  // read at submit time (see onSubmit below), not something this component
  // should re-render on.
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isAlreadySubmitted, setIsAlreadySubmitted] = useState(false);
  const [isNotStarted, setIsNotStarted] = useState(false);
  const [isConcurrentSession, setIsConcurrentSession] = useState(false);
  const [submittedCandidate, setSubmittedCandidate] = useState<any>(null);
  const [scheduledStartTime, setScheduledStartTime] = useState<string | null>(null);

  // Pre-exam waiting window: a candidate can log in up to 10 minutes before
  // exam_start (enforced server-side in /api/auth/exam-login) and land here
  // instead of being rejected -- no need to come back and re-enter creds.
  const [examStartAt, setExamStartAt] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const isWaitingForStart = !!examStartAt && nowTick < new Date(examStartAt).getTime();

  useEffect(() => {
    if (!examStartAt) return;
    const target = new Date(examStartAt).getTime();
    if (Date.now() >= target) return;
    const interval = setInterval(() => {
      const t = Date.now();
      setNowTick(t);
      if (t >= target) clearInterval(interval);
    }, 1000);
    return () => clearInterval(interval);
  }, [examStartAt]);

  const formatCountdown = (targetIso: string, nowMs: number) => {
    const diffSec = Math.max(0, Math.floor((new Date(targetIso).getTime() - nowMs) / 1000));
    const m = Math.floor(diffSec / 60).toString().padStart(2, "0");
    const s = (diffSec % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  };

  // Device Check (webcam/mic proctoring) -- only shown when the candidate's
  // drive has webcam_proctoring_enabled, resolved at login time so this page
  // doesn't need a second round-trip before deciding whether to gate on it.
  const [webcamProctoringEnabled, setWebcamProctoringEnabled] = useState(false);
  const [deviceCheckPassed, setDeviceCheckPassed] = useState(false);
  const [permissionState, setPermissionState] = useState<"idle" | "checking" | "granted" | "denied">("idle");
  const [faceVisible, setFaceVisible] = useState(false);
  const [consentChecked, setConsentChecked] = useState(false);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const deviceStreamRef = useRef<MediaStream | null>(null);
  const needsDeviceCheck = webcamProctoringEnabled && !deviceCheckPassed;

  const requestDeviceAccess = async () => {
    setPermissionState("checking");
    setFaceVisible(false);
    try {
      // Audio processing constraints deliberately disabled: Chrome's default
      // getUserMedia audio track applies automatic gain control, which
      // actively normalizes perceived volume -- verified via isolated testing
      // to fluctuate a genuinely loud, constant signal down into the 0.12-0.34
      // RMS range instead of holding steady around 0.65, undermining the
      // HIGH_NOISE threshold in useProctoringCapture.ts. Disabling it gives
      // the RMS analysis the true, unprocessed volume level.
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      deviceStreamRef.current = stream;
      if (previewVideoRef.current) {
        previewVideoRef.current.srcObject = stream;
      }
      // Store immediately so the dashboard reuses this exact grant instead
      // of prompting the browser for permission a second time.
      setMediaStream(stream);
      setPermissionState("granted");
    } catch (err) {
      console.error("Camera/mic permission denied:", err);
      setPermissionState("denied");
    }
  };

  // If the candidate grants camera/mic access but abandons this page before
  // actually starting the exam (closes the tab, navigates back), the stream
  // must not keep running -- stop it on unmount unless they made it through.
  const deviceCheckPassedRef = useRef(false);
  useEffect(() => {
    deviceCheckPassedRef.current = deviceCheckPassed;
  }, [deviceCheckPassed]);
  useEffect(() => {
    return () => {
      if (!deviceCheckPassedRef.current && deviceStreamRef.current) {
        deviceStreamRef.current.getTracks().forEach((t) => t.stop());
        setMediaStream(null);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Kick off the permission prompt as soon as the Device Check step appears.
  useEffect(() => {
    if (needsDeviceCheck && permissionState === "idle") {
      requestDeviceAccess();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsDeviceCheck]);

  // Poll for "is at least one face visible" while the device check is
  // showing -- a one-time gate, not the dashboard's continuous monitoring.
  useEffect(() => {
    if (permissionState !== "granted" || !needsDeviceCheck) return;
    let cancelled = false;
    let landmarker: FaceLandmarker | null = null;
    let interval: ReturnType<typeof setInterval> | null = null;

    (async () => {
      try {
        const fileset = await FilesetResolver.forVisionTasks(PROCTORING_WASM_BASE_URL);
        landmarker = await FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: PROCTORING_MODEL_ASSET_URL, delegate: "CPU" },
          runningMode: "VIDEO",
          numFaces: 2,
        });
        if (cancelled) {
          landmarker.close();
          return;
        }
        interval = setInterval(() => {
          const video = previewVideoRef.current;
          if (cancelled || !video || !landmarker || video.readyState < 2) return;
          // detectForVideo can throw transiently (e.g. a non-monotonic
          // timestamp if this tick races the effect's own teardown/setup,
          // which React's dev-mode Strict Mode double-invoke can trigger) --
          // never let one bad detection tick crash this screen. Skip and
          // retry on the next tick instead.
          try {
            const result = landmarker.detectForVideo(video, performance.now());
            setFaceVisible((result.faceLandmarks || []).length >= 1);
          } catch (err) {
            console.error("Face check tick failed, will retry:", err);
          }
        }, 700);
      } catch (err) {
        console.error("Failed to load face check model:", err);
      }
    })();

    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
      landmarker?.close();
    };
  }, [permissionState, needsDeviceCheck]);

  const form = useForm<z.infer<typeof loginSchema>>({
    resolver: zodResolver(loginSchema),
    defaultValues: { identifier: "", pin: "" },
  });

  const onSubmit = async (values: z.infer<typeof loginSchema>) => {
    setIsLoggingIn(true);
    setError(null);
    try {
      // Reconnect proof: if this browser already holds a persisted token for
      // the SAME identifier (i.e. this looks like a reload of an in-progress
      // attempt, not a fresh login), send it along so the server can tell a
      // genuine same-device reconnect apart from a second device -- see
      // /api/auth/exam-login/route.ts's `existingToken` handling. A mismatch
      // or absence is harmless: the server just falls back to the normal
      // multi-device check.
      const persisted = useExamStore.getState();
      const typedIdentifier = values.identifier.trim().toLowerCase();
      const matchesPersistedCandidate =
        !!persisted.candidate &&
        (persisted.candidate.email?.toLowerCase() === typedIdentifier ||
          persisted.candidate.collegeRollNumber?.toLowerCase() === typedIdentifier);
      const existingToken = matchesPersistedCandidate ? persisted.sessionToken : undefined;

      const res = await fetch("/api/auth/exam-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: values.identifier,
          accessPin: values.pin,
          ...(existingToken ? { existingToken } : {}),
        }),
      });

      const data = await res.json();

      if (res.ok) {
        // Update store with actual candidate data. Use the canonical email
        // the server returns (data.email) rather than the raw typed value --
        // the candidate may have logged in with their roll number instead.
        login({
          id: data.candidateId,
          name: data.name,
          email: data.email ?? values.identifier,
          pin: values.pin,
          collegeRollNumber: data.collegeRollNumber
        }, data.token);
        setWebcamProctoringEnabled(!!data.webcamProctoringEnabled);
        setExamStartAt(data.examStart || null);
      } else if (res.status === 403) {
        const errorMsg = data.error?.toLowerCase() || "";
        if (errorMsg.includes("opens on") || errorMsg.includes("scheduled")) {
          setIsNotStarted(true);
          setScheduledStartTime(data.error);
        } else {
          setIsAlreadySubmitted(true);
          setSubmittedCandidate({ name: data.name, rollNumber: data.collegeRollNumber });
        }
      } else if (res.status === 409) {
        setIsConcurrentSession(true);
        setSubmittedCandidate({ name: data.name, rollNumber: data.collegeRollNumber });
      } else {
        setError(data.error || "Authentication failed. Please check your credentials.");
      }
    } catch (err) {
      setError("Network error. Please check your connection.");
    } finally {
      setIsLoggingIn(false);
    }
  };

  const startExam = async () => {
    try {
      if (document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen();
        setFullscreen(true);
      }
      setTimeout(() => {
        router.push("/exam/dashboard");
      }, 500);
    } catch (err) {
      console.error("Fullscreen failed:", err);
      // Fallback
      router.push("/exam/dashboard");
    }
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center p-4 bg-background relative overflow-hidden">
      {/* Decorative noise */}
      <div className="absolute inset-0 bg-noise pointer-events-none opacity-5mix-blend-overlay z-0" />
      
      {/* Immersive glow */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-primary/5 blur-[150px] rounded-full pointer-events-none z-0" />

      <AnimatePresence mode="wait">
        {!isAuthenticated ? (
          <motion.div
            key={isAlreadySubmitted ? "already-submitted" : "login-form"}
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95, filter: "blur(4px)" }}
            transition={{ duration: 0.5 }}
            className="w-full max-w-md z-10"
          >
            {isAlreadySubmitted ? (
               <Card className="border-emerald-500/30 bg-card/40 backdrop-blur-2xl shadow-2xl overflow-hidden relative text-center">
                  <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-emerald-500/50 via-primary/50 to-emerald-500/50" />
                  <CardHeader className="pt-10 pb-6">
                    <div className="h-16 w-16 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mb-6 mx-auto">
                      <CheckCircle2 className="h-8 w-8 text-emerald-500" />
                    </div>
                    <CardTitle className="text-2xl font-bold tracking-tight text-foreground">Assessment Received</CardTitle>
                    <CardDescription className="text-muted-foreground mt-3 px-4">
                      Your identity has been verified, but our records indicate that your examination session has already been processed.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="pb-8">
                    <div className="p-5 rounded-2xl bg-primary/5 border border-primary/10 space-y-4">
                      <div className="grid grid-cols-2 gap-4">
                         <div className="text-left">
                            <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-bold mb-1">Candidate</p>
                            <p className="text-sm font-medium">{submittedCandidate?.name}</p>
                         </div>
                         <div className="text-right">
                            <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-bold mb-1">University ID</p>
                            <p className="text-sm font-mono">{submittedCandidate?.rollNumber}</p>
                         </div>
                      </div>
                      <div className="pt-4 border-t border-primary/10 flex items-center justify-center gap-2 text-emerald-500/80 font-medium text-xs">
                         <ShieldAlert className="h-3 w-3" />
                         Transmission Finalized & Locked
                      </div>
                    </div>
                  </CardContent>
                  <CardFooter className="pb-10 pt-2 px-8 flex flex-col gap-4">
                    <Button 
                      variant="outline" 
                      onClick={() => setIsAlreadySubmitted(false)}
                      className="w-full h-12 border-border/40 hover:bg-muted/50 gap-2 font-medium"
                    >
                      <ArrowLeft className="h-4 w-4" /> Switch Account
                    </Button>
                    <p className="text-[10px] text-muted-foreground leading-relaxed italic">
                      If you believe this is an error, please contact your drive coordinator immediately. Duplicate attempts are strictly prohibited under drive policy.
                    </p>
                  </CardFooter>
               </Card>
            ) : isConcurrentSession ? (
              <Card className="border-destructive/30 bg-card/40 backdrop-blur-2xl shadow-2xl overflow-hidden relative text-center">
                  <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-destructive/50 via-primary/50 to-destructive/50" />
                  <CardHeader className="pt-10 pb-6">
                    <div className="h-16 w-16 rounded-full bg-destructive/10 border border-destructive/20 flex items-center justify-center mb-6 mx-auto">
                      <ShieldAlert className="h-8 w-8 text-destructive animate-pulse" />
                    </div>
                    <CardTitle className="text-2xl font-bold tracking-tight text-foreground">Concurrency Lock</CardTitle>
                    <CardDescription className="text-muted-foreground mt-3 px-4">
                      Security Alert: An active session for this candidate is already running on another device or browser tab.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="pb-8">
                    <div className="p-6 rounded-2xl bg-destructive/5 border border-destructive/10 space-y-4">
                      <p className="text-sm text-foreground/80 leading-relaxed">
                        To maintain assessment integrity, multiple simultaneous logins are prohibited. 
                      </p>
                      <div className="pt-4 border-t border-destructive/10 text-xs text-muted-foreground italic">
                        Session will auto-expire after 2 minutes of inactivity. Please close other tabs and try again.
                      </div>
                    </div>
                  </CardContent>
                  <CardFooter className="pb-10 pt-2 px-8 flex flex-col gap-4">
                    <Button 
                      variant="outline" 
                      onClick={() => setIsConcurrentSession(false)}
                      className="w-full h-12 border-border/40 hover:bg-muted/50 font-medium"
                    >
                      Back to Login
                    </Button>
                  </CardFooter>
               </Card>
            ) : isNotStarted ? (
               <Card className="border-primary/30 bg-card/40 backdrop-blur-2xl shadow-2xl overflow-hidden relative text-center">
                  <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-primary/50 via-accent/50 to-primary/50" />
                  <CardHeader className="pt-10 pb-6">
                    <div className="h-16 w-16 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center mb-6 mx-auto">
                      <Clock className="h-8 w-8 text-primary animate-pulse" />
                    </div>
                    <CardTitle className="text-2xl font-bold tracking-tight text-foreground">Admission Pending</CardTitle>
                    <CardDescription className="text-muted-foreground mt-3 px-4">
                      {scheduledStartTime || "The assessment drive is scheduled for a future window and has not opened yet."}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="pb-10 px-8 flex flex-col items-center">
                     <div className="h-2 w-full bg-muted rounded-full overflow-hidden mb-6">
                        <div className="h-full w-1/3 bg-primary animate-[loading_2s_infinite_ease-in-out]" />
                     </div>
                     <Button 
                       variant="outline" 
                       onClick={() => setIsNotStarted(false)}
                       className="w-full h-11 border-border/40"
                    >
                       Acknowledge
                    </Button>
                  </CardContent>
               </Card>
            ) : (
               <Card className="border-border/30 bg-card/40 backdrop-blur-2xl shadow-2xl overflow-hidden relative">
                 <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-transparent via-primary/50 to-transparent" />
                 
                 <CardHeader className="pt-8 pb-6 flex flex-col items-center text-center">
                   <div className="h-12 w-12 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center mb-4">
                     <Lock className="h-6 w-6 text-primary" />
                   </div>
                   <CardTitle className="text-2xl font-medium tracking-tight">Exam Portal Authentication</CardTitle>
                   <CardDescription className="text-muted-foreground mt-2 px-6">
                     Verify your identity using the access PIN generated during registration.
                   </CardDescription>
                 </CardHeader>
                 
                 <CardContent>
                   <form id="exam-login" onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                     {error && (
                       <motion.div 
                         initial={{ opacity: 0, height: 0 }}
                         animate={{ opacity: 1, height: "auto" }}
                         className="bg-destructive/10 border border-destructive/20 text-destructive text-sm p-3 rounded-lg text-center"
                       >
                         {error}
                       </motion.div>
                     )}
                     
                     <div className="space-y-2">
                       <Label className="text-foreground/70">Email or Roll Number</Label>
                       <Input
                         type="text"
                         placeholder="Enter verified email or roll number"
                         className="bg-input/50 h-12"
                         disabled={isLoggingIn}
                         {...form.register("identifier")}
                       />
                     </div>
                     <div className="space-y-2">
                       <Label className="text-foreground/70">6-Digit Access PIN</Label>
                       <Input 
                         type="text" 
                         inputMode="numeric"
                         maxLength={6}
                         placeholder="••••••" 
                         className="bg-input/50 h-12 text-center tracking-[0.5em] font-mono text-lg"
                         disabled={isLoggingIn}
                         {...form.register("pin")}
                       />
                     </div>
                   </form>
                 </CardContent>
                 
                 <CardFooter className="pb-8">
                   <Button 
                     type="submit" 
                     form="exam-login" 
                     disabled={isLoggingIn}
                     className="w-full h-12 text-base shadow-lg shadow-primary/10 transition-transform active:scale-[0.98]"
                   >
                     {isLoggingIn ? "Verifying..." : "Authenticate"}
                   </Button>
                 </CardFooter>
               </Card>
            )}
          </motion.div>
        ) : needsDeviceCheck ? (
          <motion.div
            key="device-check"
            initial={{ opacity: 0, scale: 0.95, filter: "blur(4px)" }}
            animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
            transition={{ duration: 0.6, ease: "easeOut" }}
            className="w-full max-w-md z-10"
          >
            <Card className="border-primary/20 bg-card/60 backdrop-blur-3xl shadow-2xl relative overflow-hidden">
              <div className="absolute inset-x-0 top-0 h-1 bg-primary animate-pulse-slow" />

              <CardHeader className="pt-10 pb-4 text-center">
                <Video className="h-12 w-12 text-primary mx-auto mb-4 opacity-80" />
                <CardTitle className="text-2xl font-medium">Device Check</CardTitle>
                <CardDescription className="text-muted-foreground mt-2">
                  We need your camera and microphone before the exam starts. Make sure your face is clearly visible in the frame.
                </CardDescription>
              </CardHeader>

              {permissionState === "denied" ? (
                <>
                  <CardContent className="px-8 pb-4 space-y-4">
                    <div className="aspect-video rounded-xl border border-destructive/30 bg-destructive/5 flex items-center justify-center">
                      <XCircle className="h-10 w-10 text-destructive" />
                    </div>
                    <div className="bg-destructive/5 border border-destructive/20 rounded-xl p-4 text-sm text-muted-foreground">
                      Camera and microphone access are required to continue. This drive has webcam proctoring enabled -- please allow
                      access in your browser&apos;s site settings, then retry.
                    </div>
                  </CardContent>
                  <CardFooter className="pb-8">
                    <Button variant="outline" className="w-full h-11" onClick={requestDeviceAccess}>
                      Retry Permission
                    </Button>
                  </CardFooter>
                </>
              ) : (
                <>
                  <CardContent className="px-8 pb-4 space-y-4">
                    <div className="relative aspect-video rounded-xl border border-border/50 bg-black overflow-hidden">
                      <video ref={previewVideoRef} autoPlay muted playsInline className="w-full h-full object-cover" />
                      {permissionState === "checking" && (
                        <div className="absolute inset-0 flex items-center justify-center bg-black/60">
                          <Loader2 className="h-8 w-8 text-muted-foreground animate-spin" />
                        </div>
                      )}
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center gap-2 text-sm">
                        {permissionState === "granted" ? (
                          <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                        ) : (
                          <Circle className="h-4 w-4 text-muted-foreground" />
                        )}
                        <span className="flex-1 text-foreground/80">Camera detected</span>
                      </div>
                      <div className="flex items-center gap-2 text-sm">
                        {permissionState === "granted" ? (
                          <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                        ) : (
                          <Circle className="h-4 w-4 text-muted-foreground" />
                        )}
                        <span className="flex-1 text-foreground/80">Microphone detected</span>
                      </div>
                      <div className="flex items-center gap-2 text-sm">
                        {faceVisible ? (
                          <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                        ) : (
                          <Circle className="h-4 w-4 text-muted-foreground" />
                        )}
                        <span className="flex-1 text-foreground/80">Face visible</span>
                      </div>
                    </div>

                    <Label className="flex items-start gap-3 p-4 rounded-xl border border-primary/20 bg-primary/5 cursor-pointer">
                      <Checkbox
                        checked={consentChecked}
                        onCheckedChange={(v) => setConsentChecked(!!v)}
                        className="mt-0.5 border-primary/50"
                      />
                      <span className="text-xs text-muted-foreground leading-relaxed">
                        <span className="block text-[10px] font-bold uppercase tracking-widest text-primary mb-1">
                          Separate consent — biometric monitoring
                        </span>
                        I consent to my webcam and microphone being used for periodic proctoring snapshots during this exam.
                        Snapshots are retained for review and deleted afterward. This consent is specific to biometric
                        monitoring and is separate from the exam integrity policy.
                      </span>
                    </Label>
                  </CardContent>
                  <CardFooter className="pb-8">
                    <Button
                      className="w-full h-12 text-base"
                      disabled={permissionState !== "granted" || !faceVisible || !consentChecked}
                      onClick={() => setDeviceCheckPassed(true)}
                    >
                      Continue to Exam
                    </Button>
                  </CardFooter>
                </>
              )}
            </Card>
          </motion.div>
        ) : isWaitingForStart ? (
          <motion.div
            key="waiting-room"
            initial={{ opacity: 0, scale: 0.95, filter: "blur(4px)" }}
            animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
            transition={{ duration: 0.6, ease: "easeOut" }}
            className="w-full max-w-md z-10"
          >
            <Card className="border-primary/20 bg-card/60 backdrop-blur-3xl shadow-2xl relative overflow-hidden">
              <div className="absolute inset-x-0 top-0 h-1 bg-primary animate-pulse-slow" />
              <CardHeader className="pt-10 pb-4 text-center">
                <Clock className="h-12 w-12 text-primary mx-auto mb-4 opacity-80" />
                <CardTitle className="text-2xl font-medium">You&apos;re All Set</CardTitle>
                <CardDescription className="text-muted-foreground mt-2 px-4">
                  You&apos;re signed in and ready. Your exam hasn&apos;t opened yet -- sit tight, this
                  screen moves on automatically. No need to log in again.
                </CardDescription>
              </CardHeader>
              <CardContent className="px-8 pb-10 flex flex-col items-center gap-2">
                <p className="text-5xl font-mono font-bold text-primary tabular-nums">
                  {examStartAt ? formatCountdown(examStartAt, nowTick) : "--:--"}
                </p>
                <p className="text-[10px] text-muted-foreground uppercase tracking-widest font-bold">
                  Time until exam opens
                </p>
              </CardContent>
            </Card>
          </motion.div>
        ) : (
          <motion.div
            key="pre-exam-checks"
            initial={{ opacity: 0, scale: 0.95, filter: "blur(4px)" }}
            animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
            transition={{ duration: 0.6, ease: "easeOut" }}
            className="w-full max-w-lg z-10"
          >
            <Card className="border-primary/20 bg-card/60 backdrop-blur-3xl shadow-2xl relative overflow-hidden">
              <div className="absolute inset-x-0 top-0 h-1 bg-primary animate-pulse-slow" />
              
              <CardHeader className="pt-10 pb-4 text-center">
                <ShieldAlert className="h-12 w-12 text-primary mx-auto mb-4 opacity-80" />
                <CardTitle className="text-2xl font-medium">Authentication Successful</CardTitle>
                <CardDescription className="text-muted-foreground mt-2">
                  Read the instructions carefully before beginning the examination.
                </CardDescription>
              </CardHeader>
              
              <CardContent className="px-8 pb-8 space-y-4">
                <div className="bg-destructive/5 border border-destructive/20 rounded-xl p-5 space-y-3">
                  <h4 className="font-semibold text-destructive flex items-center gap-2">
                    <ShieldAlert className="h-4 w-4" /> Anti-Cheat Enforced
                  </h4>
                  <ul className="text-sm text-muted-foreground space-y-2 list-disc list-inside">
                    <li>This test is monitored via browser visibility APIs.</li>
                    <li>Switching tabs or minimizing the window is recorded.</li>
                    <li>Copy, paste, and right-click functions are disabled.</li>
                    <li>The exam requires full-screen mode to begin.</li>
                  </ul>
                </div>
                
                <p className="text-center text-sm text-foreground/70 pb-2">
                  By clicking 'Start', you agree to abide by the academic integrity policy.
                </p>
                
                <Button 
                  onClick={startExam}
                  className="w-full h-14 text-lg bg-primary text-primary-foreground hover:bg-primary/90 flex items-center justify-center gap-3 transition-all hover:scale-[1.02] active:scale-[0.98]"
                >
                  <Maximize className="h-5 w-5" />
                  <span>Enter Fullscreen & Start Exam</span>
                  <Play className="h-4 w-4 ml-2 fill-current" />
                </Button>
              </CardContent>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
