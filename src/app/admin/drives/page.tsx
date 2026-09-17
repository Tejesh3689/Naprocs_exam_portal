"use client";

import Link from "next/link";
import { useState, useEffect } from "react";
import {
  Plus, Briefcase, Calendar, Clock, ShieldCheck, Trash2, ArrowRight, ExternalLink, Link as LinkIcon, AlertTriangle, CheckCircle2, Settings2, Video, Trophy, RefreshCw, ArrowDownCircle, ArrowUpCircle, Download
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { format } from "date-fns";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export default function DrivesManagement() {
  const [drives, setDrives] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [isPurging, setIsPurging] = useState(false);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [purgeTarget, setPurgeTarget] = useState<string | null>(null);
  const [editingDriveId, setEditingDriveId] = useState<string | null>(null);

  // Recalculate Tech Round Eligibility -- re-evaluates already-finalized
  // candidates against the drive's CURRENT passing_cutoff (which may have
  // been edited after the exam). See src/app/api/admin/drives/[id]/
  // recalculate-cutoff/route.ts for the full safety rules (never touches a
  // manually-set stage; raising the cutoff only flags candidates for manual
  // review, never auto-demotes them).
  const [recalcTarget, setRecalcTarget] = useState<{ id: string; title: string } | null>(null);
  const [recalcPreview, setRecalcPreview] = useState<any>(null);
  const [isLoadingRecalcPreview, setIsLoadingRecalcPreview] = useState(false);
  const [isApplyingRecalc, setIsApplyingRecalc] = useState(false);
  const [recalcApplyResult, setRecalcApplyResult] = useState<any>(null);

  // Form State
  const [formData, setFormData] = useState({
    title: "",
    slug: "",
    examDuration: 60,
    passingCutoff: 70,
    proctoringSeverity: "MEDIUM",
    maxCheatWarnings: 3,
    webcamProctoringEnabled: false,
    mcqCount: 15,
    codingCount: 2,
    shuffleQuestions: true,
    shuffleOptions: true,
    regStart: "",
    regEnd: "",
    examStart: "",
    examEnd: ""
  });

  const fetchDrives = async () => {
    setIsLoading(true);
    try {
      const res = await fetch("/api/admin/drives");
      const data = await res.json();
      if (data.success) {
        setDrives(data.drives);
      }
    } catch (err) {
      console.error("Fetch Data Error:", err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchDrives();
  }, []);

  const formatForInput = (dateStr: string) => {
    if (!dateStr) return "";
    const d = new Date(dateStr);
    // Adjust for local timezone to match datetime-local expected format
    const pad = (num: number) => num.toString().padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const handleOpenEdit = (drive: any) => {
    setEditingDriveId(drive._id);
    setFormData({
      title: drive.title,
      slug: drive.slug,
      examDuration: drive.examDuration,
      passingCutoff: drive.passingCutoff,
      proctoringSeverity: drive.proctoringSeverity,
      maxCheatWarnings: drive.maxCheatWarnings,
      webcamProctoringEnabled: drive.webcamProctoringEnabled ?? false,
      mcqCount: drive.mcqCount,
      codingCount: drive.codingCount,
      shuffleQuestions: drive.shuffleQuestions,
      shuffleOptions: drive.shuffleOptions,
      regStart: formatForInput(drive.regStart),
      regEnd: formatForInput(drive.regEnd),
      examStart: formatForInput(drive.examStart),
      examEnd: formatForInput(drive.examEnd),
    });
    setShowCreateDialog(true);
  };

  const handleOpenCreate = () => {
    setEditingDriveId(null);
    setFormData({
      title: "", slug: "", examDuration: 60, passingCutoff: 70,
      proctoringSeverity: "MEDIUM", maxCheatWarnings: 3, webcamProctoringEnabled: false,
      mcqCount: 15, codingCount: 2, shuffleQuestions: true, shuffleOptions: true,
      regStart: "", regEnd: "", examStart: "", examEnd: ""
    });
    setShowCreateDialog(true);
  };

  const handleSaveDrive = async (e: React.FormEvent) => {
    e.preventDefault();

    // Basic Validation: End must be after Start
    if (new Date(formData.regEnd) <= new Date(formData.regStart)) {
      alert("Registration Deadline must be after Registration Opening.");
      return;
    }
    if (new Date(formData.examEnd) <= new Date(formData.examStart)) {
      alert("Exam Close Window must be after Exam Start Window.");
      return;
    }

    setIsCreating(true);
    try {
      const url = editingDriveId ? `/api/admin/drives/${editingDriveId}` : "/api/admin/drives";
      const method = editingDriveId ? "PATCH" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...formData,
          regStart: new Date(formData.regStart).toISOString(),
          regEnd: new Date(formData.regEnd).toISOString(),
          examStart: new Date(formData.examStart).toISOString(),
          examEnd: new Date(formData.examEnd).toISOString()
        })
      });

      if (res.ok) {
        setShowCreateDialog(false);
        fetchDrives();
      }
    } catch (err) {
      console.error("Save Fault:", err);
    } finally {
      setIsCreating(false);
    }
  };

  const handlePurge = async (id: string | null) => {
    if (!id) return;
    setIsPurging(true);
    try {
      const res = await fetch(`/api/admin/drives/${id}`, { method: "DELETE" });
      if (res.ok) {
        setPurgeTarget(null);
        fetchDrives();
      }
    } catch (err) {
      console.error("Purge Exception:", err);
    } finally {
      setIsPurging(false);
    }
  };

  const handleOpenRecalculate = async (drive: any) => {
    setRecalcTarget({ id: drive._id, title: drive.title });
    setRecalcPreview(null);
    setRecalcApplyResult(null);
    setIsLoadingRecalcPreview(true);
    try {
      const res = await fetch(`/api/admin/drives/${drive._id}/recalculate-cutoff`);
      const data = await res.json();
      if (data.success) setRecalcPreview(data);
    } catch (err) {
      console.error("Recalculate preview fetch failure:", err);
    } finally {
      setIsLoadingRecalcPreview(false);
    }
  };

  const handleApplyRecalculate = async () => {
    if (!recalcTarget) return;
    setIsApplyingRecalc(true);
    try {
      const res = await fetch(`/api/admin/drives/${recalcTarget.id}/recalculate-cutoff`, { method: "POST" });
      const data = await res.json();
      if (data.success) {
        setRecalcApplyResult(data);
        setRecalcPreview(null); // preview is now stale -- the result view replaces it
      }
    } catch (err) {
      console.error("Recalculate apply failure:", err);
    } finally {
      setIsApplyingRecalc(false);
    }
  };

  const getStatusColor = (regStart: string, regEnd: string) => {
    const now = new Date();
    if (now < new Date(regStart)) return "border-amber-500/50 text-amber-500 bg-amber-500/5";
    if (now > new Date(regEnd)) return "border-destructive/50 text-destructive bg-destructive/5";
    return "border-emerald-500/50 text-emerald-500 bg-emerald-500/5";
  };

  const getStatusText = (regStart: string, regEnd: string) => {
    const now = new Date();
    if (now < new Date(regStart)) return "Pending";
    if (now > new Date(regEnd)) return "Closed";
    return "Accepting Registrations";
  };

  return (
    <div className="flex-1 p-6 md:p-10 max-w-7xl mx-auto w-full space-y-8 animate-in fade-in duration-700 relative z-10">
      
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-6 pb-2">
        <div className="space-y-1">
          <h1 className="text-4xl font-semibold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-foreground to-foreground/50">
            Recruitment Pipelines
          </h1>
          <p className="text-muted-foreground font-medium">
            Manage independent batches, university-specific windows, and proctoring levels.
          </p>
        </div>

        <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
          <Button 
            onClick={handleOpenCreate}
            className="bg-primary hover:bg-primary/90 text-primary-foreground h-12 px-6 rounded-xl shadow-xl shadow-primary/20 transition-all hover:scale-[1.02] active:scale-95"
          >
              <Plus className="h-5 w-5 mr-2" /> Initialize New Flow
          </Button>
          <DialogContent className="max-w-2xl bg-card/95 backdrop-blur-xl border-border/40 max-h-[90vh] overflow-y-auto custom-scrollbar">
            <DialogHeader>
              <DialogTitle className="text-2xl font-bold flex items-center gap-2">
                <Briefcase className="h-6 w-6 text-primary" /> {editingDriveId ? "Update Pipeline" : "Create Recruitment Drive"}
              </DialogTitle>
              <DialogDescription className="text-base">
                Configure scheduling, pooling targets, and anti-cheat thresholds.
              </DialogDescription>
            </DialogHeader>

            <form onSubmit={handleSaveDrive} className="space-y-6 pt-4">
              <div className="grid grid-cols-2 gap-6">
                <div className="space-y-2 col-span-2 md:col-span-1">
                  <Label>Drive Title (Identifier)</Label>
                  <Input 
                    placeholder="e.g. IIT Summer 2024" 
                    value={formData.title} 
                    onChange={e => setFormData({...formData, title: e.target.value})}
                    required
                    className="bg-input/20 h-11"
                  />
                </div>
                <div className="space-y-2 col-span-2 md:col-span-1">
                  <Label>URL Slug (Unique Path)</Label>
                  <Input 
                    placeholder="iit-summer-2024" 
                    value={formData.slug} 
                    onChange={e => setFormData({...formData, slug: e.target.value.toLowerCase().replace(/ /g, "-")})}
                    required
                    className="bg-input/20 h-11 font-mono text-sm"
                  />
                  <p className="text-[10px] text-muted-foreground uppercase tracking-widest font-bold">reg link: /register/[slug]</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-6 p-5 rounded-2xl bg-muted/20 border border-border/40">
                <div className="space-y-2">
                  <Label className="flex items-center gap-2"><Calendar className="h-4 w-4" /> Registration Opening</Label>
                  <Input 
                    type="datetime-local" 
                    value={formData.regStart} 
                    onChange={e => setFormData({...formData, regStart: e.target.value})}
                    required
                    className="bg-input/20 h-10 text-xs"
                  />
                </div>
                <div className="space-y-2">
                  <Label className="flex items-center gap-2"><Calendar className="h-4 w-4" /> Registration Deadline</Label>
                  <Input 
                    type="datetime-local" 
                    value={formData.regEnd} 
                    onChange={e => setFormData({...formData, regEnd: e.target.value})}
                    required
                    className="bg-input/20 h-10 text-xs"
                  />
                </div>
                <div className="space-y-2">
                  <Label className="flex items-center gap-2"><Clock className="h-4 w-4 text-emerald-500" /> Exam Start Window</Label>
                  <Input 
                    type="datetime-local" 
                    value={formData.examStart} 
                    onChange={e => setFormData({...formData, examStart: e.target.value})}
                    required
                    className="bg-input/20 h-10 text-xs"
                  />
                </div>
                <div className="space-y-2">
                  <Label className="flex items-center gap-2"><Clock className="h-4 w-4 text-destructive" /> Exam Close Window</Label>
                  <Input 
                    type="datetime-local" 
                    value={formData.examEnd} 
                    onChange={e => setFormData({...formData, examEnd: e.target.value})}
                    required
                    className="bg-input/20 h-10 text-xs"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="space-y-2">
                    <Label className="flex items-center gap-2 text-primary"><ShieldCheck className="h-4 w-4" /> Proctoring Severity</Label>
                    <Select value={formData.proctoringSeverity} onValueChange={v => setFormData({...formData, proctoringSeverity: v as any})}>
                       <SelectTrigger className="h-11 bg-input/20">
                          <SelectValue />
                       </SelectTrigger>
                       <SelectContent>
                          <SelectItem value="LOW">Low Sensitivity</SelectItem>
                          <SelectItem value="MEDIUM">Moderated</SelectItem>
                          <SelectItem value="HIGH">Strict Auto-Submit</SelectItem>
                       </SelectContent>
                    </Select>
                 </div>
                 <div className="space-y-2">
                    <Label>MCQ Target</Label>
                    <Input 
                      type="number" 
                      value={formData.mcqCount} 
                      onChange={e => setFormData({...formData, mcqCount: parseInt(e.target.value)})}
                      className="bg-input/20 h-11"
                    />
                 </div>
                 <div className="space-y-2">
                    <Label>Coding Target</Label>
                    <Input
                      type="number"
                      value={formData.codingCount}
                      onChange={e => setFormData({...formData, codingCount: parseInt(e.target.value)})}
                      className="bg-input/20 h-11"
                    />
                 </div>
              </div>

              <div className="space-y-2">
                 <Label className="flex items-center gap-2 text-primary"><Trophy className="h-4 w-4" /> Passing Cutoff (%)</Label>
                 <Input
                   type="number"
                   min={0}
                   max={100}
                   value={formData.passingCutoff}
                   onChange={e => setFormData({...formData, passingCutoff: parseInt(e.target.value)})}
                   className="bg-input/20 h-11"
                 />
                 {editingDriveId && (
                   <p className="text-[10px] text-muted-foreground font-medium leading-relaxed">
                     Changing this alone does nothing to existing candidates -- use &quot;Recalculate Tech Round Eligibility&quot; on the pipeline card after saving to actually re-evaluate them against the new value.
                   </p>
                 )}
              </div>

              <div className="flex items-center justify-between p-4 rounded-2xl bg-background/40 border border-border/20">
                 <div className="space-y-1">
                    <p className="text-xs font-bold uppercase tracking-tight">Webcam Proctoring</p>
                    <p className="text-[10px] text-muted-foreground font-medium">Camera &amp; mic consent required before exam start</p>
                 </div>
                 <Switch
                    checked={formData.webcamProctoringEnabled}
                    onCheckedChange={(v) => setFormData({ ...formData, webcamProctoringEnabled: !!v })}
                 />
              </div>

              <DialogFooter className="pt-4 border-t border-border/40">
                <Button variant="outline" type="button" onClick={() => setShowCreateDialog(false)} className="h-11 border-border/50">Cancel</Button>
                <Button type="submit" disabled={isCreating} className="h-11 px-8">
                  {isCreating ? "Saving Changes..." : editingDriveId ? "Update Pipeline" : "Acknowledge & Deploy"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
         <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
           {[1,2,3].map(i => <div key={i} className="h-64 rounded-3xl bg-muted/20 animate-pulse" />)}
         </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <AnimatePresence>
            {drives.map((drive) => (
              <motion.div 
                key={drive._id}
                layout
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="group"
              >
                <Card className="border-border/40 bg-card/40 backdrop-blur-xl shadow-xl hover:shadow-2xl transition-all duration-300 relative overflow-hidden h-full flex flex-col group-hover:border-primary/30">
                  <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-primary/40 via-accent/40 to-primary/40 opacity-0 group-hover:opacity-100 transition-opacity" />
                  
                  <CardHeader className="pb-4">
                    <div className="flex justify-between items-start mb-4">
                       <Badge variant="outline" className={`px-3 py-1 rounded-full font-bold uppercase tracking-tighter text-[9px] ${getStatusColor(drive.regStart, drive.regEnd)}`}>
                         {getStatusText(drive.regStart, drive.regEnd)}
                       </Badge>
                       <div className="flex gap-1">
                         <TooltipProvider>
                           <Tooltip>
                             <TooltipTrigger>
                                <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-primary hover:bg-primary/10" onClick={() => handleOpenEdit(drive)}>
                                   <Settings2 className="h-4 w-4" />
                                </Button>
                             </TooltipTrigger>
                             <TooltipContent side="top" className="text-xs">Configure Pipeline</TooltipContent>
                           </Tooltip>
                         </TooltipProvider>

                         <TooltipProvider>
                           <Tooltip>
                             <TooltipTrigger>
                                <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-primary hover:bg-primary/10" onClick={() => {
                                   const link = `${window.location.origin}/register/${drive.slug}`;
                                   navigator.clipboard.writeText(link);
                                }}>
                                   <LinkIcon className="h-4 w-4" />
                                </Button>
                             </TooltipTrigger>
                             <TooltipContent side="top" className="text-xs">Copy Reg Link</TooltipContent>
                           </Tooltip>
                         </TooltipProvider>

                         <TooltipProvider>
                           <Tooltip>
                             <TooltipTrigger>
                                <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10" onClick={() => setPurgeTarget(drive._id)}>
                                   <Trash2 className="h-4 w-4" />
                                </Button>
                             </TooltipTrigger>
                             <TooltipContent side="top" className="text-xs">Purge Data</TooltipContent>
                           </Tooltip>
                         </TooltipProvider>
                       </div>
                    </div>
                    <CardTitle className="text-2xl font-bold tracking-tight line-clamp-1">{drive.title}</CardTitle>
                    <CardDescription className="font-mono text-[10px] uppercase tracking-widest text-primary/80">Batch Slug: {drive.slug}</CardDescription>
                  </CardHeader>

                  <CardContent className="flex-grow space-y-5">
                    <div className="space-y-4">
                       {/* Registration Window */}
                       <div className="space-y-1.5 bg-muted/20 p-3 rounded-xl border border-border/40">
                          <p className="text-[10px] text-muted-foreground font-bold uppercase tracking-widest flex items-center gap-1.5"><Calendar className="h-3 w-3" /> Registration Window</p>
                          <div className="flex justify-between items-center text-xs">
                             <span className="font-medium">{format(new Date(drive.regStart), "MMM d, HH:mm")}</span>
                             <ArrowRight className="h-3 w-3 text-muted-foreground/50" />
                             <span className="font-medium text-destructive/80">{format(new Date(drive.regEnd), "MMM d, HH:mm")}</span>
                          </div>
                       </div>

                       {/* Exam Window */}
                       <div className="space-y-1.5 bg-primary/5 p-3 rounded-xl border border-primary/20">
                          <p className="text-[10px] text-primary/80 font-bold uppercase tracking-widest flex items-center gap-1.5"><Clock className="h-3 w-3" /> Examination Window</p>
                          <div className="flex justify-between items-center text-xs">
                             <span className="font-medium">{format(new Date(drive.examStart), "MMM d, HH:mm")}</span>
                             <ArrowRight className="h-3 w-3 text-primary/30" />
                             <span className="font-medium text-primary">{format(new Date(drive.examEnd), "MMM d, HH:mm")}</span>
                          </div>
                       </div>
                    </div>

                    <div className="grid grid-cols-3 gap-2 pt-2">
                        <div className="bg-muted/30 p-2.5 rounded-xl border border-border/40 text-center space-y-0.5">
                           <p className="text-[9px] font-bold text-muted-foreground uppercase">MCQs</p>
                           <p className="text-sm font-bold text-primary">{drive.mcqCount}</p>
                        </div>
                        <div className="bg-muted/30 p-2.5 rounded-xl border border-border/40 text-center space-y-0.5">
                           <p className="text-[9px] font-bold text-muted-foreground uppercase">Algorithms</p>
                           <p className="text-sm font-bold text-accent">{drive.codingCount}</p>
                        </div>
                        <div className="bg-muted/30 p-2.5 rounded-xl border border-border/40 text-center space-y-0.5">
                           <p className="text-[9px] font-bold text-muted-foreground uppercase">Severity</p>
                           <p className="text-[10px] font-bold text-foreground flex items-center justify-center gap-1">
                              {drive.proctoringSeverity}
                              {drive.webcamProctoringEnabled && (
                                 <Video className="h-2.5 w-2.5 text-primary" aria-label="Webcam proctoring enabled" />
                              )}
                           </p>
                        </div>
                    </div>

                    <div className="flex items-center justify-between p-3 rounded-xl bg-emerald-500/5 border border-emerald-500/20">
                       <div className="flex items-center gap-2">
                          <Trophy className="h-3.5 w-3.5 text-emerald-500" />
                          <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Passing Cutoff</span>
                          <span className="text-sm font-bold text-emerald-500">{drive.passingCutoff}%</span>
                       </div>
                       <div className="flex gap-1.5">
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 w-7 p-0 border-emerald-500/30 text-emerald-500 hover:bg-emerald-500/10"
                                  onClick={() => window.open(`/api/admin/drives/${drive._id}/tech-round-report`, "_blank")}
                                >
                                  <Download className="h-3 w-3" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent side="top" className="text-xs">Download Tech Round List (PDF)</TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-[10px] uppercase tracking-widest font-bold gap-1.5 border-emerald-500/30 text-emerald-500 hover:bg-emerald-500/10"
                            onClick={() => handleOpenRecalculate(drive)}
                          >
                            <RefreshCw className="h-3 w-3" /> Recalculate
                          </Button>
                       </div>
                    </div>
                  </CardContent>

                  <CardFooter className="pt-2 pb-6 flex gap-2">
                     <Link href={`/admin/questions?driveId=${drive._id}`} className="flex-1">
                        <Button variant="outline" className="w-full h-10 border-border/60 hover:bg-muted/50 gap-2 relative overflow-hidden transition-all group shadow-sm">
                           <Plus className="h-3.5 w-3.5" /> Bank
                           <div className="absolute inset-0 bg-primary/10 translate-x-full group-hover:translate-x-0 transition-transform duration-300" />
                        </Button>
                     </Link>
                     <Link href={`/admin/control-center?driveId=${drive._id}`} className="flex-1">
                        <Button variant="outline" className="w-full h-10 border-border/60 hover:bg-muted/50 gap-2">
                           <Video className="h-3.5 w-3.5" /> Live Monitoring
                        </Button>
                     </Link>
                     <Link href={`/admin/leaderboard?driveId=${drive._id}`} className="flex-1">
                        <Button className="w-full h-10 gap-2 font-semibold shadow-lg shadow-primary/20 bg-primary">
                           Results <ArrowRight className="h-3.5 w-3.5" />
                        </Button>
                     </Link>
                  </CardFooter>
                </Card>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}

      {/* Purge Confirmation Dialog */}
      <Dialog open={!!purgeTarget} onOpenChange={(o) => (!o && setPurgeTarget(null))}>
         <DialogContent className="border-destructive/30 bg-destructive/5 backdrop-blur-2xl sm:max-w-md">
            <DialogHeader className="pt-4 text-center">
               <div className="h-16 w-16 rounded-full bg-destructive/10 border border-destructive/20 flex items-center justify-center mb-6 mx-auto">
                  <AlertTriangle className="h-8 w-8 text-destructive animate-pulse" />
               </div>
               <DialogTitle className="text-2xl font-bold text-destructive tracking-tight">Destructive Operation</DialogTitle>
               <DialogDescription className="text-base text-foreground/80 mt-2">
                  This will PERMANENTLY purge the recruitment flow, all registered candidate profiles, their responses, and the specific question bank associated with it.
                  <br/><br/>
                  <span className="font-bold text-destructive">This action cannot be undone.</span>
               </DialogDescription>
            </DialogHeader>
            <DialogFooter className="sm:justify-center pb-2 pt-6 gap-3 bg-destructive/5 border-destructive/20">
               <Button variant="outline" className="flex-1 min-w-0 h-12 border-border/50" onClick={() => setPurgeTarget(null)}>Cancel</Button>
               <Button variant="destructive" className="flex-1 min-w-0 h-12 font-bold shadow-2xl shadow-destructive/20" onClick={() => handlePurge(purgeTarget as string)} disabled={isPurging}>
                  {isPurging ? "Purging Matrix..." : "Purge Everything"}
               </Button>
            </DialogFooter>
         </DialogContent>
      </Dialog>
      {/* Recalculate Tech Round Eligibility Dialog */}
      <Dialog open={!!recalcTarget} onOpenChange={(o) => { if (!o) { setRecalcTarget(null); setRecalcPreview(null); setRecalcApplyResult(null); } }}>
         <DialogContent className="max-w-lg bg-card/95 backdrop-blur-xl border-border/40 max-h-[85vh] overflow-y-auto custom-scrollbar">
            <DialogHeader>
               <DialogTitle className="text-xl font-bold flex items-center gap-2">
                  <Trophy className="h-5 w-5 text-emerald-500" /> Recalculate Tech Round Eligibility
               </DialogTitle>
               <DialogDescription className="text-sm">
                  {recalcTarget?.title}
               </DialogDescription>
            </DialogHeader>

            {isLoadingRecalcPreview ? (
               <div className="py-10 text-center text-sm text-muted-foreground">Comparing candidates against the current cutoff...</div>
            ) : recalcApplyResult ? (
               <div className="space-y-4 py-2">
                  <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center gap-3">
                     <CheckCircle2 className="h-5 w-5 text-emerald-500 shrink-0" />
                     <p className="text-sm font-medium">{recalcApplyResult.message}</p>
                  </div>
                  {recalcApplyResult.flaggedForReview?.length > 0 && (
                     <div className="space-y-2">
                        <p className="text-xs font-bold uppercase tracking-widest text-amber-500 flex items-center gap-1.5">
                           <ArrowDownCircle className="h-3.5 w-3.5" /> Still needs manual review ({recalcApplyResult.flaggedForReview.length})
                        </p>
                        <p className="text-[11px] text-muted-foreground leading-relaxed">
                           These candidates are in Tech Round but no longer meet the {recalcApplyResult.cutoff}% cutoff. They were left untouched -- decide case-by-case from the Live Monitoring board.
                        </p>
                        <div className="max-h-40 overflow-y-auto space-y-1.5 custom-scrollbar">
                           {recalcApplyResult.flaggedForReview.map((c: any) => (
                              <div key={c._id} className="flex justify-between items-center text-xs p-2 rounded-lg bg-amber-500/5 border border-amber-500/20">
                                 <span className="font-medium">{c.name} <span className="text-muted-foreground font-mono">({c.collegeRollNumber})</span></span>
                                 <span className="font-bold text-amber-500">{c.examScore}%</span>
                              </div>
                           ))}
                        </div>
                     </div>
                  )}
                  <DialogFooter className="pt-2">
                     <Button className="w-full h-10" onClick={() => { setRecalcTarget(null); setRecalcApplyResult(null); }}>Done</Button>
                  </DialogFooter>
               </div>
            ) : recalcPreview ? (
               <div className="space-y-4 py-2">
                  <p className="text-xs text-muted-foreground">
                     Current cutoff: <span className="font-bold text-foreground">{recalcPreview.cutoff}%</span>. Only candidates whose stage was set automatically by this cutoff check are considered -- anyone manually moved by an admin is never touched.
                  </p>

                  <div className="space-y-2">
                     <p className="text-xs font-bold uppercase tracking-widest text-emerald-500 flex items-center gap-1.5">
                        <ArrowUpCircle className="h-3.5 w-3.5" /> Will move to Tech Round ({recalcPreview.newlyQualifying.length})
                     </p>
                     {recalcPreview.newlyQualifying.length === 0 ? (
                        <p className="text-[11px] text-muted-foreground italic">No candidates newly qualify.</p>
                     ) : (
                        <div className="max-h-32 overflow-y-auto space-y-1.5 custom-scrollbar">
                           {recalcPreview.newlyQualifying.map((c: any) => (
                              <div key={c._id} className="flex justify-between items-center text-xs p-2 rounded-lg bg-emerald-500/5 border border-emerald-500/20">
                                 <span className="font-medium">{c.name} <span className="text-muted-foreground font-mono">({c.collegeRollNumber})</span></span>
                                 <span className="font-bold text-emerald-500">{c.examScore}%</span>
                              </div>
                           ))}
                        </div>
                     )}
                  </div>

                  <div className="space-y-2">
                     <p className="text-xs font-bold uppercase tracking-widest text-amber-500 flex items-center gap-1.5">
                        <ArrowDownCircle className="h-3.5 w-3.5" /> No longer meets cutoff -- needs manual review ({recalcPreview.noLongerQualifying.length})
                     </p>
                     {recalcPreview.noLongerQualifying.length === 0 ? (
                        <p className="text-[11px] text-muted-foreground italic">Nobody currently in Tech Round falls below the new cutoff.</p>
                     ) : (
                        <>
                           <p className="text-[11px] text-muted-foreground leading-relaxed">
                              These will stay in Tech Round -- raising the cutoff never auto-removes anyone. Review and move them by hand if needed.
                           </p>
                           <div className="max-h-32 overflow-y-auto space-y-1.5 custom-scrollbar">
                              {recalcPreview.noLongerQualifying.map((c: any) => (
                                 <div key={c._id} className="flex justify-between items-center text-xs p-2 rounded-lg bg-amber-500/5 border border-amber-500/20">
                                    <span className="font-medium">{c.name} <span className="text-muted-foreground font-mono">({c.collegeRollNumber})</span></span>
                                    <span className="font-bold text-amber-500">{c.examScore}%</span>
                                 </div>
                              ))}
                           </div>
                        </>
                     )}
                  </div>

                  <p className="text-[10px] text-muted-foreground italic">
                     {recalcPreview.unaffectedCount} unaffected, {recalcPreview.manualExcludedCount} excluded (manually set by an admin).
                  </p>

                  <DialogFooter className="pt-2 gap-2">
                     <Button variant="outline" className="flex-1 h-10 border-border/50" onClick={() => setRecalcTarget(null)}>Cancel</Button>
                     <Button
                        className="flex-1 h-10 bg-emerald-500 hover:bg-emerald-600 text-white font-semibold"
                        onClick={handleApplyRecalculate}
                        disabled={isApplyingRecalc || recalcPreview.newlyQualifying.length === 0}
                     >
                        {isApplyingRecalc ? "Applying..." : `Apply (${recalcPreview.newlyQualifying.length})`}
                     </Button>
                  </DialogFooter>
               </div>
            ) : (
               <div className="py-10 text-center text-sm text-muted-foreground">Failed to load preview. Close and try again.</div>
            )}
         </DialogContent>
      </Dialog>
    </div>
  );
}

