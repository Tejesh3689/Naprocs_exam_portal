"use client";

import { useState, useEffect } from "react";
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Editor from "@monaco-editor/react";
import { motion, AnimatePresence } from "framer-motion";
import { 
  FileText, Code2, Plus, Minus, CheckCircle2, FileJson, 
  Trash2, GripVertical, Settings2, Save, Bold, Italic, 
  Heading2, List, ListOrdered, LibraryBig, Search, Filter,
  Edit3, AlertCircle, Layout, Clock, Trophy, ShieldAlert, Infinity,
  Briefcase, Boxes, Shuffle, ToggleLeft
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatToIST } from "@/lib/time";

type TestCase = { id: string; input: string; output: string };
type McqOption = { id: string; value: string };

export default function AdvancedQuestionBank() {
  const [activeTab, setActiveTab] = useState("manual");
  
  // Manual Entry States
  const [isCoding, setIsCoding] = useState(false);
  const [title, setTitle] = useState("");
  
  // MCQ Specific States
  const [mcqOptions, setMcqOptions] = useState<McqOption[]>([
    { id: "opt-1", value: "" },
    { id: "opt-2", value: "" }
  ]);
  const [correctOption, setCorrectOption] = useState("opt-1");
  
  // Coding Specific States
  const [codeBoilerplate, setCodeBoilerplate] = useState("");
  const [publicCases, setPublicCases] = useState<TestCase[]>([{ id: "tc-p-1", input: "", output: "" }]);
  const [hiddenCases, setHiddenCases] = useState<TestCase[]>([{ id: "tc-h-1", input: "", output: "" }]);

  // Upload State
  const [isUploading, setIsUploading] = useState(false);
  const [uploadSuccess, setUploadSuccess] = useState(false);

  // Library States
  const [questions, setQuestions] = useState<any[]>([]);
  const [isLoadingLibrary, setIsLoadingLibrary] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isCommiting, setIsCommiting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);

  // Drive Selection Logic
  const [drives, setDrives] = useState<any[]>([]);
  const [selectedDriveId, setSelectedDriveId] = useState<string>("");

  // Settings / Rules States
  const [settings, setSettings] = useState<any>({
    driveTitle: "",
    examDuration: 60,
    passingCutoff: 70,
    proctoringSensitivity: "MEDIUM",
    maxCheatWarnings: 3,
    mcqCount: 15,
    codingCount: 2,
    shuffleQuestions: true,
    shuffleOptions: true,
  });
  const [isSavingSettings, setIsSavingSettings] = useState(false);

  // TipTap Instance
  const editor = useEditor({
    extensions: [StarterKit],
    content: '<p>Define the complete problem statement, constraints, and edge cases here.</p>',
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: 'prose prose-invert max-w-none focus:outline-none min-h-[160px] p-4 bg-input/20 border border-border/50 rounded-xl rounded-t-none text-sm',
      },
    },
  });

  const fetchLibrary = async () => {
    if (!selectedDriveId) return;
    setIsLoadingLibrary(true);
    try {
      const res = await fetch(`/api/admin/questions?driveId=${selectedDriveId}`);
      const data = await res.json();
      if (data.success) setQuestions(data.questions);
    } catch (e) {
      console.error("Library sync failure", e);
    } finally {
      setIsLoadingLibrary(false);
    }
  };

  const fetchSettings = async () => {
    try {
      const res = await fetch('/api/admin/settings');
      const data = await res.json();
      if (data.success) {
        setSettings((prev: any) => ({
          ...prev,
          ...data.settings
        }));
      }
    } catch (e) {
      console.error("Settings fetch failure", e);
    }
  };

  const fetchDrives = async () => {
    try {
      const res = await fetch('/api/admin/drives');
      const data = await res.json();
      if (data.success && data.drives.length > 0) {
        setDrives(data.drives);
        setSelectedDriveId(data.drives[0]._id);
      }
    } catch (e) {
      console.error("Drives fetch failure", e);
    }
  };

  useEffect(() => {
    fetchDrives();
    fetchSettings();
  }, []);

  useEffect(() => {
    if (selectedDriveId) {
      fetchLibrary();
    }
  }, [selectedDriveId]);

  const loadQuestionForEdit = (q: any) => {
    setEditingId(q._id);
    setIsCoding(q.type === 'CODING');
    setTitle(q.title);
    
    // Hydrate Tiptap
    editor?.commands.setContent(q.content);

    if (q.type === 'MCQ') {
      const mappedOptions = q.options.map((val: string, i: number) => ({ id: `opt-${i+1}`, value: val }));
      setMcqOptions(mappedOptions);
      
      // find index of correct answer in original options
      let correctIdx = q.options.findIndex((opt: string) => opt === q.correctAnswer);
      
      // Fallback for legacy data where correctAnswer might be a numeric index string
      if (correctIdx === -1 && !isNaN(Number(q.correctAnswer))) {
         const idx = Number(q.correctAnswer);
         if (idx >= 0 && idx < q.options.length) correctIdx = idx;
      }
      
      setCorrectOption(`opt-${correctIdx >= 0 ? correctIdx + 1 : 1}`);
    } else {
      setCodeBoilerplate(q.boilerplateCode || "");
      const pCases = (q.testCases || []).filter((tc: any) => !tc.isHidden).map((tc: any, i: number) => ({ id: `tc-p-${i}`, input: tc.input, output: tc.expectedOutput }));
      const hCases = (q.testCases || []).filter((tc: any) => tc.isHidden).map((tc: any, i: number) => ({ id: `tc-h-${i}`, input: tc.input, output: tc.expectedOutput }));
      setPublicCases(pCases.length > 0 ? pCases : [{ id: "tc-p-1", input: "", output: "" }]);
      setHiddenCases(hCases.length > 0 ? hCases : [{ id: "tc-h-1", input: "", output: "" }]);
    }
  };

  const clearForm = () => {
    setEditingId(null);
    setTitle("");
    editor?.commands.setContent("<p>Define the complete problem statement...</p>");
    setMcqOptions([{ id: "opt-1", value: "" }, { id: "opt-2", value: "" }]);
    setCorrectOption("opt-1");
    setCodeBoilerplate("");
    setPublicCases([{ id: "tc-p-1", input: "", output: "" }]);
    setHiddenCases([{ id: "tc-h-1", input: "", output: "" }]);
  };

  const commitToMaster = async () => {
    if (!title || !editor?.getHTML()) return;
    setIsCommiting(true);
    
    const payload: any = {
      driveId: selectedDriveId,
      type: isCoding ? 'CODING' : 'MCQ',
      title,
      content: editor.getHTML(),
    };

    if (isCoding) {
      payload.boilerplateCode = codeBoilerplate;
      payload.testCases = [
        ...publicCases.map(c => ({ input: c.input, expectedOutput: c.output, isHidden: false })),
        ...hiddenCases.map(c => ({ input: c.input, expectedOutput: c.output, isHidden: true })),
      ].filter(tc => tc.input || tc.expectedOutput);
    } else {
      payload.options = mcqOptions.map(o => o.value);
      payload.correctAnswer = mcqOptions.find(o => o.id === correctOption)?.value;
    }

    try {
      const url = editingId ? `/api/admin/questions/${editingId}` : '/api/admin/questions';
      const method = editingId ? 'PATCH' : 'POST';
      
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        clearForm();
        fetchLibrary();
      }
    } catch (err) {
      console.error("Master Sync Failure");
    } finally {
      setIsCommiting(false);
    }
  };

  const commitSettings = async () => {
    setIsSavingSettings(true);
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });
      if (res.ok) {
        alert("Exam Deployment Configurations Purified & Updated.");
      }
    } catch (e) {
      console.error("Settings Sync failure");
    } finally {
      setIsSavingSettings(false);
    }
  };

  const purgeQuestion = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("Are you sure you want to purge this record from master bank?")) return;
    try {
      const res = await fetch(`/api/admin/questions/${id}`, { method: 'DELETE' });
      if (res.ok) {
        fetchLibrary();
        setSelectedIds(prev => prev.filter(item => item !== id));
      }
    } catch (err) {
      console.error("Purge Error");
    }
  };

  const toggleSelection = (id: string, e: React.MouseEvent | boolean) => {
    if (typeof e !== 'boolean') e.stopPropagation();
    setSelectedIds(prev => 
      prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
    );
  };

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      const filteredIds = questions
        .filter(q => q.title.toLowerCase().includes(searchQuery.toLowerCase()))
        .map(q => q._id);
      setSelectedIds(filteredIds);
    } else {
      setSelectedIds([]);
    }
  };

  const bulkPurge = async () => {
    if (selectedIds.length === 0) return;
    if (!confirm(`Are you sure you want to purge ${selectedIds.length} records from master bank?`)) return;
    
    setIsBulkDeleting(true);
    try {
      const res = await fetch('/api/admin/questions/bulk', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: selectedIds })
      });
      if (res.ok) {
        setSelectedIds([]);
        fetchLibrary();
      }
    } catch (err) {
      console.error("Bulk Purge Error");
    } finally {
      setIsBulkDeleting(false);
    }
  };

  const CSV_TEMPLATE = `title,content,options,correctAnswer
# Note: correctAnswer can be a 0-based index or the exact option text
"Basic React Hook","What is the primary use of the useState hook?","[""State Management"", ""Side Effects"", ""DOM Manipulation""]",0
"Javascript Scoping","Which keyword is used to declare a block-scoped variable?","[""var"", ""let"", ""const"", ""block""]",1`;

  const downloadTemplate = () => {
    const blob = new Blob([CSV_TEMPLATE], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'naprocs_mcq_bulk_template.csv';
    a.click();
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!selectedDriveId) {
      alert("Please select a Target Drive from the dropdown before uploading.");
      e.target.value = ""; // Reset file input
      return;
    }

    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    const reader = new FileReader();

      reader.onload = async (event) => {
        const text = event.target?.result as string;
        // Handle both CRLF and LF line endings
        const lines = text.split(/\r?\n/).filter(line => line.trim());
        if (lines.length < 2) {
          alert("CSV file appears to be empty or missing headers.");
          setIsUploading(false);
          return;
        }

        const headers = lines[0].split(',').map(h => h.trim());

        // Robust CSV parser that handles quoted cells and escaped quotes ("")
        const parseCSVLine = (line: string) => {
          const result = [];
          let cur = '';
          let inQuote = false;
          for (let i = 0; i < line.length; i++) {
            const char = line[i];
            
            if (char === '"') {
              // Handle escaped quotes: ""
              if (inQuote && line[i+1] === '"') {
                cur += '"';
                i++; // Skip next quote
              } else {
                // Toggle quote state
                inQuote = !inQuote;
              }
            } else if (char === ',' && !inQuote) {
              // Field delimiter
              result.push(cur.trim());
              cur = '';
            } else {
              cur += char;
            }
          }
          result.push(cur.trim());
          return result;
        };

        const questions = lines.slice(1).map(line => {
          const values = parseCSVLine(line);
          const q: any = { driveId: selectedDriveId }; 
          
          headers.forEach((h, i) => {
             let val = values[i];
             
             if (h === 'options' || h === 'testCases') {
                try { 
                   // Attempt to parse JSON arrays (e.g. ["opt1", "opt2"] or [{"input":"1","expectedOutput":"1"}])
                   const parsed = JSON.parse(val || "[]");
                   q[h] = Array.isArray(parsed) ? parsed : [];
                } catch (e) { 
                   q[h] = []; 
                }
             } else {
                // Only assign if value is not an empty string, or provide fallback for content
                if (val && val.trim() !== "") {
                   q[h] = val;
                }
             }
          });

          // 1. Mandatory Fallback: Title as Content
          if (!q.content || q.content.trim() === "") {
             q.content = q.title || "No description provided.";
          }

          // 2. Auto-Detection of Type
          if (q.testCases && q.testCases.length > 0) {
             q.type = 'CODING';
          } else if (!q.type) {
             q.type = 'MCQ';
          }

          // 3. Post-process correctAnswer for MCQ: Mapping index to text
          if (q.type === 'MCQ' && Array.isArray(q.options) && q.options.length > 0) {
             const maybeIndex = parseInt(q.correctAnswer);
             if (!isNaN(maybeIndex) && maybeIndex >= 0 && maybeIndex < q.options.length) {
                q.correctAnswer = q.options[maybeIndex];
             }
          }

          // 4. Final Cleanup: Remove any empty string keys that might trip Mongoose
          Object.keys(q).forEach(key => {
             if (q[key] === "" || q[key] === undefined) delete q[key];
          });

          return q;
        });

      try {
        const response = await fetch('/api/admin/questions/bulk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ questions })
        });

        const data = await response.json();

        if (response.ok) {
          setUploadSuccess(true);
          fetchLibrary(); 
          setTimeout(() => setUploadSuccess(false), 5000);
        } else {
          // Display the specific details from the server's new validation logic
          const errorMsg = data.details ? `${data.error}:\n${data.details.join('\n')}` : data.error;
          alert(`Upload Failed: ${errorMsg}`);
        }
      } catch (err) {
        console.error("Bulk Commit Fault");
        alert("Network Error: Could not reach the ingestion cluster.");
      } finally {
        setIsUploading(false);
      }
    };

    reader.readAsText(file);
  };

  const addMcqOption = () => {
    setMcqOptions([...mcqOptions, { id: `opt-${Date.now()}`, value: "" }]);
  };
  
  const addTestCase = (type: "public" | "hidden") => {
    const newCase = { id: `tc-${Date.now()}`, input: "", output: "" };
    if (type === "public") setPublicCases([...publicCases, newCase]);
    else setHiddenCases([...hiddenCases, newCase]);
  };

  const removeTestCase = (type: "public" | "hidden", id: string) => {
    if (type === "public") setPublicCases(publicCases.filter(c => c.id !== id));
    else setHiddenCases(hiddenCases.filter(c => c.id !== id));
  };

  return (
    <div className="flex-1 p-6 md:p-10 max-w-7xl mx-auto w-full space-y-8 animate-in fade-in zoom-in duration-500 relative z-10">
      
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-4">
        <div className="space-y-1">
          <h1 className="text-3xl font-medium tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-accent to-primary flex items-center gap-3">
            <LibraryBig className="h-8 w-8 text-accent hidden md:block" />
            Repository Draft Engine
          </h1>
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            <p className="text-xs text-muted-foreground mr-2">Target Drive Context:</p>
            {/* Exam window shown per-option -- two drives with near-identical
                titles (e.g. two back-to-back time-slot batches) are otherwise
                impossible to tell apart in this dropdown, which is exactly
                how the 2026-09-09 SVCE incident happened: 28 questions got
                committed to the wrong sibling drive by mistake. */}
            <Select value={selectedDriveId} onValueChange={(v: any) => setSelectedDriveId(v)}>
               <SelectTrigger className="w-[340px] h-9 bg-card/40 border-border/40 text-xs font-semibold">
                  <SelectValue placeholder="Select Target Drive" />
               </SelectTrigger>
               <SelectContent>
                  {drives.map(d => (
                    <SelectItem key={d._id} value={d._id}>
                      {d.title}{d.examStart ? ` — ${formatToIST(d.examStart)}` : ""}
                    </SelectItem>
                  ))}
               </SelectContent>
            </Select>
            {(() => {
              const selectedDrive = drives.find(d => d._id === selectedDriveId);
              if (!selectedDrive) return null;
              const mcqHave = questions.filter(q => q.type === "MCQ").length;
              const codingHave = questions.filter(q => q.type === "CODING").length;
              const mcqNeed = selectedDrive.mcqCount ?? 0;
              const codingNeed = selectedDrive.codingCount ?? 0;
              const isReady = mcqHave >= mcqNeed && codingHave >= codingNeed;
              return (
                <Badge
                  variant={isReady ? "secondary" : "destructive"}
                  className={`text-[10px] font-bold uppercase tracking-wide ${isReady ? "bg-emerald-500/10 text-emerald-500" : ""}`}
                  title={selectedDrive.examStart ? `Exam window: ${formatToIST(selectedDrive.examStart)} – ${formatToIST(selectedDrive.examEnd)}` : undefined}
                >
                  {isReady ? "✓ Ready" : "⚠ Incomplete"} — {mcqHave}/{mcqNeed} MCQ · {codingHave}/{codingNeed} Coding
                </Badge>
              );
            })()}
          </div>
        </div>

        <Button 
          onClick={commitToMaster}
          disabled={isCommiting}
          className="h-10 px-6 font-semibold bg-primary text-primary-foreground shadow-xl shadow-primary/20 hover:scale-[1.02] transition-transform"
        >
          {isCommiting ? "Syncing..." : editingId ? "Update Repository" : "Commit to Master Bank"}
        </Button>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="bg-muted/40 p-1 rounded-xl h-12 mb-8 inline-flex">
          <TabsTrigger value="manual" className="px-6 h-full rounded-lg text-sm font-semibold transition-all data-[state=active]:bg-card data-[state=active]:shadow-xl border border-transparent data-[state=active]:border-border/50">
            Manual Composition
          </TabsTrigger>
          <TabsTrigger value="bulk" className="px-6 h-full rounded-lg text-sm font-semibold transition-all data-[state=active]:bg-card data-[state=active]:shadow-xl border border-transparent data-[state=active]:border-border/50">
            Bulk CSV Ingestion
          </TabsTrigger>
          <TabsTrigger value="rules" className="px-6 h-full rounded-lg text-sm font-semibold transition-all data-[state=active]:bg-card data-[state=active]:shadow-xl border border-transparent data-[state=active]:border-border/50">
            Exam Pooling Configurations
          </TabsTrigger>
        </TabsList>

        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
          >
            <TabsContent value="manual" className="m-0 focus-visible:outline-none">
              
              <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
                {/* Left Side: Repository Library Selector */}
                <div className="lg:col-span-1 space-y-4">
                   <div className="relative group">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground group-focus-within:text-primary transition-colors" />
                      <Input 
                        placeholder="Filter bank..." 
                        value={searchQuery}
                        onChange={e => setSearchQuery(e.target.value)}
                        className="pl-9 bg-card/40 border-border/40 focus-visible:ring-primary/30 h-10 text-xs"
                      />
                   </div>

                   <div className="flex items-center justify-between px-2 py-1">
                      <div className="flex items-center gap-2">
                         <Checkbox 
                           id="selectAll" 
                           checked={questions.length > 0 && selectedIds.length === questions.filter(q => q.title.toLowerCase().includes(searchQuery.toLowerCase())).length}
                           onCheckedChange={(checked) => handleSelectAll(!!checked)}
                         />
                         <label htmlFor="selectAll" className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground cursor-pointer select-none">
                           Select All
                         </label>
                      </div>
                      {selectedIds.length > 0 && (
                         <span className="text-[10px] font-bold text-primary animate-pulse">
                           {selectedIds.length} SELECTED
                         </span>
                      )}
                   </div>

                   <ScrollArea className="h-[680px] pr-4">
                      {isLoadingLibrary ? (
                         <div className="space-y-3">
                           {[1,2,3,4,5].map(i => <div key={i} className="h-20 bg-muted/20 animate-pulse rounded-xl" />)}
                         </div>
                      ) : (
                         <div className="space-y-3">
                            <Button 
                              variant={!editingId ? 'secondary' : 'outline'} 
                              className="w-full justify-start h-14 rounded-xl border-dashed border-primary/20 bg-primary/5 text-primary font-bold gap-3"
                              onClick={clearForm}
                            >
                               <Plus className="h-4 w-4" /> New Question Unit
                            </Button>

                            {questions
                              .filter(q => q.title.toLowerCase().includes(searchQuery.toLowerCase()))
                              .map((q) => (
                                <div 
                                  key={q._id} 
                                  onClick={() => loadQuestionForEdit(q)}
                                  className={`group p-4 rounded-xl border cursor-pointer transition-all relative ${editingId === q._id ? 'bg-primary/10 border-primary/50 ring-1 ring-primary/20 shadow-lg shadow-primary/10' : 'bg-card/40 border-border/40 hover:bg-card hover:border-border/60'} ${selectedIds.includes(q._id) ? 'border-primary/60 bg-primary/5' : ''}`}
                                >
                                   <div className="flex justify-between items-start mb-2">
                                      <div className="flex items-center gap-2">
                                         <Checkbox 
                                           checked={selectedIds.includes(q._id)} 
                                           onCheckedChange={() => toggleSelection(q._id, true)}
                                           onClick={(e) => e.stopPropagation()}
                                           className="h-3.5 w-3.5"
                                         />
                                         <Badge variant="outline" className={`text-[9px] uppercase font-bold tracking-tighter ${q.type === 'CODING' ? 'border-accent/40 text-accent bg-accent/5' : 'border-primary/40 text-primary bg-primary/5'}`}>
                                           {q.type}
                                         </Badge>
                                      </div>
                                      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                         <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-destructive" onClick={(e) => purgeQuestion(q._id, e)}>
                                           <Trash2 className="h-3 w-3" />
                                         </Button>
                                      </div>
                                   </div>
                                   <h4 className="text-sm font-semibold truncate leading-tight">{q.title}</h4>
                                   <p className="text-[10px] text-muted-foreground mt-1 font-mono uppercase opacity-60">ID: {q._id.slice(-6)}</p>
                                </div>
                            ))}
                         </div>
                      )}
                   </ScrollArea>
                </div>

                {/* Right Side: Active Composer Engine */}
                <div className="lg:col-span-3">
                  <Card className="border-border/40 bg-card/60 backdrop-blur-xl shadow-2xl overflow-hidden relative">
                 {/* Mode Toggle Header */}
                 <div className="bg-muted/30 border-b border-border/50 p-4 px-6 flex items-center justify-between">
                   <div className="flex items-center gap-4">
                     <span className={`text-sm font-medium ${!isCoding ? 'text-primary' : 'text-muted-foreground'}`}>MCQ Mode</span>
                     <Switch 
                       checked={!!isCoding} 
                       onCheckedChange={setIsCoding} 
                       className="data-[state=checked]:bg-accent data-[state=unchecked]:bg-primary"
                     />
                     <span className={`text-sm font-medium ${isCoding ? 'text-accent' : 'text-muted-foreground'}`}>Coding Engine</span>
                   </div>
                   
                   <Badge variant="outline" className={`font-mono border-border/50 ${isCoding ? 'bg-accent/10 text-accent' : 'bg-primary/10 text-primary'}`}>
                     {isCoding ? 'ALGORITHM_EVAL' : 'OBJECTIVE_EVAL'}
                   </Badge>
                 </div>

                 <div className="p-6 md:p-8 space-y-8">
                   {/* Universal Title */}
                   <div className="space-y-1.5">
                     <Label className="text-xs uppercase tracking-widest font-semibold text-muted-foreground">Unique Identifier</Label>
                     <Input 
                       value={title} 
                       onChange={e => setTitle(e.target.value)}
                       className="text-xl h-12 bg-transparent border-0 border-b-2 border-border/50 rounded-none px-0 focus-visible:ring-0 focus-visible:border-primary transition-all font-medium"
                     />
                   </div>

                   {/* Universal Main Description via TipTap */}
                   <div className="space-y-2">
                     <Label className="text-xs uppercase tracking-widest font-semibold text-muted-foreground">Problem Context</Label>
                     <div className="rounded-xl overflow-hidden shadow-inner border border-border/50 bg-[#1e1e1e]/50 flex flex-col">
                       {editor && (
                         <div className="bg-[#1e1e1e] border-b border-border/50 p-2 flex gap-1">
                           <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground" onClick={() => editor.chain().focus().toggleBold().run()}><Bold className="h-4 w-4" /></Button>
                           <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground" onClick={() => editor.chain().focus().toggleItalic().run()}><Italic className="h-4 w-4" /></Button>
                           <div className="w-px h-4 bg-border/50 mx-1 self-center" />
                           <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground" onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}><Heading2 className="h-4 w-4" /></Button>
                           <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground" onClick={() => editor.chain().focus().toggleBulletList().run()}><List className="h-4 w-4" /></Button>
                           <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground" onClick={() => editor.chain().focus().toggleOrderedList().run()}><ListOrdered className="h-4 w-4" /></Button>
                         </div>
                       )}
                       <EditorContent editor={editor} />
                     </div>
                   </div>

                   {/* Distinct Branches based on Toggle */}
                   <AnimatePresence mode="popLayout">
                     {!isCoding ? (
                       <motion.div 
                         key="mcq" 
                         initial={{ opacity: 0, x: -20 }} 
                         animate={{ opacity: 1, x: 0 }} 
                         exit={{ opacity: 0, x: 20 }}
                         className="space-y-4 pt-4 border-t border-border/40"
                       >
                         <div className="flex justify-between items-center mb-4">
                           <Label className="text-xs uppercase tracking-widest font-semibold text-muted-foreground">Answer Nodes</Label>
                           <Button variant="outline" size="sm" onClick={addMcqOption} className="h-8 border-primary/40 text-primary hover:bg-primary/10">
                             <Plus className="h-4 w-4 mr-2" /> Append Node
                           </Button>
                         </div>

                         <RadioGroup value={correctOption} onValueChange={setCorrectOption} className="space-y-3">
                           {mcqOptions.map((opt, i) => (
                             <div key={opt.id} className={`flex items-center gap-4 p-3 rounded-xl border transition-all ${correctOption === opt.id ? 'bg-emerald-500/5 border-emerald-500/50 shadow-md' : 'bg-card/40 border-border/50 hover:border-primary/30'}`}>
                               <GripVertical className="h-4 w-4 text-muted-foreground cursor-grab opacity-50" />
                               <div className="flex bg-background/50 p-2 rounded-full border border-border/50 shadow-inner">
                                 <RadioGroupItem value={opt.id} id={opt.id} className="text-emerald-500 border-muted-foreground" />
                               </div>
                               <Input 
                                 value={opt.value}
                                 onChange={(e) => setMcqOptions(mcqOptions.map(o => o.id === opt.id ? { ...o, value: e.target.value } : o))}
                                 placeholder={`Enter option ${i + 1}`}
                                 className="flex-1 bg-transparent border-0 focus-visible:ring-0 px-1 font-medium"
                               />
                               {mcqOptions.length > 2 && (
                                 <Button variant="ghost" size="icon" onClick={() => setMcqOptions(mcqOptions.filter(o => o.id !== opt.id))} className="text-muted-foreground hover:text-destructive hover:bg-destructive/10">
                                   <Trash2 className="h-4 w-4" />
                                 </Button>
                               )}
                             </div>
                           ))}
                         </RadioGroup>
                       </motion.div>
                     ) : (
                       <motion.div 
                         key="coding"
                         initial={{ opacity: 0, x: 20 }} 
                         animate={{ opacity: 1, x: 0 }} 
                         exit={{ opacity: 0, x: -20 }}
                         className="grid grid-cols-1 xl:grid-cols-2 gap-8 pt-4 border-t border-border/40"
                       >
                         {/* Boilerplate Editor */}
                         <div className="space-y-3 h-[400px] flex flex-col">
                           <Label className="text-xs uppercase tracking-widest font-semibold text-muted-foreground">Boilerplate Stub</Label>
                           <div className="flex-1 rounded-xl overflow-hidden shadow-inner border border-border/50 bg-[#1e1e1e]">
                             <Editor
                               height="100%"
                               defaultLanguage="javascript"
                               theme="vs-dark"
                               value={codeBoilerplate}
                               onChange={(val) => setCodeBoilerplate(val || "")}
                               options={{ minimap: { enabled: false }, fontSize: 13, fontFamily: 'var(--font-geist-mono)', padding: { top: 16 } }}
                             />
                           </div>
                         </div>

                         {/* Test Cases Area */}
                         <ScrollArea className="h-[400px] pr-4">
                           <div className="space-y-8">
                             
                             {/* Public Cases */}
                             <div className="space-y-4">
                               <div className="flex justify-between items-center bg-accent/10 p-2 px-3 rounded-md border border-accent/20">
                                 <Label className="text-xs uppercase tracking-widest font-semibold text-accent flex items-center gap-2"><CheckCircle2 className="h-3.5 w-3.5" /> Public Test Cases</Label>
                                 <Button variant="ghost" size="icon" onClick={() => addTestCase("public")} className="h-6 w-6 text-accent hover:bg-accent/20 hover:text-accent"><Plus className="h-3 w-3" /></Button>
                               </div>
                               {publicCases.map((tc, i) => (
                                 <div key={tc.id} className="grid grid-cols-12 gap-3 items-start border-l-2 border-border/50 pl-3 group">
                                   <div className="col-span-5 space-y-1">
                                     <span className="text-[10px] text-muted-foreground font-mono">INPUT</span>
                                     <Input value={tc.input} onChange={e => setPublicCases(publicCases.map(c => c.id === tc.id ? { ...c, input: e.target.value } : c))} className="bg-input/30 font-mono text-xs focus-visible:ring-accent" />
                                   </div>
                                   <div className="col-span-6 space-y-1">
                                     <span className="text-[10px] text-muted-foreground font-mono">OUTPUT</span>
                                     <Input value={tc.output} onChange={e => setPublicCases(publicCases.map(c => c.id === tc.id ? { ...c, output: e.target.value } : c))} className="bg-input/30 font-mono text-xs focus-visible:ring-accent" />
                                   </div>
                                   {publicCases.length > 1 && (
                                     <Button variant="ghost" size="icon" onClick={() => removeTestCase("public", tc.id)} className="col-span-1 mt-5 h-8 w-8 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"><Trash2 className="h-4 w-4" /></Button>
                                   )}
                                 </div>
                               ))}
                             </div>

                             {/* Hidden Cases */}
                             <div className="space-y-4">
                               <div className="flex justify-between items-center bg-purple-500/10 p-2 px-3 rounded-md border border-purple-500/20">
                                 <Label className="text-xs uppercase tracking-widest font-semibold text-purple-400 flex items-center gap-2"><CheckCircle2 className="h-3.5 w-3.5" /> Hidden Test Cases</Label>
                                 <Button variant="ghost" size="icon" onClick={() => addTestCase("hidden")} className="h-6 w-6 text-purple-400 hover:bg-purple-500/20"><Plus className="h-3 w-3" /></Button>
                               </div>
                               {hiddenCases.map((tc, i) => (
                                 <div key={tc.id} className="grid grid-cols-12 gap-3 items-start border-l-2 border-border/50 pl-3 group">
                                   <div className="col-span-5 space-y-1">
                                     <span className="text-[10px] text-muted-foreground font-mono">INPUT</span>
                                     <Input value={tc.input} onChange={e => setHiddenCases(hiddenCases.map(c => c.id === tc.id ? { ...c, input: e.target.value } : c))} className="bg-input/30 font-mono text-xs focus-visible:ring-purple-400" />
                                   </div>
                                   <div className="col-span-6 space-y-1">
                                     <span className="text-[10px] text-muted-foreground font-mono">OUTPUT</span>
                                     <Input value={tc.output} onChange={e => setHiddenCases(hiddenCases.map(c => c.id === tc.id ? { ...c, output: e.target.value } : c))} className="bg-input/30 font-mono text-xs focus-visible:ring-purple-400" />
                                   </div>
                                   {hiddenCases.length > 1 && (
                                     <Button variant="ghost" size="icon" onClick={() => removeTestCase("hidden", tc.id)} className="col-span-1 mt-5 h-8 w-8 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"><Trash2 className="h-4 w-4" /></Button>
                                   )}
                                 </div>
                               ))}
                             </div>

                           </div>
                         </ScrollArea>
                       </motion.div>
                     )}
                    </AnimatePresence>
                  </div>
                </Card>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="bulk" className="m-0 focus-visible:outline-none">
              <Card className="border-border/40 bg-card/60 backdrop-blur-xl shadow-2xl p-12 flex flex-col items-center justify-center min-h-[500px]">
                <AnimatePresence mode="wait">
                  {uploadSuccess ? (
                    <motion.div
                      key="success"
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0 }}
                      className="flex flex-col items-center justify-center text-emerald-500"
                    >
                      <CheckCircle2 className="h-20 w-20 mb-6" />
                      <h3 className="text-2xl font-bold text-foreground">Ingestion Sync Complete</h3>
                      <p className="text-muted-foreground text-center mt-2 max-w-sm">
                        Total 142 objects dynamically instantiated and stored securely in the master cluster.
                      </p>
                    </motion.div>
                  ) : (
                    <motion.div 
                      key="upload"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="w-full max-w-2xl relative"
                    >
                      <div className="flex justify-end mb-6">
                        <Button 
                          variant="outline" 
                          size="sm"
                          onClick={downloadTemplate}
                          className="border-primary/40 text-primary hover:bg-primary/10 transition-all"
                        >
                           <FileText className="h-4 w-4 mr-2" /> Download CSV Template
                        </Button>
                      </div>

                      <div className="relative group cursor-pointer">
                        <input 
                          type="file" 
                          accept=".csv"
                          onChange={handleFileUpload}
                          disabled={isUploading}
                          className="absolute inset-0 w-full h-full opacity-0 z-10 cursor-pointer disabled:cursor-not-allowed"
                        />
                        <div className={`flex flex-col items-center justify-center py-20 border-2 border-dashed rounded-3xl transition-all ${isUploading ? 'border-primary bg-primary/5 shadow-[inset_0_0_100px_rgba(var(--primary),0.1)]' : 'border-border/60 bg-input/10 group-hover:bg-input/30 group-hover:border-primary/50 group-hover:shadow-[0_0_50px_rgba(0,0,0,0.2)]'}`}>
                          {isUploading ? (
                            <div className="h-16 w-16 border-[6px] border-primary/20 border-t-primary rounded-full animate-spin mb-6" />
                          ) : (
                            <div className="bg-background/80 p-6 rounded-3xl mb-6 shadow-xl border border-border/50 group-hover:scale-105 transition-transform">
                              <FileJson className="h-12 w-12 text-primary group-hover:text-accent transition-colors" />
                            </div>
                          )}
                          <h3 className="text-xl font-bold text-foreground mb-2">
                            {isUploading ? "Constructing Matrix Clusters..." : "Drop payload definition here"}
                          </h3>
                          {!isUploading && (
                            <p className="text-muted-foreground">Or click to browse .CSV descriptors</p>
                          )}
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </Card>
            </TabsContent>

            <TabsContent value="rules" className="m-0 focus-visible:outline-none">
              <div className="grid grid-cols-1 xl:grid-cols-3 gap-8">
                
                {/* Left Column: Drive Meta & Pooling */}
                <div className="xl:col-span-2 space-y-8">
                  <Card className="border-border/40 bg-card/60 backdrop-blur-xl shadow-2xl overflow-hidden">
                    <div className="bg-primary/5 border-b border-border/50 p-4 px-6 flex items-center gap-3">
                       <Briefcase className="h-5 w-5 text-primary" />
                       <h3 className="text-sm font-bold uppercase tracking-wider text-primary">Recruitment Drive Blueprint</h3>
                    </div>
                    <div className="p-8 space-y-8">
                      <div className="space-y-2">
                        <Label className="text-xs uppercase tracking-widest font-semibold text-muted-foreground">Drive Identifier (Global)</Label>
                        <Input 
                          value={settings.driveTitle}
                          onChange={e => setSettings({...settings, driveTitle: e.target.value})}
                          placeholder="e.g. Naprocs Summer Tech Sprint 2026"
                          className="text-lg font-medium bg-input/20 border-border/50 h-12"
                        />
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-8 pt-4 border-t border-border/40">
                         <div className="space-y-4">
                            <div className="flex items-center gap-2 mb-2">
                               <Boxes className="h-4 w-4 text-accent" />
                               <Label className="text-xs uppercase tracking-widest font-semibold text-accent">MCQ Allocation</Label>
                            </div>
                            <div className="flex items-center gap-4">
                               <Input 
                                 type="number"
                                 value={settings.mcqCount}
                                 onChange={e => setSettings({...settings, mcqCount: parseInt(e.target.value)})}
                                 className="w-24 bg-input/20 border-border/50 font-bold text-center"
                               />
                               <span className="text-sm text-muted-foreground">Questions from bank</span>
                            </div>
                            <p className="text-[10px] text-muted-foreground leading-relaxed italic">
                              Randomly instantiated for each unique candidate session. Max bank size: {questions.filter(q => q.type === 'MCQ').length} units.
                            </p>
                         </div>

                         <div className="space-y-4">
                            <div className="flex items-center gap-2 mb-2">
                               <Code2 className="h-4 w-4 text-purple-400" />
                               <Label className="text-xs uppercase tracking-widest font-semibold text-purple-400">Coding Matrix Count</Label>
                            </div>
                            <div className="flex items-center gap-4">
                               <Input 
                                 type="number"
                                 value={settings.codingCount}
                                 onChange={e => setSettings({...settings, codingCount: parseInt(e.target.value)})}
                                 className="w-24 bg-input/20 border-border/50 font-bold text-center"
                               />
                               <span className="text-sm text-muted-foreground">Algorithms per session</span>
                            </div>
                            <p className="text-[10px] text-muted-foreground leading-relaxed italic">
                              Dynamic selection from valid coding objects. Max bank size: {questions.filter(q => q.type === 'CODING').length} units.
                            </p>
                         </div>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-8 pt-4 border-t border-border/40">
                         <div className="flex items-center justify-between p-4 rounded-xl bg-card/40 border border-border/40">
                            <div className="space-y-1">
                               <div className="flex items-center gap-2">
                                  <Shuffle className="h-3 w-3 text-muted-foreground" />
                                  <span className="text-xs font-bold uppercase tracking-tighter">Shuffle Questions</span>
                               </div>
                               <p className="text-[10px] text-muted-foreground">Randomize question order</p>
                            </div>
                            <Switch 
                              checked={!!settings.shuffleQuestions}
                              onCheckedChange={val => setSettings({...settings, shuffleQuestions: val})}
                            />
                         </div>

                         <div className="flex items-center justify-between p-4 rounded-xl bg-card/40 border border-border/40">
                            <div className="space-y-1">
                               <div className="flex items-center gap-2">
                                  <ToggleLeft className="h-3 w-3 text-muted-foreground" />
                                  <span className="text-xs font-bold uppercase tracking-tighter">Shuffle Options</span>
                               </div>
                               <p className="text-[10px] text-muted-foreground">Randomize MCQ choice nodes</p>
                            </div>
                            <Switch 
                              checked={!!settings.shuffleOptions}
                              onCheckedChange={val => setSettings({...settings, shuffleOptions: val})}
                            />
                         </div>
                      </div>
                    </div>
                  </Card>
                </div>

                {/* Right Column: Governance & Security */}
                <div className="space-y-8">
                  <Card className="border-border/40 bg-card/60 backdrop-blur-xl shadow-2xl p-8 space-y-8">
                     <div className="flex items-center gap-3 text-muted-foreground mb-4">
                        <Settings2 className="h-5 w-5" />
                        <h3 className="text-xs font-bold uppercase tracking-widest">Global Governance</h3>
                     </div>

                     <div className="space-y-4">
                        <Label className="text-xs uppercase tracking-widest font-semibold text-muted-foreground flex items-center gap-2">
                          <Clock className="h-3 w-3" /> Exam Duration
                        </Label>
                        <div className="flex items-center gap-4">
                           <Input 
                             type="number"
                             value={settings.examDuration}
                             onChange={e => setSettings({...settings, examDuration: parseInt(e.target.value)})}
                             className="w-full bg-input/20 border-border/50 font-bold"
                           />
                           <span className="text-xs font-bold text-muted-foreground/60">MINS</span>
                        </div>
                     </div>

                     <div className="space-y-4">
                        <Label className="text-xs uppercase tracking-widest font-semibold text-muted-foreground flex items-center gap-2">
                          <Trophy className="h-3 w-3" /> Passing Cutoff
                        </Label>
                        <div className="flex items-center gap-4">
                           <Input 
                             type="number"
                             value={settings.passingCutoff}
                             onChange={e => setSettings({...settings, passingCutoff: parseInt(e.target.value)})}
                             className="w-full bg-input/20 border-border/50 font-bold"
                           />
                           <span className="text-xs font-bold text-muted-foreground/60">%</span>
                        </div>
                     </div>

                     <div className="space-y-4 pt-4 border-t border-border/40">
                        <Label className="text-xs uppercase tracking-widest font-semibold text-destructive/80 flex items-center gap-2">
                          <ShieldAlert className="h-3 w-3" /> Proctoring Severity
                        </Label>
                        <div className="grid grid-cols-3 gap-2">
                           {['LOW', 'MEDIUM', 'HIGH'].map(s => (
                             <Button 
                               key={s}
                               variant={settings.proctoringSensitivity === s ? 'default' : 'outline'}
                               onClick={() => setSettings({...settings, proctoringSensitivity: s})}
                               className={`text-[10px] h-8 font-bold ${settings.proctoringSensitivity === s ? 'bg-destructive/80 text-white border-transparent' : 'border-border/50 text-muted-foreground'}`}
                             >
                               {s}
                             </Button>
                           ))}
                        </div>
                     </div>

                     <div className="space-y-4">
                        <Label className="text-xs uppercase tracking-widest font-semibold text-muted-foreground">
                          Max Cheat Warnings
                        </Label>
                        <Input 
                          type="number"
                          value={settings.maxCheatWarnings}
                          onChange={e => setSettings({...settings, maxCheatWarnings: parseInt(e.target.value)})}
                          className="w-full bg-input/20 border-border/50 font-bold"
                        />
                     </div>

                     <Button 
                       onClick={commitSettings}
                       disabled={isSavingSettings}
                       className="w-full h-12 bg-primary text-primary-foreground font-bold shadow-xl shadow-primary/20 mt-4"
                     >
                       {isSavingSettings ? "Purifying Configs..." : "Save Deployment Rules"}
                     </Button>
                  </Card>

                  <div className="p-6 rounded-2xl bg-amber-500/5 border border-amber-500/10 space-y-3">
                     <div className="flex items-center gap-2 text-amber-500/80">
                        <AlertCircle className="h-4 w-4" />
                        <span className="text-xs font-bold uppercase tracking-widest">Live Deployment Warning</span>
                     </div>
                     <p className="text-[10px] text-muted-foreground leading-relaxed">
                        Modifying pooling counts or duration during an active recruitment drive may cause session inconsistencies for live candidates.
                     </p>
                  </div>
                </div>
              </div>
            </TabsContent>
          </motion.div>
        </AnimatePresence>
      </Tabs>

      {/* Floating Bulk Action Bar */}
      <AnimatePresence>
        {selectedIds.length > 0 && (
          <motion.div 
            initial={{ y: 100, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 100, opacity: 0 }}
            className="fixed bottom-8 left-1/2 -translate-x-1/2 z-50 bg-background/80 backdrop-blur-2xl border border-primary/30 p-4 px-8 rounded-full shadow-[0_20px_50px_rgba(0,0,0,0.2)] flex items-center gap-8"
          >
            <div className="flex flex-col">
              <span className="text-xs font-bold uppercase tracking-widest text-primary">{selectedIds.length} Units Targeted</span>
              <span className="text-[10px] text-muted-foreground">Select nodes to commit bulk purge</span>
            </div>
            
            <div className="h-8 w-px bg-border/50" />

            <div className="flex items-center gap-3">
              <Button 
                variant="ghost" 
                size="sm" 
                onClick={() => setSelectedIds([])}
                className="text-xs font-bold hover:bg-primary/10"
              >
                Deselect All
              </Button>
              <Button 
                variant="destructive" 
                size="sm" 
                disabled={isBulkDeleting}
                onClick={bulkPurge}
                className="rounded-full px-6 font-bold shadow-lg shadow-destructive/20 h-10"
              >
                {isBulkDeleting ? "Purging..." : "Purge Selected"}
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
