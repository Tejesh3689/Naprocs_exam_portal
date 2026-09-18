"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { KeyRound, Search, Eye, EyeOff, Copy, Check, ShieldAlert } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";

interface PinLookupResult {
  _id: string;
  name: string;
  email: string;
  collegeRollNumber: string;
  accessPin: string;
  stage: string;
  driveTitle: string | null;
}

// This exists for exactly one real-world moment: a candidate on exam day
// says "I forgot my PIN" and an admin needs the answer in seconds, not by
// opening Supabase directly. Deliberately its own page (not folded into an
// existing roster view) -- the whole point is that a PIN should never be
// visible by default anywhere else in this app.
export default function PinLookupPage() {
  const [query, setQuery] = useState("");
  const [drives, setDrives] = useState<any[]>([]);
  const [selectedDriveId, setSelectedDriveId] = useState<string>("all");
  const [results, setResults] = useState<PinLookupResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [revealedIds, setRevealedIds] = useState<Set<string>>(new Set());
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fetch("/api/admin/drives")
      .then((r) => r.json())
      .then((data) => {
        if (data.success) setDrives(data.drives);
      })
      .catch((e) => console.error("Drives fetch failure", e));
  }, []);

  const runSearch = useCallback(async (q: string, driveId: string) => {
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    setIsSearching(true);
    try {
      const params = new URLSearchParams({ query: q.trim() });
      if (driveId !== "all") params.set("driveId", driveId);
      const res = await fetch(`/api/admin/candidates/pin-lookup?${params.toString()}`);
      const data = await res.json();
      if (data.success) setResults(data.candidates);
    } catch (e) {
      console.error("PIN lookup failure", e);
    } finally {
      setIsSearching(false);
    }
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => runSearch(query, selectedDriveId), 350);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, selectedDriveId, runSearch]);

  const toggleReveal = (id: string) => {
    setRevealedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const copyPin = async (id: string, pin: string) => {
    try {
      await navigator.clipboard.writeText(pin);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch (e) {
      console.error("Clipboard write failed", e);
    }
  };

  return (
    <div className="flex-1 p-6 md:p-10 max-w-5xl mx-auto w-full space-y-8 animate-in fade-in duration-700 relative z-10">
      <div className="space-y-1">
        <h1 className="text-4xl font-semibold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-foreground to-foreground/50 flex items-center gap-3">
          <KeyRound className="h-8 w-8 text-primary" /> PIN Lookup
        </h1>
        <p className="text-muted-foreground font-medium">
          Emergency lookup for a candidate who forgot their 6-digit access PIN on exam day.
        </p>
      </div>

      <Card className="border-amber-500/30 bg-amber-500/5">
        <CardContent className="pt-6 flex items-start gap-3">
          <ShieldAlert className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
          <p className="text-sm text-amber-500/90 leading-relaxed">
            This shows a real login credential. Only use it to help a candidate who is actually in front of you
            struggling to log in -- PINs stay hidden by default below, and every lookup is logged server-side.
          </p>
        </CardContent>
      </Card>

      <Card className="border-border/40 bg-card/40 backdrop-blur-xl">
        <CardHeader>
          <CardTitle className="text-lg">Search</CardTitle>
          <CardDescription>By name, email, or college roll number -- at least 2 characters.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col md:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="e.g. 2300031145 or a name"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-9 h-11 bg-input/20"
              autoFocus
            />
          </div>
          <Select value={selectedDriveId} onValueChange={(v: any) => setSelectedDriveId(v)}>
            <SelectTrigger className="h-11 md:w-64 bg-input/20">
              <SelectValue placeholder="All drives" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All drives</SelectItem>
              {drives.map((d) => (
                <SelectItem key={d._id} value={d._id}>{d.title}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <Card className="border-border/40 bg-card/40 backdrop-blur-xl">
        <CardContent className="pt-6">
          {query.trim().length < 2 ? (
            <p className="text-sm text-muted-foreground text-center py-10">Type at least 2 characters to search.</p>
          ) : isSearching ? (
            <p className="text-sm text-muted-foreground text-center py-10">Searching...</p>
          ) : results.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-10">No candidates matched &quot;{query}&quot;.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Roll Number</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Drive</TableHead>
                  <TableHead>Stage</TableHead>
                  <TableHead className="text-right">PIN</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {results.map((c) => {
                  const revealed = revealedIds.has(c._id);
                  return (
                    <TableRow key={c._id}>
                      <TableCell className="font-medium">{c.name}</TableCell>
                      <TableCell className="font-mono text-xs">{c.collegeRollNumber}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{c.email}</TableCell>
                      <TableCell className="text-xs">{c.driveTitle || "--"}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-[10px]">{c.stage}</Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <span className="font-mono font-bold tracking-widest text-sm min-w-[7ch] text-right">
                            {revealed ? c.accessPin : "••••••"}
                          </span>
                          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => toggleReveal(c._id)}>
                            {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                          </Button>
                          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => copyPin(c._id, c.accessPin)}>
                            {copiedId === c._id ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
