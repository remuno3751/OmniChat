import type { ThemeId } from '../deviceSettings';
import { frontier } from './frontier';
import { astral } from './astral';
import { simple } from './simple';
import type { ThemeDef } from './types';

export type { Palette, ThemeDef, RadiusScale } from './types';

export const THEMES: Record<ThemeId, ThemeDef> = { simple, frontier, astral };
export const THEME_IDS: ThemeId[] = ['simple', 'frontier', 'astral'];
