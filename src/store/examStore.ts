import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

interface Candidate {
  id: string;
  name: string;
  email: string;
  pin: string;
  collegeRollNumber: string;
}

export interface Question {
  _id: string;
  id?: string;
  type: 'MCQ' | 'CODING';
  title: string;
  content?: string;
  description?: string;
  options?: string[]; // For MCQ mode
  boilerplateCode?: string; // For Coding mode
  language?: string; // For Coding mode
  testCases?: any[];
}

interface ExamState {
  candidate: Candidate | null;
  isAuthenticated: boolean;
  questions: Question[];
  currentQuestionIndex: number;
  answers: Record<string, any>;
  isFullscreen: boolean;
  // `cheatWarnings` is kept as the combined total (lookingAwayWarnings +
  // otherWarnings) purely for backward-compatible display/persistence -- it's
  // what gets written to candidates.cheat_warnings and shown across the admin
  // UI. It must never be compared against a cap on its own: LOOKING_AWAY is a
  // documented false-positive-prone signal (see PROCTORING_RULEBOOK.md §3)
  // and is capped independently from every other violation type, so a
  // candidate can accumulate up to (lookingAwayCap + otherCap) total warnings
  // before termination, not a single shared cap.
  cheatWarnings: number;
  lookingAwayWarnings: number;
  otherWarnings: number;
  mediaStream: MediaStream | null;
  // The opaque token issued by /api/auth/exam-login (persisted to
  // localStorage, unlike the rest of this store -- see the `persist` config
  // below). Its only purpose is to let a legitimate re-login prove "this is
  // the same browser that was already in this session" -- see
  // /api/auth/exam-login/route.ts's `existingToken` handling. Found live
  // post-nap_klu_2026: this store was never persisted at all, so ANY page
  // reload (a flaky campus wifi drop, laptop sleep, browser hiccup) wiped
  // `isAuthenticated` and forced a full re-login through the login form --
  // and since the candidate's OWN periodic autosave (/api/exam/sync) had just
  // refreshed `last_active_at` moments earlier, the server's multi-device
  // check saw that as "still active elsewhere" and locked them out with a
  // false "Concurrency Lock" for up to 2 minutes, mid-exam, through no fault
  // of their own.
  sessionToken: string | null;

  // Actions
  login: (candidate: Candidate, sessionToken?: string | null) => void;
  logout: () => void;
  setQuestions: (questions: Question[]) => void;
  setCurrentQuestionIndex: (index: number) => void;
  setAnswer: (questionId: string, answer: any) => void;
  setFullscreen: (val: boolean) => void;
  incrementLookingAwayWarning: () => void;
  incrementOtherWarning: () => void;
  setMediaStream: (stream: MediaStream | null) => void;
}

export const useExamStore = create<ExamState>()(
  persist(
    (set) => ({
      candidate: null,
      isAuthenticated: false,
      questions: [],
      currentQuestionIndex: 0,
      answers: {},
      isFullscreen: false,
      cheatWarnings: 0,
      lookingAwayWarnings: 0,
      otherWarnings: 0,
      mediaStream: null,
      sessionToken: null,

      login: (candidate, sessionToken) => {
        set({ candidate, isAuthenticated: true, sessionToken: sessionToken ?? null });
      },

      logout: () => set((state) => {
        // Belt-and-suspenders: the dashboard already stops its own tracks before
        // calling logout(), but a stream must never outlive the session it was
        // granted for -- stopping it again here is a harmless no-op if already
        // stopped, and a real cleanup if some other exit path forgot to.
        state.mediaStream?.getTracks().forEach((t) => t.stop());
        return {
          candidate: null,
          isAuthenticated: false,
          answers: {},
          currentQuestionIndex: 0,
          cheatWarnings: 0,
          lookingAwayWarnings: 0,
          otherWarnings: 0,
          questions: [],
          mediaStream: null,
          sessionToken: null,
        };
      }),

      setQuestions: (questions) => set({ questions }),
      setCurrentQuestionIndex: (index) => set({ currentQuestionIndex: index }),
      setAnswer: (questionId, answer) =>
        set((state) => ({
          answers: { ...state.answers, [questionId]: answer }
        })),
      setFullscreen: (val) => set({ isFullscreen: val }),
      incrementLookingAwayWarning: () => set((state) => {
        const lookingAwayWarnings = state.lookingAwayWarnings + 1;
        return { lookingAwayWarnings, cheatWarnings: lookingAwayWarnings + state.otherWarnings };
      }),
      incrementOtherWarning: () => set((state) => {
        const otherWarnings = state.otherWarnings + 1;
        return { otherWarnings, cheatWarnings: state.lookingAwayWarnings + otherWarnings };
      }),
      setMediaStream: (stream) => set({ mediaStream: stream }),
    }),
    {
      // Deliberately minimal: only identity + the reconnect token survive a
      // reload. Answers/warnings/questions stay in-memory-only and are
      // rehydrated from the server (the source of truth) via useExamSync's
      // initial fetch -- this isn't meant to be a full offline-resume cache,
      // just enough for a reloaded /exam login attempt to prove "this is the
      // same browser" instead of being wrongly treated as a second device.
      name: "naprocs-exam-identity",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ candidate: state.candidate, sessionToken: state.sessionToken }),
    }
  )
);
