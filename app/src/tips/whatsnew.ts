// Static changelog for the Tips sheet, newest first. Text lives in strings2.ts (tips.new.<id>.* keys).
import type { WhatsNewItem } from './types';

export const WHATS_NEW: WhatsNewItem[] = [
  { date: '2026-10-18', titleKey: 'tips.new.tips.title', bodyKey: 'tips.new.tips.body' },
  { date: '2026-10-18', titleKey: 'tips.new.modelload.title', bodyKey: 'tips.new.modelload.body' },
  { date: '2026-10-18', titleKey: 'tips.new.slash.title', bodyKey: 'tips.new.slash.body' },
  { date: '2026-10-18', titleKey: 'tips.new.animation.title', bodyKey: 'tips.new.animation.body' },
  { date: '2026-10-17', titleKey: 'tips.new.themes.title', bodyKey: 'tips.new.themes.body' },
  { date: '2026-10-17', titleKey: 'tips.new.dsh.title', bodyKey: 'tips.new.dsh.body' },
  { date: '2026-10-17', titleKey: 'tips.new.ephemeral.title', bodyKey: 'tips.new.ephemeral.body' },
  { date: '2026-10-17', titleKey: 'tips.new.artifacts.title', bodyKey: 'tips.new.artifacts.body' },
];
