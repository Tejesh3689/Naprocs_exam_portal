"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Copy, CheckCircle2, UploadCloud, ArrowRight, Lock, Clock } from "lucide-react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { formatToIST } from "@/lib/time";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { emailSchema, rollNumberSchema } from "@/lib/validators";

const formSchema = z.object({
  fullName: z.string().min(2, "Name must be at least 2 characters."),
  email: emailSchema,
  phone: z.string().min(10, "Please enter a valid phone number."),
  rollNumber: rollNumberSchema,
  resume: z.any().optional(), // Mock file upload
});

export default function RegisterPage() {
  const params = useParams();
  const slug = params.slug as string;

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [successPin, setSuccessPin] = useState<string | null>(null);
  const [hasCopied, setHasCopied] = useState(false);
  const [driveInfo, setDriveInfo] = useState<any>(null);
  const [isLoadingStatus, setIsLoadingStatus] = useState(true);
  const [errorStatus, setErrorStatus] = useState<string | null>(null);
  // Review-before-you-submit step: captured form values sit here until the
  // candidate confirms. Nothing is sent to the server until "Confirm & Register".
  const [reviewData, setReviewData] = useState<z.infer<typeof formSchema> | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);

  // Fetch specific drive info for this slug
  const fetchDriveInfo = async () => {
    try {
       const res = await fetch(`/api/register/${slug}`);
       const data = await res.json();
       if (data.success && data.drive) {
          setDriveInfo(data.drive);
       } else {
          setErrorStatus(data.error || "Invalid registration link");
       }
    } catch (e) {
       setErrorStatus("Network error while verifying drive");
    } finally {
       setIsLoadingStatus(false);
    }
  };

  useEffect(() => {
     if (!slug) return;
     fetchDriveInfo();
     // Re-check every 30s (same polling idiom used across the admin views) --
     // without this, a candidate who opens the link while registration is
     // open and sits on the form past reg_end keeps seeing an enabled form.
     // The actual POST /api/register still correctly rejects a late
     // submission server-side either way; this just keeps the displayed
     // status honest instead of stale.
     const interval = setInterval(fetchDriveInfo, 30_000);
     return () => clearInterval(interval);
     // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      fullName: "",
      email: "",
      phone: "",
      rollNumber: "",
    },
  });

  const resumeValue = form.watch("resume");
  const selectedFile = resumeValue?.[0];

  // Step 1: form is valid -> move to the review card. No network call yet.
  const onSubmit = (values: z.infer<typeof formSchema>) => {
    setReviewError(null);
    setReviewData(values);
  };

  // Step 2: candidate confirms on the review card -> this is the actual
  // registration call, unchanged from what onSubmit used to do directly.
  const confirmAndSubmit = async () => {
    if (!reviewData) return;
    setIsSubmitting(true);
    setReviewError(null);
    try {
      const formData = new FormData();
      formData.append("name", reviewData.fullName);
      formData.append("email", reviewData.email);
      formData.append("phone", reviewData.phone);
      formData.append("collegeRollNumber", reviewData.rollNumber);
      formData.append("driveId", driveInfo._id);

      // Extract the File object from the FileList
      if (reviewData.resume && reviewData.resume[0]) {
        formData.append("resume", reviewData.resume[0]);
      }

      // 2026-09-22 (VVIT last-minute registration rush): a resume PDF is the
      // heaviest thing this form ever sends, and it's uploaded over whatever
      // connection the candidate happens to have -- campus wifi shared by
      // hundreds of people all registering right before the deadline, or
      // patchy mobile data. Without a bound, a genuinely stalled (not
      // failed, just very slow) upload could sit on "Registering..."
      // indefinitely rather than ever resolving to a retry-able error --
      // exactly the kind of hang a panicking student an hour before a
      // deadline has no way to tell apart from "it's still working, wait."
      // 45s is generous for a <=5MB PDF on a genuinely bad connection while
      // still giving a bounded, actionable failure instead of an open-ended
      // spinner.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 45_000);
      let res: Response;
      try {
        res = await fetch("/api/register", {
          method: "POST",
          body: formData, // No Content-Type header needed for FormData; the browser sets it with boundaries
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }

      const data = await res.json();

      if (res.ok) {
        setSuccessPin(data.accessPin);
      } else {
        setReviewError(data.error || "Registration failed");
      }
    } catch (err: any) {
      // AbortError specifically means OUR timeout fired (see above), not a
      // hard network failure -- worth telling the candidate that directly,
      // since "try again" is genuinely the right move and their data/file
      // selection is still intact on this screen either way.
      if (err?.name === "AbortError") {
        setReviewError("Upload timed out -- this usually means a slow connection. Please try again, ideally on wifi. Your details are still filled in, no need to start over.");
      } else {
        setReviewError("Network connection error. Please check your connection and try again -- your details are still filled in, no need to start over.");
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  // Back to the form, previous values retained (form.reset() is NOT called).
  const editDetails = () => {
    setReviewError(null);
    setReviewData(null);
  };

  const copyPin = () => {
    if (successPin) {
      navigator.clipboard.writeText(successPin);
      setHasCopied(true);
      setTimeout(() => setHasCopied(false), 2000);
    }
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center p-4 relative overflow-hidden">
      {/* Decorative gradient orb */}
      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-primary/20 blur-[120px] rounded-full mix-blend-screen pointer-events-none" />
      <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-accent/10 blur-[100px] rounded-full mix-blend-screen pointer-events-none" />

      <AnimatePresence mode="wait">
        {isLoadingStatus ? (
          <motion.div 
            key="loader"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex flex-col items-center gap-4 z-10"
          >
             <div className="h-10 w-10 border-4 border-primary/20 border-t-primary rounded-full animate-spin" />
             <p className="text-sm font-medium text-muted-foreground animate-pulse">Checking Drive Status...</p>
          </motion.div>
        ) : (errorStatus || (driveInfo && driveInfo.status !== "ACTIVE")) ? (
          <motion.div
            key="suspended"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="w-full max-w-md z-10"
          >
             <Card className="border-destructive/30 bg-card/40 backdrop-blur-2xl shadow-2xl text-center overflow-hidden relative">
                <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-destructive/50 via-primary/50 to-destructive/50" />
                <CardHeader className="pt-10 pb-6">
                   <div className="h-16 w-16 rounded-full bg-destructive/10 border border-destructive/20 flex items-center justify-center mb-6 mx-auto">
                      <Lock className="h-8 w-8 text-destructive" />
                   </div>
                   <CardTitle className="text-2xl font-bold tracking-tight">Access Restricted</CardTitle>
                   <CardDescription className="px-6 mt-3">
                      {errorStatus || (driveInfo?.status === "PENDING" ? `Registration opens on ${formatToIST(driveInfo.regStart)}` : "The registration window for this drive has closed.")}
                   </CardDescription>
                </CardHeader>
                <CardFooter className="pb-10 pt-4 px-10 flex flex-col gap-4">
                   <div className="text-xs text-muted-foreground italic bg-muted/30 p-4 rounded-xl border border-border/40">
                      This recruitment flow is currently locked. Please ensure you are using the official link provided by your placement cell.
                   </div>
                   <Link href="/" className="w-full">
                      <Button variant="outline" className="w-full h-11">Return to Portal</Button>
                   </Link>
                </CardFooter>
             </Card>
          </motion.div>
        ) : (reviewData && !successPin) ? (
          <motion.div
            key="review"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, filter: "blur(10px)" }}
            transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
            className="w-full max-w-lg z-10"
          >
            <Card className="border-border/50 bg-card/60 backdrop-blur-xl shadow-2xl relative overflow-hidden">
              <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-primary via-accent to-primary" />

              <CardHeader className="space-y-3 pb-6">
                <CardTitle className="text-3xl font-medium tracking-tight bg-clip-text text-transparent bg-gradient-to-br from-foreground to-foreground/70">
                  Review Your Details
                </CardTitle>
                <CardDescription className="text-base text-muted-foreground/80">
                  Please confirm everything below is correct before we lock in your registration.
                </CardDescription>
              </CardHeader>

              <CardContent className="space-y-6">
                {reviewError && (
                  <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm text-center font-medium">
                    {reviewError}
                  </div>
                )}

                <div className="space-y-1">
                  <p className="text-xs uppercase tracking-widest text-muted-foreground font-semibold">Candidate</p>
                  <div className="rounded-xl border border-border/40 bg-input/20 divide-y divide-border/40">
                    <div className="flex justify-between px-4 py-3">
                      <span className="text-sm text-muted-foreground">Full Name</span>
                      <span className="text-sm font-medium">{reviewData.fullName}</span>
                    </div>
                    <div className="flex justify-between px-4 py-3">
                      <span className="text-sm text-muted-foreground">College Email</span>
                      <span className="text-sm font-medium">{reviewData.email}</span>
                    </div>
                    <div className="flex justify-between px-4 py-3">
                      <span className="text-sm text-muted-foreground">Phone Number</span>
                      <span className="text-sm font-medium">{reviewData.phone}</span>
                    </div>
                    <div className="flex justify-between px-4 py-3">
                      <span className="text-sm text-muted-foreground">Roll Number</span>
                      <span className="text-sm font-medium font-mono uppercase">{reviewData.rollNumber}</span>
                    </div>
                    <div className="flex justify-between px-4 py-3">
                      <span className="text-sm text-muted-foreground">Resume</span>
                      <span className="text-sm font-medium truncate max-w-[220px]">
                        {reviewData.resume?.[0]?.name || "No file selected"}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="space-y-1">
                  <p className="text-xs uppercase tracking-widest text-muted-foreground font-semibold">This Drive</p>
                  <div className="rounded-xl border border-border/40 bg-input/20 divide-y divide-border/40">
                    <div className="flex justify-between px-4 py-3">
                      <span className="text-sm text-muted-foreground">Drive</span>
                      <span className="text-sm font-medium">{driveInfo?.title}</span>
                    </div>
                    {driveInfo?.examStart && (
                      <div className="flex justify-between px-4 py-3">
                        <span className="text-sm text-muted-foreground">Exam Opens</span>
                        <span className="text-sm font-medium">{formatToIST(driveInfo.examStart)}</span>
                      </div>
                    )}
                    {driveInfo?.examEnd && (
                      <div className="flex justify-between px-4 py-3">
                        <span className="text-sm text-muted-foreground">Exam Closes</span>
                        <span className="text-sm font-medium">{formatToIST(driveInfo.examEnd)}</span>
                      </div>
                    )}
                  </div>
                </div>
              </CardContent>

              <CardFooter className="pt-2 pb-8 flex gap-3">
                <Button
                  type="button"
                  variant="outline"
                  disabled={isSubmitting}
                  onClick={editDetails}
                  className="flex-1 h-12 text-base font-medium"
                >
                  Edit Details
                </Button>
                <Button
                  type="button"
                  disabled={isSubmitting}
                  onClick={confirmAndSubmit}
                  className="flex-1 h-12 text-base font-medium transition-all hover:scale-[1.02] active:scale-[0.98] shadow-lg shadow-primary/20"
                >
                  {isSubmitting ? (
                    <div className="flex items-center space-x-2">
                      <div className="h-4 w-4 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
                      <span>Registering...</span>
                    </div>
                  ) : (
                    <div className="flex items-center justify-center space-x-2">
                      <span>Confirm & Register</span>
                      <ArrowRight className="h-4 w-4" />
                    </div>
                  )}
                </Button>
              </CardFooter>
            </Card>
          </motion.div>
        ) : !successPin ? (
          <motion.div
            key="form"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, filter: "blur(10px)" }}
            transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
            className="w-full max-w-lg z-10"
          >
            <Card className="border-border/50 bg-card/60 backdrop-blur-xl shadow-2xl relative overflow-hidden">
              <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-primary via-accent to-primary" />
              
              <CardHeader className="space-y-3 pb-8">
                <CardTitle className="text-3xl font-medium tracking-tight bg-clip-text text-transparent bg-gradient-to-br from-foreground to-foreground/70">
                  {driveInfo?.title || "Candidate Registration"}
                </CardTitle>
                <CardDescription className="text-base text-muted-foreground/80">
                  Secure your spot for the {driveInfo?.title || "campus placement"} drive.
                </CardDescription>
              </CardHeader>
              
              <CardContent>
                <form id="register-form" onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
                  {form.formState.errors.root && (
                    <div className="p-3 mb-4 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm text-center font-medium">
                      {form.formState.errors.root.message}
                    </div>
                  )}
                  <div className="space-y-2">
                    <Label htmlFor="fullName" className="text-foreground/80">Full Name</Label>
                    <Input 
                      id="fullName" 
                      placeholder="Jane Doe" 
                      disabled={isSubmitting}
                      className="bg-input/50 border-border/50 focus-visible:ring-primary/50 transition-all h-11"
                      {...form.register("fullName")} 
                    />
                    {form.formState.errors.fullName && (
                      <p className="text-sm text-destructive">{form.formState.errors.fullName.message}</p>
                    )}
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                    <div className="space-y-2">
                      <Label htmlFor="email" className="text-foreground/80">College Email</Label>
                      <Input 
                        id="email" 
                        type="email" 
                        placeholder="jane@college.edu" 
                        disabled={isSubmitting}
                        className="bg-input/50 border-border/50 focus-visible:ring-primary/50 transition-all h-11"
                        {...form.register("email")} 
                      />
                      {form.formState.errors.email && (
                        <p className="text-sm text-destructive">{form.formState.errors.email.message}</p>
                      )}
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="phone" className="text-foreground/80">Phone Number</Label>
                      <Input 
                        id="phone" 
                        type="tel" 
                        placeholder="+1 (555) 000-0000" 
                        disabled={isSubmitting}
                        className="bg-input/50 border-border/50 focus-visible:ring-primary/50 transition-all h-11"
                        {...form.register("phone")} 
                      />
                      {form.formState.errors.phone && (
                        <p className="text-sm text-destructive">{form.formState.errors.phone.message}</p>
                      )}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="rollNumber" className="text-foreground/80">University Roll Number</Label>
                    <Input 
                      id="rollNumber" 
                      placeholder="e.g. CS-2024-042" 
                      disabled={isSubmitting}
                      className="bg-input/50 border-border/50 focus-visible:ring-primary/50 transition-all h-11 font-mono uppercase"
                      {...form.register("rollNumber")} 
                    />
                    {form.formState.errors.rollNumber && (
                      <p className="text-sm text-destructive">{form.formState.errors.rollNumber.message}</p>
                    )}
                  </div>

                  <div className="space-y-2 pt-2">
                    <Label className="text-foreground/80">Resume (PDF)</Label>
                    <div className="relative group cursor-pointer">
                      <input 
                        type="file" 
                        accept=".pdf"
                        className="absolute inset-0 w-full h-full opacity-0 z-10 cursor-pointer"
                        disabled={isSubmitting}
                        {...form.register("resume")}
                      />
                      <div className={`flex flex-col items-center justify-center p-6 border-2 border-dashed rounded-xl transition-all ${selectedFile ? 'border-emerald-500/50 bg-emerald-500/5' : 'border-border/60 bg-input/20 group-hover:bg-input/40 group-hover:border-primary/50'}`}>
                        {selectedFile ? (
                           <motion.div 
                             initial={{ scale: 0.9, opacity: 0 }}
                             animate={{ scale: 1, opacity: 1 }}
                             className="flex flex-col items-center text-center"
                           >
                              <div className="h-10 w-10 rounded-full bg-emerald-500/20 flex items-center justify-center mb-3">
                                 <CheckCircle2 className="h-6 w-6 text-emerald-500" />
                              </div>
                              <p className="text-sm font-semibold text-emerald-500 truncate max-w-[200px]">
                                 {selectedFile.name}
                              </p>
                              <p className="text-[10px] text-muted-foreground mt-1 uppercase tracking-tighter">
                                 Ready for ingestion • Click to replace
                              </p>
                           </motion.div>
                        ) : (
                          <>
                            <UploadCloud className="h-8 w-8 text-muted-foreground mb-3 group-hover:text-primary transition-colors" />
                            <p className="text-sm font-medium text-foreground/80">Click to upload or drag & drop</p>
                            <p className="text-xs text-muted-foreground mt-1">PDF (Max 5MB)</p>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </form>
              </CardContent>
              
              <CardFooter className="pt-2 pb-8">
                <Button 
                  type="submit" 
                  form="register-form" 
                  disabled={isSubmitting}
                  className="w-full h-12 text-base font-medium transition-all hover:scale-[1.02] active:scale-[0.98] shadow-lg shadow-primary/20"
                >
                  {isSubmitting ? (
                    <motion.div 
                      key="submitting"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="flex items-center space-x-2"
                    >
                      <div className="h-4 w-4 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
                      <span>Processing...</span>
                    </motion.div>
                  ) : (
                    <motion.div
                      key="idle"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="flex items-center justify-center space-x-2"
                    >
                      <span>Complete Registration</span>
                      <ArrowRight className="h-4 w-4" />
                    </motion.div>
                  )}
                </Button>
              </CardFooter>
            </Card>
          </motion.div>
        ) : (
          <motion.div
            key="success"
            initial={{ opacity: 0, scale: 0.95, filter: "blur(10px)" }}
            animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
            transition={{ duration: 0.6, delay: 0.1, ease: [0.22, 1, 0.36, 1] }}
            className="w-full max-w-md z-10"
          >
            <Card className="border-border/50 bg-card/60 backdrop-blur-xl shadow-2xl overflow-hidden relative text-center">
              <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-emerald-500 to-primary" />
              
              <CardHeader className="pt-10 pb-4">
                <motion.div 
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ type: "spring", stiffness: 200, damping: 20, delay: 0.4 }}
                  className="mx-auto bg-emerald-500/10 p-4 rounded-full mb-6 relative"
                >
                  <div className="absolute inset-0 rounded-full bg-emerald-500/20 animate-ping opacity-20" />
                  <CheckCircle2 className="h-10 w-10 text-emerald-500" />
                </motion.div>
                <CardTitle className="text-2xl font-medium tracking-tight">Registration Complete</CardTitle>
                <CardDescription className="text-base text-muted-foreground mt-2">
                  Your details have been securely saved. Keep this PIN safe; you will need it to enter the exam portal.
                </CardDescription>
              </CardHeader>
              
              <CardContent className="pb-8">
                <div className="bg-input/40 border border-border/50 rounded-2xl p-6 mt-4 backdrop-blur-sm">
                  <p className="text-xs uppercase tracking-widest text-muted-foreground font-semibold mb-3">Your Access PIN</p>
                  <div className="flex items-center justify-center space-x-4 flex-wrap">
                    <Tooltip>
                      <TooltipTrigger
                        onClick={copyPin}
                        className="group flex flex-row items-center gap-3 flex-wrap justify-center min-w-0 active:scale-95 transition-all outline-none cursor-pointer"
                      >
                        {/* Fixed text-5xl + tracking-[0.5em] measured at ~367px for 6 mono digits +
                            copy icon -- exceeds the ~260-320px available inside this card on common
                            mobile widths (390px iPhones, 360px budget Android, 320px SE-class), and the
                            Card's overflow-hidden clips it rather than scrolling. Scaling down + wrapping
                            below sm: keeps the PIN fully visible (not just copyable) on every device
                            class candidates actually register from. */}
                        <div className="text-3xl sm:text-5xl tracking-[0.3em] sm:tracking-[0.5em] font-mono font-medium text-foreground mix-blend-plus-lighter shadow-sm">
                          {successPin}
                        </div>
                        <div className={`p-2 rounded-full transition-colors ${hasCopied ? 'bg-emerald-500/20 text-emerald-500 border border-emerald-500/30' : 'bg-primary/10 text-primary border border-primary/20 group-hover:bg-primary/20'}`}>
                          {hasCopied ? <CheckCircle2 className="h-5 w-5" /> : <Copy className="h-5 w-5" />}
                        </div>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="text-xs">
                        {hasCopied ? "Copied to clipboard" : "Click to copy"}
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </div>
              </CardContent>
              
              <CardFooter className="pb-10 pt-4 flex flex-col gap-4">
                <Link href="/exam" className="w-full relative group">
                  <div className="absolute inset-0 bg-primary/20 opacity-0 group-hover:opacity-100 blur-xl transition-opacity duration-500" />
                  <Button className="w-full h-14 text-lg bg-primary hover:bg-primary/90 text-primary-foreground relative z-10 transition-transform active:scale-95">
                    Proceed to Exam Portal
                  </Button>
                </Link>
                <button 
                  onClick={() => {
                    setSuccessPin(null);
                    setReviewData(null);
                    form.reset();
                  }}
                  className="text-sm text-muted-foreground hover:text-foreground transition-colors underline-offset-4 hover:underline"
                >
                  Register another candidate
                </button>
              </CardFooter>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
