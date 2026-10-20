import React from 'react';
import { MaterialIcons } from '@expo/vector-icons';
import { useTheme } from '../theme';

/**
 * App icons. Components ask for a semantic name (`copy`, `regenerate`, ...);
 * the map picks the Material glyph. To switch to another icon set later
 * (e.g. Icooon-mono), change only this map and the component.
 */
const MAP = {
  copy: 'content-copy',
  regenerate: 'refresh',
  edit: 'edit',
  branch: 'call-split',
  more: 'more-horiz',
  settings: 'settings',
  back: 'arrow-back',
  close: 'close',
  check: 'check',
  chevronLeft: 'chevron-left',
  chevronRight: 'chevron-right',
  expand: 'keyboard-arrow-down',
  collapse: 'keyboard-arrow-up',
  search: 'search',
  refresh: 'refresh',
  pin: 'push-pin',
  add: 'add',
  menu: 'menu',
  stop: 'stop',
  send: 'send',
  web: 'language',
  tool: 'build',
  time: 'schedule',
  link: 'link',
  warning: 'warning',
  error: 'error-outline',
  filter: 'tune',
  star: 'star',
  docMarkdown: 'article',
  docHtml: 'code',
  docWord: 'description',
  docSlides: 'slideshow',
  docSheet: 'table-chart',
  docMail: 'mail-outline',
  download: 'file-download',
  openPanel: 'vertical-split',
  preview: 'visibility',
  source: 'code',
  modeChat: 'chat-bubble-outline',
  modeCode: 'terminal',
  newProject: 'create-new-folder',
  newChat: 'add-comment',
  diff: 'difference',
  agent: 'smart-toy',
  folder: 'folder-open',
  history: 'history',
  ephemeral: 'visibility-off',
  tips: 'lightbulb-outline',
  lock: 'lock-outline',
} as const;

export type IconName = keyof typeof MAP;

export default function Icon({ name, size = 18, color }: { name: IconName; size?: number; color?: string }) {
  const t = useTheme();
  return <MaterialIcons name={MAP[name]} size={size} color={color ?? t.text} />;
}
