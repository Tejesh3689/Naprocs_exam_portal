"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { DragDropContext, Droppable, Draggable, DropResult } from "@hello-pangea/dnd";
import { Download, GripVertical, FileText, CheckCircle2, User, Cpu, MessageSquare, Code, Presentation, AlertTriangle, Video, Trash2, Search } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { formatToIST } from "@/lib/time";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PROCTORING_FLAG_BY_EVENT_TYPE } from "@/lib/proctoringFlags";
import { ProctoringLightbox } from "@/components/proctoring/ProctoringLightbox";

// Matches the admin/proctoring overview page's poll cadence.
const ADMIN_POLL_INTERVAL_MS = 30_000;

// Admin Kanban Types
type KanbanColumn = { id: string; dbStage: string; title: string; hasExport?: boolean; exportLabel?: string; };
type Candidate = { 
  _id: string; 
  name: string; 
  email: string;
  phone: string;
  collegeRollNumber: string; 
  examScore: number; 
  stage: string; 
  techNotes?: string; 
  hrNotes?: string;
  resumeUrl?: string;
  scoreLogic?: number;
  scoreArchitecture?: number;
  scoreLinguistic?: number;
  scoreMission?: number;
};

const COLUMNS: KanbanColumn[] = [
  { id: "col-1", dbStage: "EXAM_COMPLETED", title: "Exam Completed" },
  { id: "col-2", dbStage: "TECH_ROUND", title: "Tech Round", hasExport: true, exportLabel: "Tech Shortlist" },
  { id: "col-3", dbStage: "HR_ROUND", title: "HR Round" },
  { id: "col-4", dbStage: "SELECTED", title: "Selected / Offered", hasExport: true, exportLabel: "Final Offers" },
];

function DriveKanbanBoardInner() {
  const searchParams = useSearchParams();
  const [isMounted, setIsMounted] = useState(false);
  const [columns, setColumns] = useState<Record<string, Candidate[]>>({ "col-1": [], "col-2": [], "col-3": [], "col-4": [] });
  const [selectedCandidate, setSelectedCandidate] = useState<Candidate | null>(null);
  const [drives, setDrives] = useState<any[]>([]);
  const [selectedDriveId, setSelectedDriveId] = useState<string>("all");

  // Tech Round resume search + bulk/individual download. Search is purely a
  // visual filter (candidates are hidden, not removed from the array), so
  // drag-and-drop indices into columns['col-2'] stay correct even while a
  // search is active -- see the render below.
  const [techSearchQuery, setTechSearchQuery] = useState("");
  const [isDownloadingResumes, setIsDownloadingResumes] = useState(false);

  // Evaluation States
  const [activeTechNotes, setActiveTechNotes] = useState("");
  const [activeHrNotes, setActiveHrNotes] = useState("");
  const [techLogic, setTechLogic] = useState(60);
  const [techArch, setTechArch] = useState(80);
  const [hrLinguistic, setHrLinguistic] = useState(90);
  const [hrMission, setHrMission] = useState(70);
  const [isSavingRubric, setIsSavingRubric] = useState(false);
  
  // Exam Report Data
  const [examReport, setExamReport] = useState<any[] | null>(null);
  const [sessionInfo, setSessionInfo] = useState<any | null>(null);
  const [isLoadingReport, setIsLoadingReport] = useState(false);

  // Proctoring Data
  const [proctoringEvents, setProctoringEvents] = useState<any[] | null>(null);
  const [isLoadingProctoring, setIsLoadingProctoring] = useState(false);
  const [isPurgingProctoring, setIsPurgingProctoring] = useState(false);
  const [proctoringLightboxIndex, setProctoringLightboxIndex] = useState<number | null>(null);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Populate the "Batch Pipeline" dropdown -- previously never fetched, so
  // it silently rendered nothing but "All Recruitment Batches" no matter how
  // many drives existed.
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/admin/drives');
        const data = await res.json();
        if (data.success) {
          setDrives(data.drives || []);
          // Honor ?driveId= from a link (e.g. Live Monitoring's "Pipeline"
          // button, or Recruitment Drives' card) if it points at a real drive.
          const driveIdParam = searchParams.get('driveId');
          if (driveIdParam && (data.drives || []).some((d: any) => d._id === driveIdParam)) {
            setSelectedDriveId(driveIdParam);
          }
        }
      } catch (e) {
        console.error("Drive list fetch failure", e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-fetch whenever the selected batch changes -- previously fetchCandidates
  // only ran once on mount, so switching the dropdown never actually filtered
  // anything even after the drive list above was wired up.
  useEffect(() => {
    fetchCandidates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDriveId]);

  const fetchCandidates = async () => {
    try {
      const url = selectedDriveId === "all" ? '/api/admin/candidates' : `/api/admin/candidates?driveId=${selectedDriveId}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.success) {
        // Hydrate backend map into visual columns
        const newCols: Record<string, Candidate[]> = { "col-1": [], "col-2": [], "col-3": [], "col-4": [] };
        data.candidates.forEach((c: Candidate) => {
          const matchedCol = COLUMNS.find(col => col.dbStage === c.stage);
          if (matchedCol) newCols[matchedCol.id].push(c);
        });
        setColumns(newCols);
      }
    } catch (e) {
      console.error("Hydration DB Fault", e);
    }
  };

  const generatePDFExport = (columnId: string, stageTitle: string) => {
    const list = columns[columnId];
    if (list.length === 0) return;

    const doc = new jsPDF();
    doc.setFont("helvetica", "bold");
    doc.setFontSize(20);
    doc.text(`Naprocs Official Roster: ${stageTitle}`, 14, 22);
    
    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    doc.text(`Generated exactly at: ${formatToIST(new Date())}`, 14, 30);

    const tableData = list.map(c => [c.name, c.collegeRollNumber, c.email]);

    autoTable(doc, {
      startY: 35,
      head: [['Candidate Syntax', 'Roll Designation', 'Registered Email']],
      body: tableData,
      theme: 'grid',
      headStyles: { fillColor: [46, 204, 113] } // Theme Emerald
    });

    doc.save(`Naprocs_Roster_${stageTitle.replace(/\s+/g, '_')}.pdf`);
  };

  const matchesTechSearch = (c: Candidate) => {
    const q = techSearchQuery.trim().toLowerCase();
    if (!q) return true;
    return (
      c.name?.toLowerCase().includes(q) ||
      c.collegeRollNumber?.toLowerCase().includes(q) ||
      c.email?.toLowerCase().includes(q)
    );
  };

  const techColumnCandidates = columns["col-2"] || [];
  const visibleTechCandidates = techColumnCandidates.filter(matchesTechSearch);

  // Empty search -> everyone in Tech Round (a ZIP). Narrowed to exactly one
  // match -> that single resume, downloaded directly (no zip). Narrowed to a
  // subset of 2+ -> a ZIP of just that subset. The server decides the actual
  // single-vs-zip response shape based on how many candidates actually have a
  // resume on file, but the button label reflects what the admin sees here.
  const handleDownloadTechResumes = async () => {
    if (visibleTechCandidates.length === 0 || isDownloadingResumes) return;
    setIsDownloadingResumes(true);
    try {
      const res = await fetch("/api/admin/candidates/resumes/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateIds: visibleTechCandidates.map((c) => c._id) }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to prepare resume download");
      }

      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") || "";
      const match = disposition.match(/filename="?([^"]+)"?/);
      const filename = match?.[1] || (visibleTechCandidates.length === 1 ? "resume.pdf" : "tech-round-resumes.zip");
      const skipped = Number(res.headers.get("X-Skipped-Count") || "0");

      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);

      if (skipped > 0) {
        alert(`${skipped} candidate(s) had no resume on file (or it failed to download) and were skipped.`);
      }
    } catch (e: any) {
      console.error("Resume download failure:", e);
      alert(e.message || "Failed to download resumes. Please try again.");
    } finally {
      setIsDownloadingResumes(false);
    }
  };

  const onDragEnd = async (result: DropResult) => {
    if (!result.destination) return;
    const { source, destination, draggableId } = result;

    if (source.droppableId === destination.droppableId) {
      // Reordering locally
      const column = [...columns[source.droppableId]];
      const [removed] = column.splice(source.index, 1);
      column.splice(destination.index, 0, removed);
      setColumns({ ...columns, [source.droppableId]: column });
      return;
    }

    // Capture Previous Stage for Rollback fault-tolerance
    const prevColumns = { ...columns };

    // Apply Optimistic Update UI
    const sourceCol = [...columns[source.droppableId]];
    const destCol = [...columns[destination.droppableId]];
    const [removed] = sourceCol.splice(source.index, 1);
    
    // Optimistically patch candidate object stage immediately
    const targetStage = COLUMNS.find(c => c.id === destination.droppableId)?.dbStage || 'EXAM_COMPLETED';
    removed.stage = targetStage;
    
    destCol.splice(destination.index, 0, removed);
    setColumns({ ...columns, [source.droppableId]: sourceCol, [destination.droppableId]: destCol });

    // Background Database Sync
    try {
       const res = await fetch(`/api/admin/candidates/${draggableId}/stage`, {
         method: 'PATCH',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ stage: targetStage })
       });
       if (!res.ok) throw new Error("Synchronization Error");
    } catch (error) {
       console.error("Optimistic rollback triggered:", error);
       setColumns(prevColumns); // Snap exactly back on failure
    }
  };

  const fetchProctoringEvents = async (candidateId: string) => {
    try {
       const res = await fetch(`/api/admin/candidates/${candidateId}/proctoring`);
       const data = await res.json();
       if (data.success) {
          setProctoringEvents(data.events);
       }
    } catch (e) {
      console.error("Proctoring gallery fetch failure", e);
    }
  };

  const handleOpenSheet = async (c: Candidate) => {
    setSelectedCandidate(c);
    setActiveTechNotes(c.techNotes || "");
    setActiveHrNotes(c.hrNotes || "");
    setTechLogic(c.scoreLogic || 60);
    setTechArch(c.scoreArchitecture || 80);
    setHrLinguistic(c.scoreLinguistic || 90);
    setHrMission(c.scoreMission || 70);
    setExamReport(null);
    setSessionInfo(null);
    setProctoringEvents(null);

    // Dynamic fetch of the exam results for the interview transparency
    setIsLoadingReport(true);
    try {
       const res = await fetch(`/api/admin/candidates/${c._id}/exam-report`);
       const data = await res.json();
       if (data.success) {
          setExamReport(data.report);
          setSessionInfo(data.session);
       }
    } catch (e) {
      console.error("Exam Report fetch failure", e);
    } finally {
      setIsLoadingReport(false);
    }

    setIsLoadingProctoring(true);
    await fetchProctoringEvents(c._id);
    setIsLoadingProctoring(false);
  };

  // Live-ish gallery: poll every 30s while the dialog is open, instead of
  // requiring the admin to close and reopen it to see new snapshots. Paused
  // while the lightbox is open, since events sort newest-first and a
  // mid-view refetch would shift indices and jump the viewer.
  useEffect(() => {
    if (!selectedCandidate || proctoringLightboxIndex !== null) return;
    const interval = setInterval(() => fetchProctoringEvents(selectedCandidate._id), ADMIN_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [selectedCandidate, proctoringLightboxIndex]);

  const handlePurgeProctoring = async () => {
    if (!selectedCandidate) return;
    setIsPurgingProctoring(true);
    try {
       const res = await fetch(`/api/admin/candidates/${selectedCandidate._id}/proctoring`, { method: 'DELETE' });
       if (res.ok) setProctoringEvents([]);
    } catch (e) {
      console.error("Proctoring purge failure", e);
    } finally {
      setIsPurgingProctoring(false);
    }
  };

  const getNextStage = (currentStage: string) => {
    switch(currentStage) {
      case 'EXAM_COMPLETED': return 'TECH_ROUND';
      case 'TECH_ROUND': return 'HR_ROUND';
      case 'HR_ROUND': return 'SELECTED';
      default: return currentStage;
    }
  };

  const saveEvaluationMatrix = async () => {
    if (!selectedCandidate) return;
    const targetStage = getNextStage(selectedCandidate.stage);
    
    setIsSavingRubric(true);
    try {
      const res = await fetch(`/api/admin/candidates/${selectedCandidate._id}/evaluation`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          techNotes: activeTechNotes, 
          hrNotes: activeHrNotes,
          scoreLogic: techLogic,
          scoreArchitecture: techArch,
          scoreLinguistic: hrLinguistic,
          scoreMission: hrMission,
          stage: targetStage
        })
      });
      if (res.ok) {
         fetchCandidates(); // Resync columns globally
         setSelectedCandidate(null); // Close sheet
      }
    } catch (e) {
      console.error("Evaluation Sync Failure");
    } finally {
      setIsSavingRubric(false);
    }
  };

  const handleDiscardAndReject = async () => {
    if (!selectedCandidate) return;
    setIsSavingRubric(true);
    try {
      const res = await fetch(`/api/admin/candidates/${selectedCandidate._id}/evaluation`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage: 'REJECTED' })
      });
      if (res.ok) {
        fetchCandidates();
        setSelectedCandidate(null);
      }
    } catch (e) {
      console.error("Rejection Sync Failure");
    } finally {
      setIsSavingRubric(false);
    }
  };

  if (!isMounted) return null;

  return (
    <div className="flex flex-col h-full bg-background overflow-hidden animate-in fade-in duration-500">
      <div className="p-6 md:p-8 shrink-0">
        <h1 className="text-3xl font-medium tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-foreground to-foreground/60 mb-2">
          Live Drive Pipeline
        </h1>
        <p className="text-sm text-muted-foreground">
          Drag and drop candidates mapping their stages. Generates optimistic UI traces evaluating backend DB.
        </p>

        <div className="flex items-center gap-3 bg-card/40 backdrop-blur-md p-4 rounded-xl border border-border/40 w-fit mt-6">
            <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground mr-2">Batch Pipeline:</p>
            <Select
               items={[{ value: "all", label: "All Recruitment Batches" }, ...drives.map(d => ({ value: d._id, label: d.title }))]}
               value={selectedDriveId}
               onValueChange={(val: any) => setSelectedDriveId(val)}
            >
               <SelectTrigger className="w-[280px] h-9 text-xs font-semibold">
                  <SelectValue placeholder="All Recruitment Batches" />
               </SelectTrigger>
               <SelectContent>
                  <SelectItem value="all">All Recruitment Batches</SelectItem>
                  {drives.map(d => (
                     <SelectItem key={d._id} value={d._id}>{d.title}</SelectItem>
                  ))}
               </SelectContent>
            </Select>
        </div>
      </div>

      <div className="flex-1 overflow-x-auto overflow-y-hidden px-6 md:px-8 pb-8">
        <DragDropContext onDragEnd={onDragEnd}>
          <div className="flex h-full gap-6 items-start w-max">
            {COLUMNS.map((col) => (
              <div key={col.id} className="w-[340px] flex flex-col h-full max-h-full">
                {/* Column Header */}
                <div className="mb-4 flex flex-col gap-3">
                  <div className="flex items-center justify-between border-b border-border/50 pb-3">
                    <h3 className="font-semibold text-sm uppercase tracking-widest text-foreground/80 flex items-center gap-2">
                      <div className={`h-2.5 w-2.5 rounded-full ${col.id === 'col-4' ? 'bg-emerald-500' : 'bg-primary'}`} />
                      {col.title}
                    </h3>
                    <Badge variant="secondary" className="bg-muted/50 text-muted-foreground">
                      {columns[col.id].length}
                    </Badge>
                  </div>
                  {col.hasExport && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => generatePDFExport(col.id, col.exportLabel || col.title)}
                      className="w-full border-primary/20 bg-primary/5 text-primary hover:bg-primary/10 transition-colors shrink-0"
                    >
                      <Download className="h-4 w-4 mr-2" /> Export {col.exportLabel} (PDF)
                    </Button>
                  )}

                  {col.dbStage === "TECH_ROUND" && (
                    <div className="space-y-2">
                      <div className="relative">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50" />
                        <input
                          type="text"
                          value={techSearchQuery}
                          onChange={(e) => setTechSearchQuery(e.target.value)}
                          placeholder="Search name, roll no, email..."
                          className="w-full h-8 pl-8 pr-2 text-xs rounded-md border border-border/50 bg-background/50 focus:outline-none focus:ring-1 focus:ring-primary/40"
                        />
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={isDownloadingResumes || visibleTechCandidates.length === 0}
                        onClick={handleDownloadTechResumes}
                        className="w-full border-emerald-500/20 bg-emerald-500/5 text-emerald-600 hover:bg-emerald-500/10 transition-colors shrink-0"
                      >
                        <Download className="h-4 w-4 mr-2" />
                        {isDownloadingResumes
                          ? "Preparing..."
                          : visibleTechCandidates.length === 0
                          ? "No Resumes"
                          : visibleTechCandidates.length === techColumnCandidates.length
                          ? `Download All Resumes (${techColumnCandidates.length})`
                          : visibleTechCandidates.length === 1
                          ? "Download Resume"
                          : `Download Selected (${visibleTechCandidates.length})`}
                      </Button>
                    </div>
                  )}
                </div>

                {/* Droppable Zone */}
                <Droppable droppableId={col.id}>
                  {(provided, snapshot) => (
                    <div
                      {...provided.droppableProps}
                      ref={provided.innerRef}
                      className={`flex-1 overflow-y-auto p-2 rounded-xl transition-colors border ${snapshot.isDraggingOver ? 'bg-primary/5 border-primary/30 border-dashed' : 'bg-card/20 border-border/20'}`}
                    >
                      <AnimatePresence>
                        {columns[col.id].map((candidate, index) => {
                          // Tech Round search is a visual filter only -- a
                          // non-matching card is hidden (not removed from the
                          // array), so its Draggable `index` still matches its
                          // real position in columns['col-2'] and drag/drop
                          // (which splices by index) keeps working correctly
                          // even while a search is active.
                          const hiddenBySearch = col.dbStage === "TECH_ROUND" && !matchesTechSearch(candidate);
                          return (
                          <Draggable key={candidate._id} draggableId={candidate._id} index={index}>
                            {(provided, snapshot) => (
                              <div
                                ref={provided.innerRef}
                                {...provided.draggableProps}
                                {...provided.dragHandleProps}
                                style={{ ...provided.draggableProps.style }}
                                hidden={hiddenBySearch && !snapshot.isDragging}
                                onClick={() => handleOpenSheet(candidate)}
                              >
                                <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="group">
                                  <Card className={`mb-3 cursor-grab active:cursor-grabbing border-border/40 hover:border-primary/40 transition-all ${snapshot.isDragging ? 'shadow-2xl shadow-primary/20 rotate-2 scale-105 border-primary z-50 bg-card' : 'bg-card/60 backdrop-blur-sm hover:shadow-lg'}`}>
                                    <div className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-primary/50 to-transparent rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity" />
                                    <CardContent className="p-4">
                                      <div className="flex justify-between items-start mb-2">
                                        <div className="font-medium text-foreground">{candidate.name}</div>
                                        <GripVertical className="h-4 w-4 text-muted-foreground opacity-30 group-hover:opacity-100 transition-opacity" />
                                      </div>
                                      <div className="flex justify-between items-center text-xs">
                                        <span className="font-mono text-muted-foreground bg-muted/30 px-2 py-0.5 rounded">{candidate.collegeRollNumber}</span>
                                        <div className="flex items-center gap-1.5 font-semibold text-emerald-500 bg-emerald-500/10 px-2 py-0.5 rounded-full">
                                          <CheckCircle2 className="h-3 w-3" /> {candidate.examScore || 0}%
                                        </div>
                                      </div>
                                    </CardContent>
                                  </Card>
                                </motion.div>
                              </div>
                            )}
                          </Draggable>
                          );
                        })}
                      </AnimatePresence>
                      {provided.placeholder}
                    </div>
                  )}
                </Droppable>
              </div>
            ))}
          </div>
        </DragDropContext>
      </div>

      {/* Candidate Evaluation Dashboard: Structural Modal Implementation */}
      <Dialog
        open={!!selectedCandidate}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedCandidate(null);
            setProctoringLightboxIndex(null);
          }
        }}
      >
        <DialogContent className="max-w-[95vw] lg:max-w-[90vw] h-[92vh] p-0 border border-border/40 bg-background shadow-2xl overflow-hidden flex flex-col focus-visible:outline-none">
          {selectedCandidate && (
            <div className="grid grid-cols-1 lg:grid-cols-12 h-full overflow-hidden">
              
              {/* LEFT COLUMN: Profile Snapshot & PDF Sandbox (7/12) */}
              <div className="lg:col-span-7 border-r border-border/40 bg-card/10 flex flex-col h-full overflow-hidden">
                <div className="p-8 pb-4 shrink-0 space-y-6">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-6">
                      <div className="h-20 w-20 bg-primary/10 rounded-2xl border border-primary/20 flex items-center justify-center shadow-inner relative overflow-hidden group">
                        <div className="absolute inset-0 bg-gradient-to-br from-primary/20 via-transparent to-transparent opacity-50" />
                        <User className="h-10 w-10 text-primary relative z-10" />
                      </div>
                      <div className="space-y-1">
                        <DialogTitle className="text-3xl font-bold tracking-tighter bg-clip-text text-transparent bg-gradient-to-br from-foreground to-foreground/70 leading-tight">
                          {selectedCandidate.name}
                        </DialogTitle>
                        <div className="flex items-center gap-3">
                           <Badge variant="outline" className="font-mono text-[10px] border-primary/20 text-primary/80 bg-primary/5 uppercase tracking-tighter">
                             {selectedCandidate.collegeRollNumber}
                           </Badge>
                           <div className="flex items-center gap-1.5 text-emerald-500 font-bold bg-emerald-500/10 px-2.5 py-1 rounded-full text-[10px] uppercase">
                             <CheckCircle2 className="h-3 w-3" /> CBT Score: {selectedCandidate.examScore}%
                           </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Identity Grid */}
                  <div className="grid grid-cols-2 gap-4">
                    <div className="p-4 rounded-xl border border-border/40 bg-background/50 hover:bg-background transition-colors group">
                      <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-bold mb-1 opacity-60">Candidate Mail</p>
                      <p className="text-sm font-medium truncate group-hover:text-primary transition-colors">{selectedCandidate.email}</p>
                    </div>
                    <div className="p-4 rounded-xl border border-border/40 bg-background/50 hover:bg-background transition-colors group">
                      <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-bold mb-1 opacity-60">Direct Outreach</p>
                      <p className="text-sm font-medium group-hover:text-primary transition-colors">{selectedCandidate.phone}</p>
                    </div>
                  </div>
                </div>

                {/* Resume In-Situ View Container */}
                <div className="flex-1 px-8 pb-8 flex flex-col overflow-hidden">
                  <div className="flex items-center justify-between mb-3 shrink-0">
                    <div className="flex items-center gap-2">
                       <FileText className="h-4 w-4 text-muted-foreground/60" />
                       <h4 className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60">Resume Intelligence Matrix</h4>
                    </div>
                    <Button variant="link" size="sm" className="text-xs text-primary/80 hover:text-primary p-0 h-auto" onClick={() => window.open(selectedCandidate.resumeUrl, '_blank')}>
                       View Externally
                    </Button>
                  </div>
                  
                  <div className="flex-1 rounded-2xl border border-border/40 bg-black/50 overflow-hidden relative group">
                    {selectedCandidate.resumeUrl ? (
                      <iframe 
                        src={`${selectedCandidate.resumeUrl}#toolbar=0&navpanes=0&scrollbar=0`}
                        className="w-full h-full border-none grayscale-[0.2] invert-[0.05] brightness-[0.95] group-hover:grayscale-0 transition-opacity duration-1000"
                        title="Candidate Resume"
                      />
                    ) : (
                      <div className="h-full w-full flex flex-col items-center justify-center space-y-4 bg-muted/10">
                         <div className="p-4 rounded-full bg-card border border-border/40">
                            <FileText className="h-8 w-8 text-muted-foreground/50" />
                         </div>
                         <p className="text-muted-foreground/50 text-sm font-medium">No Resume Asset Found</p>
                      </div>
                    )}
                    <div className="absolute inset-0 pointer-events-none ring-1 ring-inset ring-white transition-opacity duration-300 group-hover:opacity-0" />
                  </div>
                </div>
              </div>

              {/* RIGHT COLUMN: Evaluation Data Points (5/12) */}
              <div className="lg:col-span-5 flex flex-col h-full bg-background overflow-hidden relative">
                <div className="p-8 flex-1 flex flex-col overflow-y-auto custom-scrollbar">
                   <Tabs defaultValue="tech" className="w-full h-full flex flex-col">
                      <TabsList className="w-full h-14 bg-muted/20 p-1.5 rounded-xl mb-6 border border-border/20 shrink-0">
                        <TabsTrigger value="tech" className="flex-1 h-full rounded-lg text-[10px] font-bold data-[state=active]:bg-primary data-[state=active]:text-primary-foreground transition-all gap-2 uppercase tracking-tight">
                          <Cpu className="h-4 w-4" /> Technical
                        </TabsTrigger>
                        <TabsTrigger value="hr" className="flex-1 h-full rounded-lg text-[10px] font-bold data-[state=active]:bg-emerald-500 data-[state=active]:text-white transition-all gap-2 uppercase tracking-tight">
                          <Presentation className="h-4 w-4" /> HR Alignment
                        </TabsTrigger>
                        <TabsTrigger value="cbt" className="flex-1 h-full rounded-lg text-[10px] font-bold data-[state=active]:bg-amber-500 data-[state=active]:text-white transition-all gap-2 uppercase tracking-tight">
                          <CheckCircle2 className="h-4 w-4" /> Insights
                        </TabsTrigger>
                        <TabsTrigger value="proctoring" className="flex-1 h-full rounded-lg text-[10px] font-bold data-[state=active]:bg-accent data-[state=active]:text-accent-foreground transition-all gap-2 uppercase tracking-tight">
                          <Video className="h-4 w-4" /> Proctoring
                        </TabsTrigger>
                      </TabsList>
                      
                      <div className="flex-1 overflow-visible">
                        <TabsContent value="cbt" className="space-y-6 mt-0 focus-visible:outline-none focus:outline-none">
                           <div className="space-y-4 p-6 rounded-2xl border border-amber-500/20 bg-amber-500/[0.03]">
                              <div className="flex justify-between items-center mb-2">
                                <h4 className="text-[10px] font-bold uppercase tracking-widest text-amber-500 italic">Exam Analytics</h4>
                                <Badge variant="secondary" className="bg-amber-500/10 text-amber-500 text-[9px] uppercase font-bold">Transparency Log</Badge>
                              </div>

                              {isLoadingReport ? (
                                <div className="h-40 flex items-center justify-center animate-pulse text-amber-500/50 text-xs font-mono">
                                   Retrieving encrypted session telemetry...
                                </div>
                              ) : examReport ? (
                                <>
                                  <div className="grid grid-cols-2 gap-4 pb-4 border-b border-amber-500/10">
                                     <div className="space-y-1">
                                        <p className="text-[10px] text-muted-foreground uppercase tracking-widest font-bold">Session Duration</p>
                                        <p className="text-sm font-mono">{Math.floor(sessionInfo?.durationSeconds / 60)}m {sessionInfo?.durationSeconds % 60}s</p>
                                     </div>
                                     <div className="space-y-1">
                                        <p className="text-[10px] text-muted-foreground uppercase tracking-widest font-bold">Success Rate</p>
                                        <p className="text-sm font-mono text-emerald-500">{examReport.filter(r => r.isCorrect).length}/{examReport.length} PASSED</p>
                                     </div>
                                  </div>

                                  <div className="space-y-4 pt-4 max-h-[460px] overflow-y-auto pr-2 custom-scrollbar">
                                     {examReport.map((r, i) => (
                                       <div key={r._id} className={`p-4 rounded-xl border ${r.isCorrect ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-destructive/20 bg-destructive/5'}`}>
                                          <div className="flex justify-between items-start mb-2">
                                             <div className="text-[10px] font-mono text-muted-foreground">#{(i+1).toString().padStart(2, '0')}</div>
                                             {r.isCorrect ? (
                                                <div className="text-[9px] font-bold text-emerald-500 uppercase flex items-center gap-1"><CheckCircle2 className="h-2 w-2"/> PASS</div>
                                             ) : (
                                                <div className="text-[9px] font-bold text-destructive uppercase flex items-center gap-1"><AlertTriangle className="h-2 w-2"/> FAIL</div>
                                             )}
                                          </div>
                                          <h5 className="text-sm font-semibold mb-3 leading-tight">{r.title}</h5>
                                          
                                          {r.type === 'MCQ' ? (
                                             <div className="space-y-2">
                                                <div className="p-2 rounded bg-background/40 border border-border/20 text-xs flex items-center justify-between">
                                                   <span className="text-muted-foreground">Pick:</span>
                                                   <span className={r.isCorrect ? 'text-emerald-500 font-bold' : 'text-destructive font-bold'}>{r.candidateAnswer}</span>
                                                </div>
                                                {!r.isCorrect && (
                                                   <div className="p-2 rounded bg-emerald-500/10 border border-emerald-500/30 text-xs flex items-center justify-between">
                                                      <span className="text-emerald-500/60 uppercase font-bold text-[9px]">Key:</span>
                                                      <span className="text-emerald-500 font-bold">{r.correctAnswer}</span>
                                                   </div>
                                                )}
                                             </div>
                                          ) : (
                                             <div className="space-y-2">
                                              <div className="space-y-4">
                                                 <div className="relative group">
                                                    <div className="absolute top-3 right-3 text-[8px] font-bold text-muted-foreground uppercase opacity-50">Source Implementation</div>
                                                    <pre className="p-5 rounded-2xl bg-black/60 border border-border/40 text-[12px] font-mono text-emerald-500/90 overflow-x-auto max-h-[400px] custom-scrollbar italic leading-relaxed">
                                                       {r.candidateAnswer}
                                                    </pre>
                                                 </div>
                                                 <div className="flex justify-between items-center bg-card/40 border border-border/20 p-4 rounded-xl shadow-inner">
                                                    <div className="space-y-1">
                                                       <span className="text-[10px] text-muted-foreground uppercase tracking-widest font-bold">Verification Protocol Outcomes</span>
                                                       <p className="text-sm font-bold text-emerald-500">{r.codingMetadata.testsPassed} / {r.codingMetadata.totalTests} Logic Guards Satisfied</p>
                                                    </div>
                                                    <div className="h-12 w-12 rounded-full border-4 border-emerald-500/20 border-t-emerald-500 flex items-center justify-center text-xs font-bold text-emerald-500">
                                                       {Math.round((r.codingMetadata.testsPassed / r.codingMetadata.totalTests) * 100)}%
                                                    </div>
                                                 </div>
                                              </div>
                                             </div>
                                          )}
                                       </div>
                                     ))}
                                  </div>
                                </>
                              ) : (
                                <div className="p-8 text-center text-muted-foreground text-xs italic">
                                   No session telemetry available for this candidate stage.
                                </div>
                              )}
                           </div>
                        </TabsContent>

                        <TabsContent value="tech" className="space-y-6 mt-0 focus-visible:outline-none focus:outline-none">
                          <div className="space-y-4 p-6 rounded-2xl border border-primary/20 bg-primary/[0.03]">
                             <div className="flex justify-between items-center">
                                <h4 className="text-[10px] font-bold uppercase tracking-widest text-primary italic">Technical Rubrics</h4>
                                <Badge variant="secondary" className="bg-primary/10 text-primary text-[9px] uppercase font-bold tracking-tighter">Live Session</Badge>
                             </div>
                             
                             <div className="space-y-8 py-4 px-2">
                                <div className="space-y-4">
                                   <div className="flex justify-between text-[10px] font-bold uppercase tracking-widest">
                                      <span className="text-muted-foreground">Logic & Problem Solving</span>
                                      <span className="text-primary font-mono antialiased">{(techLogic / 10).toFixed(1)} / 10</span>
                                   </div>
                                   <Slider value={[techLogic]} onValueChange={(val) => setTechLogic(val[0])} max={100} step={5} className="py-2" />
                                </div>
                                <div className="space-y-4">
                                   <div className="flex justify-between text-[10px] font-bold uppercase tracking-widest">
                                      <span className="text-muted-foreground">Architectural Acumen</span>
                                      <span className="text-primary font-mono antialiased">{(techArch / 10).toFixed(1)} / 10</span>
                                   </div>
                                   <Slider value={[techArch]} onValueChange={(val) => setTechArch(val[0])} max={100} step={5} className="py-2" />
                                </div>
                             </div>

                             <div className="space-y-3 pt-2">
                                <div className="flex items-center gap-2 mb-1">
                                  <MessageSquare className="h-3 w-3 text-primary animate-pulse" />
                                  <h4 className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Interviewer Transcript</h4>
                                </div>
                                <Textarea 
                                  value={activeTechNotes}
                                  onChange={(e) => setActiveTechNotes(e.target.value)}
                                  placeholder="Document system design thoughts, code quality, and engineering maturity..." 
                                  className="min-h-[220px] lg:min-h-[280px] resize-none bg-background/50 border-border/40 focus-visible:ring-primary/50 text-base leading-relaxed p-5 rounded-2xl shadow-inner italic placeholder:opacity-50"
                                />
                             </div>
                          </div>
                        </TabsContent>

                        <TabsContent value="hr" className="space-y-6 mt-0 focus-visible:outline-none focus:outline-none">
                          <div className="space-y-4 p-6 rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.03]">
                            <div className="flex justify-between items-center">
                                <h4 className="text-[10px] font-bold uppercase tracking-widest text-emerald-500 italic">HR Alignment</h4>
                                <Badge variant="secondary" className="bg-emerald-500/10 text-emerald-500 text-[9px] uppercase font-bold tracking-tighter">Cultural Fit</Badge>
                             </div>

                             <div className="space-y-8 py-4 px-2">
                                <div className="space-y-4">
                                   <div className="flex justify-between text-[10px] font-bold uppercase tracking-widest">
                                      <span className="text-muted-foreground">Linguistic Stability</span>
                                      <span className="text-emerald-500 font-mono antialiased">{(hrLinguistic / 10).toFixed(1)} / 10</span>
                                   </div>
                                   <Slider value={[hrLinguistic]} onValueChange={(val) => setHrLinguistic(val[0])} max={100} step={5} className="py-2" />
                                </div>
                                <div className="space-y-4">
                                   <div className="flex justify-between text-[10px] font-bold uppercase tracking-widest">
                                      <span className="text-muted-foreground">Mission Resonance</span>
                                      <span className="text-emerald-500 font-mono antialiased">{(hrMission / 10).toFixed(1)} / 10</span>
                                   </div>
                                   <Slider value={[hrMission]} onValueChange={(val) => setHrMission(val[0])} max={100} step={5} className="py-2" />
                                </div>
                             </div>

                            <div className="space-y-3 pt-2">
                              <h4 className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-1">Behavioral Transcript</h4>
                              <Textarea 
                                value={activeHrNotes}
                                onChange={(e) => setActiveHrNotes(e.target.value)}
                                placeholder="Assess long-term potential, grit, and cultural stability indicators..." 
                                className="min-h-[220px] lg:min-h-[280px] resize-none bg-background/50 border-border/40 text-base leading-relaxed p-5 rounded-2xl shadow-inner focus-visible:ring-emerald-500/50 italic placeholder:opacity-50"
                              />
                            </div>
                          </div>
                        </TabsContent>

                        <TabsContent value="proctoring" className="space-y-6 mt-0 focus-visible:outline-none focus:outline-none">
                           <div className="space-y-4 p-6 rounded-2xl border border-accent/20 bg-accent/[0.03]">
                              <div className="flex justify-between items-center mb-2">
                                <h4 className="text-[10px] font-bold uppercase tracking-widest text-accent italic">Webcam &amp; Mic Proctoring</h4>
                                <Badge variant="secondary" className="bg-accent/10 text-accent text-[9px] uppercase font-bold">Evidence Log</Badge>
                              </div>

                              {isLoadingProctoring ? (
                                <div className="h-40 flex items-center justify-center animate-pulse text-accent/50 text-xs font-mono">
                                   Retrieving proctoring snapshots...
                                </div>
                              ) : proctoringEvents && proctoringEvents.length > 0 ? (
                                <>
                                  <div className="flex items-center justify-between pb-4 border-b border-accent/10">
                                     <p className="text-xs text-muted-foreground">
                                        <span className="font-bold text-foreground">{proctoringEvents.length}</span> snapshots ·{" "}
                                        <span className="font-bold text-destructive">{proctoringEvents.filter(e => e.eventType !== 'SNAPSHOT').length}</span> flags
                                     </p>
                                     <Button
                                       variant="destructive"
                                       size="sm"
                                       disabled={isPurgingProctoring}
                                       onClick={handlePurgeProctoring}
                                       className="h-8 text-[10px] font-bold uppercase tracking-widest gap-1.5"
                                     >
                                       <Trash2 className="h-3 w-3" /> {isPurgingProctoring ? "Purging..." : "Purge Snapshots"}
                                     </Button>
                                  </div>

                                  <div className="grid grid-cols-3 gap-3 max-h-[460px] overflow-y-auto pr-2 custom-scrollbar">
                                     {proctoringEvents.map((ev) => {
                                        const flag = PROCTORING_FLAG_BY_EVENT_TYPE[ev.eventType];
                                        const isFlag = !!flag;
                                        const Icon = flag?.icon || Video;
                                        return (
                                          <button
                                            key={ev._id}
                                            type="button"
                                            onClick={() => setProctoringLightboxIndex(proctoringEvents.indexOf(ev))}
                                            className={`relative aspect-[4/3] rounded-lg overflow-hidden border-2 bg-black/40 cursor-zoom-in transition-transform hover:scale-[1.03] ${isFlag ? 'border-destructive' : 'border-border/30'}`}
                                          >
                                             {ev.snapshotUrl ? (
                                               // eslint-disable-next-line @next/next/no-img-element
                                               <img src={ev.snapshotUrl} alt={flag?.label || "Snapshot"} className="w-full h-full object-cover" />
                                             ) : (
                                               <div className="w-full h-full flex items-center justify-center text-muted-foreground/40">
                                                  <Video className="h-6 w-6" />
                                               </div>
                                             )}
                                             <span className={`absolute top-1 left-1 flex items-center gap-1 text-[8px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-black/60 ${isFlag ? 'text-destructive' : 'text-foreground/80'}`}>
                                                <Icon className="h-2.5 w-2.5" /> {flag?.label || "Snapshot"}
                                             </span>
                                             <span className="absolute bottom-1 right-1 text-[8px] font-mono text-foreground/70 bg-black/50 px-1 rounded">
                                                {new Date(ev.createdAt).toLocaleTimeString()}
                                             </span>
                                          </button>
                                        );
                                     })}
                                  </div>
                                </>
                              ) : (
                                <div className="p-8 text-center text-muted-foreground text-xs italic">
                                   No webcam proctoring data for this candidate -- either the drive doesn&apos;t have webcam proctoring enabled, or the session hasn&apos;t produced any snapshots yet.
                                </div>
                              )}
                           </div>
                        </TabsContent>
                      </div>
                   </Tabs>
                </div>

                {/* Secure Evaluation Pipeline Actions */}
                <div className="p-8 border-t border-border/40 flex gap-4 bg-muted/10 shrink-0">
                  <Button 
                    variant="outline" 
                    disabled={isSavingRubric}
                    className="flex-1 h-14 rounded-2xl text-[10px] font-bold border-border/60 hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30 transition-all uppercase tracking-tight" 
                    onClick={handleDiscardAndReject}
                  >
                    {isSavingRubric ? "Syncing..." : "Discard & Mark Rejected"}
                  </Button>
                  <Button 
                    onClick={saveEvaluationMatrix}
                    disabled={isSavingRubric}
                    className="flex-1 h-14 rounded-2xl text-[10px] font-bold bg-primary hover:bg-primary/90 text-primary-foreground shadow-2xl shadow-primary/30 transition-all active:scale-[0.98] uppercase tracking-tight"
                  >
                    {isSavingRubric ? "Syncing Logic..." : `COMMIT & MOVE TO ${getNextStage(selectedCandidate.stage).replace('_', ' ')}`}
                  </Button>
                </div>
              </div>

            </div>
          )}
        </DialogContent>
      </Dialog>

      {proctoringLightboxIndex !== null && proctoringEvents && (
        <ProctoringLightbox
          events={proctoringEvents}
          startIndex={proctoringLightboxIndex}
          onClose={() => setProctoringLightboxIndex(null)}
        />
      )}
    </div>
  );
}

export default function DriveKanbanBoard() {
  return (
    <Suspense fallback={null}>
      <DriveKanbanBoardInner />
    </Suspense>
  );
}
