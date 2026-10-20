import { useSyncExternalStore } from 'react';
import type { ModelConflictInfo, ModelLoadProgress } from './modelLoad';

/* ---------- conflict dialog state (error frames model_conflict / model_load_failed) ---------- */
export interface ConflictPrompt { kind: 'send' | 'regenerate'; conversationId: string; conflict: ModelConflictInfo; error?: string }
let prompt: ConflictPrompt | null = null;
const promptSubs = new Set<() => void>();
export function getPrompt(): ConflictPrompt | null { return prompt; }
export function setPrompt(p: ConflictPrompt | null): void { prompt = p; promptSubs.forEach((f) => f()); }
export function usePrompt(): ConflictPrompt | null {
  return useSyncExternalStore((l) => { promptSubs.add(l); return () => { promptSubs.delete(l); }; }, () => prompt);
}

/* ---------- load progress (model_load frames, shown above the composer) ---------- */
let progress: ModelLoadProgress | null = null;
const progressSubs = new Set<() => void>();
export function getProgress(): ModelLoadProgress | null { return progress; }
export function setProgress(p: ModelLoadProgress | null): void { progress = p; progressSubs.forEach((f) => f()); }
export function useProgress(): ModelLoadProgress | null {
  return useSyncExternalStore((l) => { progressSubs.add(l); return () => { progressSubs.delete(l); }; }, () => progress);
}
