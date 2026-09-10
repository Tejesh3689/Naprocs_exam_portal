import { create } from 'zustand';

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

  // Actions
  login: (candidate: Candidate) => void;
  logout: () => void;
  setQuestions: (questions: Question[]) => void;
  setCurrentQuestionIndex: (index: number) => void;
  setAnswer: (questionId: string, answer: any) => void;
  setFullscreen: (val: boolean) => void;
  incrementLookingAwayWarning: () => void;
  incrementOtherWarning: () => void;
  setMediaStream: (stream: MediaStream | null) => void;
}

export const useExamStore = create<ExamState>((set) => ({
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

  login: (candidate) => {
    set({ candidate, isAuthenticated: true });
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
}));
