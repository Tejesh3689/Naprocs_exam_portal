"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  Activity, AlertTriangle, Search, RefreshCw,
  RotateCcw, Trash2, Loader2, UserCheck, Video, Camera, ShieldAlert, ArrowRight, Download
} from "lucide-react";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ConfirmActionDialog } from "@/components/admin/ConfirmActionDialog";
import { PROCTORING_FLAG_TYPES as FLAG_TYPES, PROCTORING_FLAG_BY_EVENT_TYPE as FLAG_BY_EVENT_TYPE } from "@/lib/proctoringFlags";
import { ProctoringLightbox } from "@/components/proctoring/ProctoringLightbox";
import { formatToIST } from "@/lib/time";

// Unifies the old "Live Control Center" (activity/stage/cheat-warnings,
// every drive mixed together, no in-progress candidates) and "Proctoring
// Overview" (webcam flags/snapshots, one drive at a time, also no
// in-progress distinction) into one page: pick a batch, see who's currently
// writing vs completed, and act on either (re-attempt, delete, purge,
// gallery) from one place.
const ADMIN_POLL_INTERVAL_MS = 15_000;
const ACTIVE_WINDOW_MS = 120_000;

type WritingStatus = "WRITING" | "COMPLETED" | "NOT_STARTED";
type FilterTab = "WRITING" | "COMPLETED" | "NOT_STARTED" | "ALL";

function LiveMonitoringPage() {
  const searchParams = useSearchParams();

  const [drives, setDrives] = useState<any[]>([]);
  const [selectedDriveId, setSelectedDriveId] = useState<string>("");
  const [roster, setRoster] = useState<any[]>([]);
  const [isLoadingRoster, setIsLoadingRoster] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterTab, setFilterTab] = useState<FilterTab>("ALL");

  const [galleryCandidate, setGalleryCandidate] = useState<any | null>(null);
  const [galleryEvents, setGalleryEvents] = useState<any[] | null>(null);
  const [isLoadingGallery, setIsLoadingGallery] = useState(false);
  const [isPurging, setIsPurging] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const [reattemptTarget, setReattemptTarget] = useState<any | null>(null);
  const [reattemptReason, setReattemptReason] = useState("");
  const [reattemptBy, setReattemptBy] = useState("");
  const [isReattempting, setIsReattempting] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<any | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const [isExportingRoster, setIsExportingRoster] = useState(false);

  // Load the drive list once, preferring ?driveId= from the URL (e.g. a
  // link from the Recruitment Drives card) over the first drive found.
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/admin/drives");
        const data = await res.json();
        if (data.success && data.drives?.length > 0) {
          setDrives(data.drives);
          const driveIdParam = searchParams.get("driveId");
          const fromUrl = driveIdParam && data.drives.find((d: any) => d._id === driveIdParam);
          setSelectedDriveId(fromUrl ? driveIdParam : data.drives[0]._id);
        }
      } catch (e) {
        console.error("Drive list fetch failure", e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchRoster = (driveId: string, showLoading: boolean) => {
    if (showLoading) setIsLoadingRoster(true);
    fetch(`/api/admin/drives/${driveId}/live-monitor`)
      .then((res) => res.json())
      .then((data) => {
        if (data.success) setRoster(data.candidates || []);
      })
      .catch((e) => console.error("Live monitor fetch failure", e))
      .finally(() => {
        setIsLoadingRoster(false);
        setIsSyncing(false);
      });
  };

  useEffect(() => {
    if (!selectedDriveId) return;
    fetchRoster(selectedDriveId, true);
    const interval = setInterval(() => fetchRoster(selectedDriveId, false), ADMIN_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [selectedDriveId]);

  const refetchRoster = () => {
    if (!selectedDriveId) return;
    setIsSyncing(true);
    fetchRoster(selectedDriveId, false);
  };

  const fetchGalleryEvents = async (candidateId: string) => {
    try {
      const res = await fetch(`/api/admin/candidates/${candidateId}/proctoring`);
      const data = await res.json();
      if (data.success) setGalleryEvents(data.events);
    } catch (e) {
      console.error("Gallery fetch failure", e);
    }
  };

  const openGallery = async (candidate: any) => {
    setGalleryCandidate(candidate);
    setGalleryEvents(null);
    setIsLoadingGallery(true);
    await fetchGalleryEvents(candidate._id);
    setIsLoadingGallery(false);
  };

  useEffect(() => {
    if (!galleryCandidate || lightboxIndex !== null) return;
    const interval = setInterval(() => fetchGalleryEvents(galleryCandidate._id), ADMIN_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [galleryCandidate, lightboxIndex]);

  const purgeGallery = async () => {
    if (!galleryCandidate) return;
    setIsPurging(true);
    try {
      const res = await fetch(`/api/admin/candidates/${galleryCandidate._id}/proctoring`, { method: "DELETE" });
      if (res.ok) {
        setGalleryEvents([]);
        setRoster((prev) =>
          prev.map((c) =>
            c._id === galleryCandidate._id
              ? { ...c, snapshotCount: 0, noFace: 0, multipleFaces: 0, lookingAway: 0, highNoise: 0 }
              : c
          )
        );
      }
    } catch (e) {
      console.error("Purge failure", e);
    } finally {
      setIsPurging(false);
    }
  };

  const openReattempt = (candidate: any) => {
    setReattemptTarget(candidate);
    setReattemptReason("");
    setReattemptBy("");
  };

  const confirmReattempt = async () => {
    if (!reattemptTarget) return;
    setIsReattempting(true);
    try {
      const res = await fetch(`/api/admin/candidates/${reattemptTarget._id}/reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reattemptReason || undefined, resetBy: reattemptBy || undefined }),
      });
      if (res.ok) {
        setReattemptTarget(null);
        refetchRoster();
      }
    } catch (e) {
      console.error("Re-attempt failure", e);
    } finally {
      setIsReattempting(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      const res = await fetch(`/api/admin/candidates/${deleteTarget._id}`, { method: "DELETE" });
      if (res.ok) {
        setDeleteTarget(null);
        setRoster((prev) => prev.filter((c) => c._id !== deleteTarget._id));
      }
    } catch (e) {
      console.error("Delete failure", e);
    } finally {
      setIsDeleting(false);
    }
  };

  const selectedDrive = drives.find((d) => d._id === selectedDriveId);

  const writingCount = roster.filter((c) => c.writingStatus === "WRITING").length;
  const completedCount = roster.filter((c) => c.writingStatus === "COMPLETED").length;
  const notStartedCount = roster.filter((c) => c.writingStatus === "NOT_STARTED").length;
  const anomaliesCount = roster.reduce((acc, c) => acc + (c.cheatWarnings || 0), 0);
  const flagsCount = roster.reduce((acc, c) => acc + (c.noFace || 0) + (c.multipleFaces || 0) + (c.lookingAway || 0) + (c.highNoise || 0), 0);

  // Exports whatever the admin is currently looking at -- e.g. switch to the
  // "Registered / Not Started" tab to get exactly the list colleges ask for
  // (who signed up on our link but hasn't sat the exam yet), or "All" for
  // the full roster. Reuses the roster already fetched for this page -- no
  // extra request.
  const exportRosterPDF = () => {
    if (filteredRoster.length === 0 || isExportingRoster) return;
    setIsExportingRoster(true);
    try {
      const tabLabel = filterTab === "NOT_STARTED" ? "Registered (Not Yet Started)"
        : filterTab === "WRITING" ? "Writing Now"
        : filterTab === "COMPLETED" ? "Completed"
        : "All Candidates";

      const doc = new jsPDF();
      doc.setFont("helvetica", "bold");
      doc.setFontSize(18);
      doc.text(`${selectedDrive?.title || "Drive"} -- ${tabLabel}`, 14, 20);

      doc.setFontSize(10);
      doc.setFont("helvetica", "normal");
      if (selectedDrive?.slug) doc.text(`Registration link: /register/${selectedDrive.slug}`, 14, 28);
      doc.text(`Generated: ${formatToIST(new Date())}   |   Total: ${filteredRoster.length}`, 14, 34);

      const tableData = filteredRoster.map((c, i) => [
        String(i + 1),
        c.name,
        c.email,
        c.collegeRollNumber,
        c.writingStatus === "NOT_STARTED" ? "Registered (Pending)" : c.writingStatus === "WRITING" ? "Writing Now" : "Completed",
      ]);

      autoTable(doc, {
        startY: 40,
        head: [['#', 'Name', 'Email', 'Roll No.', 'Status']],
        body: tableData,
        theme: 'grid',
        headStyles: { fillColor: [46, 204, 113] },
        styles: { fontSize: 9 },
      });

      doc.save(`${(selectedDrive?.slug || "roster")}_${filterTab.toLowerCase()}.pdf`);
    } finally {
      setIsExportingRoster(false);
    }
  };

  const filteredRoster = roster
    .filter((c) => filterTab === "ALL" || c.writingStatus === filterTab)
    .filter((c) => {
      const q = searchQuery.toLowerCase();
      return !q || c.name?.toLowerCase().includes(q) || c.collegeRollNumber?.toLowerCase().includes(q) || c.email?.toLowerCase().includes(q);
    })
    .sort((a, b) => {
      // Writing-now candidates float to the top, then by most recently active.
      if (a.writingStatus === "WRITING" && b.writingStatus !== "WRITING") return -1;
      if (a.writingStatus !== "WRITING" && b.writingStatus === "WRITING") return 1;
      return 0;
    });

  const statusBadge = (status: WritingStatus) => {
    if (status === "WRITING") {
      return (
        <Badge variant="outline" className="text-[9px] uppercase font-bold tracking-tighter bg-emerald-500/5 text-emerald-500 border-emerald-500/20 gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" /> Writing Now
        </Badge>
      );
    }
    if (status === "COMPLETED") {
      return (
        <Badge variant="outline" className="text-[9px] uppercase font-bold tracking-tighter bg-primary/5 text-primary border-primary/20">
          Completed
        </Badge>
      );
    }
    return (
      <Badge variant="outline" className="text-[9px] uppercase font-bold tracking-tighter bg-muted/50 text-muted-foreground border-border/40">
        Not Started
      </Badge>
    );
  };

  if (isLoadingRoster && roster.length === 0) return (
    <div className="flex-1 flex items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-4">
        <Loader2 className="h-10 w-10 text-primary animate-spin" />
        <p className="text-sm text-muted-foreground animate-pulse font-medium">Synchronizing Live Monitoring...</p>
      </div>
    </div>
  );

  return (
    <div className="flex-1 p-6 md:p-10 max-w-7xl mx-auto w-full space-y-8 animate-in fade-in duration-700 relative z-10">

      {/* Header with per-drive (batch) selector */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-6 bg-card/40 backdrop-blur-xl border border-border/40 p-8 rounded-3xl shadow-2xl relative overflow-hidden">
        <div className="absolute top-0 right-0 w-64 h-64 bg-primary/5 rounded-full -translate-y-1/2 translate-x-1/2 blur-3xl" />
        <div className="space-y-3 relative z-10">
          <p className="text-[10px] font-bold uppercase tracking-widest text-primary flex items-center gap-1.5">
            <Camera className="h-3 w-3" /> Live Monitoring
          </p>
          <h1 className="text-3xl font-bold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-foreground to-foreground/60">
            {selectedDrive?.title || "Select a batch"}
          </h1>
          <p className="text-sm text-muted-foreground max-w-md">
            Everyone in this batch -- currently writing, completed, or not yet started -- with activity, integrity flags, and webcam status in one place.
          </p>
        </div>
        <div className="relative z-10 w-full md:w-72">
          <Select
            items={drives.map((d) => ({ value: d._id, label: d.title }))}
            value={selectedDriveId}
            onValueChange={(v) => setSelectedDriveId(v || "")}
          >
            <SelectTrigger className="h-11 bg-background/40 border-border/40 w-full">
              <SelectValue placeholder="Select a batch" />
            </SelectTrigger>
            <SelectContent>
              {drives.map((d) => (
                <SelectItem key={d._id} value={d._id}>
                  {d.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Vitals */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <Card className="border-border/40 bg-card/40 backdrop-blur-xl shadow-xl overflow-hidden group">
          <CardContent className="p-6">
            <div className="flex justify-between items-start mb-4">
              <div className="h-10 w-10 flex items-center justify-center rounded-xl bg-primary/10 border border-primary/20 text-primary group-hover:scale-110 transition-transform">
                <Activity className="h-5 w-5" />
              </div>
              <Badge variant="outline" className="text-[10px] uppercase font-bold tracking-tighter bg-emerald-500/5 border-emerald-500/20 text-emerald-500">Live</Badge>
            </div>
            <div className="space-y-1">
              <h3 className="text-3xl font-bold tracking-tight">{writingCount}</h3>
              <p className="text-xs font-medium text-muted-foreground">Writing Now</p>
            </div>
          </CardContent>
        </Card>
        <Card className="border-border/40 bg-card/40 backdrop-blur-xl shadow-xl overflow-hidden group">
          <CardContent className="p-6">
            <div className="flex justify-between items-start mb-4">
              <div className="h-10 w-10 flex items-center justify-center rounded-xl bg-accent/10 border border-accent/20 text-accent group-hover:scale-110 transition-transform">
                <UserCheck className="h-5 w-5" />
              </div>
            </div>
            <div className="space-y-1">
              <h3 className="text-3xl font-bold tracking-tight">{completedCount}</h3>
              <p className="text-xs font-medium text-muted-foreground">Completed</p>
            </div>
          </CardContent>
        </Card>
        <Card className="border-border/40 bg-card/40 backdrop-blur-xl shadow-xl overflow-hidden group">
          <CardContent className="p-6">
            <div className="flex justify-between items-start mb-4">
              <div className="h-10 w-10 flex items-center justify-center rounded-xl bg-destructive/10 border border-destructive/20 text-destructive group-hover:scale-110 transition-transform">
                <AlertTriangle className="h-5 w-5" />
              </div>
              {anomaliesCount > 0 && <span className="flex h-2 w-2 rounded-full bg-destructive animate-ping" />}
            </div>
            <div className="space-y-1">
              <h3 className="text-3xl font-bold tracking-tight">{anomaliesCount}</h3>
              <p className="text-xs font-medium text-muted-foreground">Integrity Warnings</p>
            </div>
          </CardContent>
        </Card>
        <Card className="border-border/40 bg-card/40 backdrop-blur-xl shadow-xl overflow-hidden group">
          <CardContent className="p-6">
            <div className="flex justify-between items-start mb-4">
              <div className="h-10 w-10 flex items-center justify-center rounded-xl bg-muted border border-border/40 text-muted-foreground group-hover:scale-110 transition-transform">
                <Video className="h-5 w-5" />
              </div>
            </div>
            <div className="space-y-1">
              <h3 className="text-3xl font-bold tracking-tight">{flagsCount}</h3>
              <p className="text-xs font-medium text-muted-foreground">Webcam Flags</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {selectedDrive && !selectedDrive.webcamProctoringEnabled && (
        <div className="p-4 rounded-xl border border-amber-500/20 bg-amber-500/5 text-sm text-amber-500 flex items-center gap-3">
          <ShieldAlert className="h-4 w-4 shrink-0" />
          Webcam proctoring is turned off for this batch -- activity and stage are still live, but no webcam flags/snapshots will appear.
        </div>
      )}

      {/* Roster */}
      <Card className="border-border/40 bg-card/40 backdrop-blur-xl shadow-2xl">
        <CardContent className="p-0">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 p-6 border-b border-border/40">
            <Tabs value={filterTab} onValueChange={(v) => setFilterTab((v as FilterTab) || "ALL")}>
              <TabsList>
                <TabsTrigger value="NOT_STARTED">Registered ({notStartedCount})</TabsTrigger>
                <TabsTrigger value="WRITING">Writing Now ({writingCount})</TabsTrigger>
                <TabsTrigger value="COMPLETED">Completed ({completedCount})</TabsTrigger>
                <TabsTrigger value="ALL">All ({roster.length})</TabsTrigger>
              </TabsList>
            </Tabs>
            <div className="flex items-center gap-3 w-full md:w-auto">
              <div className="relative flex-1 md:w-64">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search Roll No / Name / Email..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9 bg-background/40 border-border/40 h-10 text-xs"
                />
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={filteredRoster.length === 0 || isExportingRoster}
                onClick={exportRosterPDF}
                className="h-10 shrink-0 border-primary/20 bg-primary/5 text-primary hover:bg-primary/10 transition-colors"
              >
                <Download className="h-4 w-4 mr-2" />
                {isExportingRoster ? "Exporting..." : "Export (PDF)"}
              </Button>
              <Button variant="outline" size="icon" onClick={refetchRoster} className="h-10 w-10 shrink-0">
                <RefreshCw className={`h-4 w-4 ${isSyncing ? "animate-spin" : ""}`} />
              </Button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted/30 text-[10px] uppercase font-bold tracking-widest text-muted-foreground">
                <tr>
                  <th className="p-4 px-6 border-b border-border/40">Candidate</th>
                  <th className="p-4 border-b border-border/40">Roll No.</th>
                  <th className="p-4 border-b border-border/40">Status</th>
                  <th className="p-4 border-b border-border/40 text-center">Warnings</th>
                  {FLAG_TYPES.map((f) => (
                    <th key={f.key} className="p-4 border-b border-border/40 text-center">
                      <span className="inline-flex items-center gap-1"><f.icon className="h-3 w-3" /> {f.label}</span>
                    </th>
                  ))}
                  <th className="p-4 px-6 border-b border-border/40 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {filteredRoster.map((c) => {
                  const isActive = c.lastActiveAt && Date.now() - new Date(c.lastActiveAt).getTime() < ACTIVE_WINDOW_MS;
                  return (
                    <tr key={c._id} className="hover:bg-muted/20 transition-colors group">
                      <td className="p-4 px-6">
                        <div className="flex items-center gap-3">
                          <div className={`h-2 w-2 rounded-full ${isActive ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.4)] animate-pulse" : "bg-muted-foreground/30"}`} />
                          <div className="space-y-0.5">
                            <p className="font-semibold text-foreground">{c.name}</p>
                            <p className="text-[10px] text-muted-foreground font-mono">{c.email}</p>
                          </div>
                        </div>
                      </td>
                      <td className="p-4">
                        <span className="font-mono text-xs bg-muted/50 px-2 py-1 rounded border border-border/40">{c.collegeRollNumber}</span>
                      </td>
                      <td className="p-4">{statusBadge(c.writingStatus)}</td>
                      <td className="p-4 text-center">
                        {c.cheatWarnings > 0 ? (
                          <Badge variant="destructive" className="text-[10px] font-bold">{c.cheatWarnings}</Badge>
                        ) : (
                          <span className="text-muted-foreground/40 text-xs">0</span>
                        )}
                      </td>
                      {FLAG_TYPES.map((f) => (
                        <td key={f.key} className="p-4 text-center">
                          {c[f.key] > 0 ? (
                            <Badge variant="destructive" className="text-[10px] font-bold">{c[f.key]}</Badge>
                          ) : (
                            <span className="text-muted-foreground/40 text-xs">0</span>
                          )}
                        </td>
                      ))}
                      <td className="p-4 px-6 text-right">
                        <div className="flex items-center justify-end gap-1.5 flex-wrap">
                          {c.snapshotCount > 0 && (
                            <Button variant="ghost" size="sm" className="h-8 text-[10px] font-bold uppercase tracking-tighter gap-1.5" onClick={() => openGallery(c)}>
                              <Video className="h-3 w-3" /> Gallery
                            </Button>
                          )}
                          {c.writingStatus === "COMPLETED" && (
                            <Link href={`/admin/drive?driveId=${selectedDriveId}`}>
                              <Button variant="ghost" size="sm" className="h-8 text-[10px] font-bold uppercase tracking-tighter gap-1.5">
                                <ArrowRight className="h-3 w-3" /> Pipeline
                              </Button>
                            </Link>
                          )}
                          <Button variant="ghost" size="sm" onClick={() => openReattempt(c)} className="h-8 text-[10px] font-bold uppercase tracking-tighter hover:bg-primary/10 hover:text-primary gap-1.5">
                            <RotateCcw className="h-3 w-3" /> Re-attempt
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(c)} className="h-8 text-[10px] font-bold uppercase tracking-tighter hover:bg-destructive/10 hover:text-destructive gap-1.5">
                            <Trash2 className="h-3 w-3" /> Delete
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {filteredRoster.length === 0 && (
              <div className="p-20 text-center space-y-3">
                <UserCheck className="h-12 w-12 text-muted-foreground mx-auto opacity-20" />
                <p className="text-sm text-muted-foreground italic">No candidates match the current filters.</p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Proctoring gallery dialog */}
      <Dialog open={!!galleryCandidate} onOpenChange={(o) => !o && setGalleryCandidate(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Video className="h-5 w-5 text-accent" /> {galleryCandidate?.name} -- Proctoring Gallery
            </DialogTitle>
          </DialogHeader>

          {isLoadingGallery ? (
            <div className="h-40 flex items-center justify-center gap-3 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" /> Loading snapshots...
            </div>
          ) : galleryEvents && galleryEvents.length > 0 ? (
            <>
              <div className="flex items-center justify-between pb-3 border-b border-border/40">
                <p className="text-xs text-muted-foreground">
                  <span className="font-bold text-foreground">{galleryEvents.length}</span> snapshots ·{" "}
                  <span className="font-bold text-destructive">{galleryEvents.filter((e) => e.eventType !== "SNAPSHOT").length}</span> flags
                </p>
                <Button variant="destructive" size="sm" disabled={isPurging} onClick={purgeGallery} className="h-8 text-[10px] font-bold uppercase tracking-widest gap-1.5">
                  <Trash2 className="h-3 w-3" /> {isPurging ? "Purging..." : "Purge Snapshots"}
                </Button>
              </div>
              <div className="grid grid-cols-4 gap-3 max-h-[400px] overflow-y-auto pr-1 custom-scrollbar">
                {galleryEvents.map((ev) => {
                  const flag = FLAG_BY_EVENT_TYPE[ev.eventType];
                  const isFlag = !!flag;
                  const Icon = flag?.icon || Camera;
                  return (
                    <button
                      key={ev._id}
                      type="button"
                      onClick={() => setLightboxIndex(galleryEvents.indexOf(ev))}
                      className={`relative aspect-[4/3] rounded-lg overflow-hidden border-2 bg-black/40 cursor-zoom-in transition-transform hover:scale-[1.03] ${isFlag ? "border-destructive" : "border-border/30"}`}
                    >
                      {ev.snapshotUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={ev.snapshotUrl} alt={flag?.label || "Snapshot"} className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-muted-foreground/40">
                          <Video className="h-5 w-5" />
                        </div>
                      )}
                      <span className={`absolute bottom-1 left-1 flex items-center gap-1 text-[7px] font-bold uppercase px-1 rounded bg-black/60 ${isFlag ? "text-destructive" : "text-foreground/70"}`}>
                        <Icon className="h-2 w-2" /> {flag?.label || "Snapshot"}
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="p-8 text-center text-muted-foreground text-xs italic">No snapshots recorded for this candidate.</div>
          )}
        </DialogContent>
      </Dialog>

      {lightboxIndex !== null && galleryEvents && (
        <ProctoringLightbox events={galleryEvents} startIndex={lightboxIndex} onClose={() => setLightboxIndex(null)} />
      )}

      {/* Re-attempt dialog */}
      <ConfirmActionDialog
        open={!!reattemptTarget}
        onOpenChange={(o) => !o && setReattemptTarget(null)}
        title={`Re-attempt for ${reattemptTarget?.name || ""}`}
        description="This wipes their current score, session, and integrity flags, and lets them log back in for a fresh attempt. Use this for accidental issues (webcam dropped, connection lost, etc.) -- not as a way to game the exam."
        confirmLabel={isReattempting ? "Resetting..." : "Reset & Allow Re-attempt"}
        isLoading={isReattempting}
        onConfirm={confirmReattempt}
      >
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="reattempt-reason" className="text-xs text-muted-foreground">Reason (optional, kept on their record)</Label>
            <Textarea
              id="reattempt-reason"
              value={reattemptReason}
              onChange={(e) => setReattemptReason(e.target.value)}
              placeholder="e.g. Webcam disconnected mid-exam, candidate reported network drop..."
              className="min-h-20 text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="reattempt-by" className="text-xs text-muted-foreground">Your name (optional)</Label>
            <Input id="reattempt-by" value={reattemptBy} onChange={(e) => setReattemptBy(e.target.value)} placeholder="Admin name" className="text-sm" />
          </div>
        </div>
      </ConfirmActionDialog>

      {/* Delete dialog */}
      <ConfirmActionDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title={`Delete ${deleteTarget?.name || "this candidate"}?`}
        description="This permanently deletes their exam sessions, proctoring snapshots, resume, and candidate record. This cannot be undone."
        confirmLabel={isDeleting ? "Deleting..." : "Delete Permanently"}
        destructive
        isLoading={isDeleting}
        onConfirm={confirmDelete}
      />
    </div>
  );
}

export default function ExamControlCenter() {
  return (
    <Suspense fallback={null}>
      <LiveMonitoringPage />
    </Suspense>
  );
}
