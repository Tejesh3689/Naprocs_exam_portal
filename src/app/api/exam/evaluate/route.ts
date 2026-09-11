import { NextResponse } from "next/server";
import vm from "node:vm";
import supabase from "@/lib/supabase";
import { isPistonLanguage, executeViaPiston } from "@/lib/pistonExecute";

// Robust Normalizer: Standardizes formatting for comparison (shared by both
// the JS vm path below and the multi-language Piston path).
const robustNormalizeOutput = (s: string) => (s || "")
  .toString()
  .replace(/\r\n/g, '\n')
  .split('\n')
  .map(l => l.trim())
  .filter(l => l !== "")
  .join('\n')
  .toLowerCase();

export async function POST(req: Request) {
  try {
    const { studentCode, questionId, language } = await req.json();

    if (!studentCode || !questionId) {
      return NextResponse.json({ error: "No execution payload or identity provided" }, { status: 400 });
    }

    const { data: question, error: questionError } = await supabase
      .from("questions").select("*").eq("id", questionId).maybeSingle();
    if (questionError) throw questionError;

    if (!question) {
       return NextResponse.json({ error: "Question not found" }, { status: 404 });
    }

    const testCases = question.test_cases || [];

    // Multi-language path: Python/Java/C/C++ run as a FULL PROGRAM via a
    // self-hosted Piston instance, stdin -> stdout (the standard convention
    // for multi-language judges). JavaScript (language absent/undefined, for
    // backward compatibility with sessions predating this feature, or
    // explicitly 'javascript') keeps using the exact existing in-process vm
    // sandbox below, unchanged.
    if (isPistonLanguage(language)) {
      const evaluatedResults = [];
      for (let i = 0; i < testCases.length; i++) {
        const tc = testCases[i];
        const start = Date.now();
        try {
          // Explicit 'normal' priority: this is the candidate's own optional
          // "Run Tests" pre-check, not the authoritative score -- it must
          // never queue ahead of examTiming.ts's 'high'-priority re-grading
          // at final submit. See pistonExecute.ts's two-tier queue.
          const { stdout, stderr, exitCode } = await executeViaPiston(language, studentCode, (tc.input || "").toString(), undefined, "normal");
          const actual = stdout.trim();
          const error = exitCode !== 0 ? (stderr || "Execution failed").slice(0, 500) : null;
          const passed = !error && robustNormalizeOutput(actual) === robustNormalizeOutput(tc.expectedOutput);
          const runtime = Date.now() - start;
          evaluatedResults.push(
            tc.isHidden
              ? { index: i, passed, error, runtime, isHidden: true }
              : { index: i, actual, error, runtime, passed, isHidden: false }
          );
        } catch (e: any) {
          evaluatedResults.push({ index: i, actual: null, error: e.message || "Execution failed", runtime: Date.now() - start, passed: false, isHidden: !!tc.isHidden });
        }
      }
      return NextResponse.json({ success: true, results: evaluatedResults });
    }

    // 1. Generate Universal Wrapped Code
    const funcMatch = studentCode.match(/function\s+([a-zA-Z0-9_$]+)/);
    const entryPoint = funcMatch ? funcMatch[1] : null;

    const wrappedCode = `
      (function(global) {
        global.RESULTS = [];
        const cases = ${JSON.stringify(testCases)};
        const entry = "${entryPoint}";

        // Robust Normalizer: Standardizes formatting for comparison
        const robustNormalize = (s) => (s || "")
          .toString()
          .replace(/\\r\\n/g, '\\n')
          .split('\\n')
          .map(l => l.trim())
          .filter(l => l !== "")
          .join('\\n')
          .toLowerCase();

        for (let i = 0; i < cases.length; i++) {
           const tc = cases[i];
           const res = { index: i, actual: null, error: null, runtime: 0 }; 
           const start = Date.now();
           
           global.STDOUT = [];
           global.STDIN_CONTENT = (tc.input || "").toString();

           try {
              (function() {
                ${studentCode}

                if (global.STDOUT.length === 0 && entry && typeof eval(entry) === 'function') {
                   let args = [];
                   const rawInput = (tc.input || "").trim();
                   
                   // Robust Input Dispatch: Try JSON, fallback to comma-split
                   try {
                     if (rawInput.startsWith('[') || rawInput.startsWith('{')) {
                       args = [JSON.parse(rawInput)];
                     } else {
                       throw new Error("Force comma split");
                     }
                   } catch(e) {
                     args = rawInput.split(',').map(v => {
                        const s = v.trim();
                        if (!isNaN(s) && s !== "" && !s.startsWith("0b") && !s.startsWith("0x")) return Number(s);
                        if (s === 'true') return true;
                        if (s === 'false') return false;
                        return s;
                     });
                   }

                   let retValue = eval(entry)(...args);
                   if (retValue !== undefined) {
                      if (Array.isArray(retValue) || (retValue !== null && typeof retValue === 'object')) {
                         retValue = JSON.stringify(retValue);
                      }
                      global.STDOUT.push(String(retValue));
                   }
                }
              })();

              if (global.STDOUT.length === 0) {
                 throw new Error("Logic produced no output.");
              }

              res.actual = global.STDOUT.join('\\n').trim();
           } catch(e) {
              res.error = e.message;
           }
           res.runtime = Date.now() - start;
           global.RESULTS.push(res);
        }
      })(this);
    `;

    // 2. Setup Secure Sandbox with Mocks
    const sandbox: any = { 
       RESULTS: null,
       STDOUT: [],
       STDIN_CONTENT: "",
       Buffer: Buffer,
       require: (id: string) => {
          if (id === 'fs') {
             return {
                readFileSync: (fd: any, encoding?: string) => {
                   if (fd === 0 || fd === '/dev/stdin') {
                      return sandbox.STDIN_CONTENT;
                   }
                   throw new Error("FS restricted");
                }
             };
          }
          throw new Error(`Module ${id} restricted`);
       },
       console: {
          log: (...args: any[]) => {
             sandbox.STDOUT.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
          },
          info: (...args: any[]) => sandbox.console.log(...args),
          error: (...args: any[]) => sandbox.console.log(...args),
          warn: (...args: any[]) => sandbox.console.log(...args),
       },
       process: {
          stdout: { write: (s: string) => sandbox.STDOUT.push(s) }
       }
    };
    
    const context = vm.createContext(sandbox);

    try {
      const script = new vm.Script(wrappedCode);
      script.runInContext(context, { timeout: 2500 });
      const results = sandbox.RESULTS;

      if (!results) {
        return NextResponse.json({ 
           success: false, 
           verdict: 'RUNTIME_ERROR', 
           message: "VM failure: produced no results matrix." 
        });
      }

      // 3. Comparison with Robust Normalization
      const robustNormalize = (s: string) => (s || "")
        .toString()
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map(l => l.trim())
        .filter(l => l !== "")
        .join('\n')
        .toLowerCase();

      const evaluatedResults = results.map((r: any, idx: number) => {
        const tc = testCases[idx];
        const expectedNorm = robustNormalize(tc.expectedOutput);
        const actualNorm = robustNormalize(r.actual);
        const isPassed = !r.error && (actualNorm === expectedNorm);

        if (tc.isHidden) {
          return { index: r.index, passed: isPassed, error: r.error, runtime: r.runtime, isHidden: true };
        }
        return { ...r, passed: isPassed, isHidden: false };
      });

      return NextResponse.json({ success: true, results: evaluatedResults });

    } catch (e: any) {
      if (e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
        return NextResponse.json({ success: false, verdict: 'TIME_LIMIT_EXCEEDED' });
      }
      return NextResponse.json({ success: false, verdict: 'RUNTIME_ERROR', message: e.message });
    }
  } catch (error: any) {
    console.error("Evaluation API Hardware Failure:", error);
    return NextResponse.json({ error: "Internal Evaluation Failure" }, { status: 500 });
  }
}
