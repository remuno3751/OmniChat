/**
 * One table declaring every setting: where it is stored ('device' = AsyncStorage via deviceSettings.ts,
 * 'synced' = the server /settings doc), which settings page shows it, and its label key (see i18n).
 */

export type SettingsPageId = 'general' | 'appearance' | 'models' | 'chat' | 'code' | 'voice' | 'plugins' | 'updates' | 'connections' | 'server' | 'developer';

export interface SettingMeta {
  scope: 'device' | 'synced';
  page: SettingsPageId;
  labelKey: string;
}

export const SETTINGS_META: Record<string, SettingMeta> = {
  // device (per device, not synced)
  language: { scope: 'device', page: 'general', labelKey: 'appearance.language' },
  theme: { scope: 'device', page: 'appearance', labelKey: 'appearance.theme' },
  themeId: { scope: 'device', page: 'appearance', labelKey: 'appearance.themeId' },
  decorations: { scope: 'device', page: 'appearance', labelKey: 'appearance.decorations' },
  codeScheme: { scope: 'device', page: 'appearance', labelKey: 'appearance.codeScheme' },
  fontSize: { scope: 'device', page: 'appearance', labelKey: 'appearance.fontSize' },
  messageWidth: { scope: 'device', page: 'appearance', labelKey: 'appearance.messageWidth' },
  'pets.enabled': { scope: 'device', page: 'appearance', labelKey: 'pets.enabled' },
  'pets.petId': { scope: 'device', page: 'appearance', labelKey: 'label.pets.petId' },
  'pets.size': { scope: 'device', page: 'appearance', labelKey: 'pets.size' },
  'pets.activity': { scope: 'device', page: 'appearance', labelKey: 'pets.activity' },
  'pets.clickThrough': { scope: 'device', page: 'appearance', labelKey: 'label.pets.clickThrough' },
  modelLogosOnline: { scope: 'device', page: 'appearance', labelKey: 'appearance.modelLogosOnline' },
  'dsh.enabled': { scope: 'device', page: 'plugins', labelKey: 'integ.dsh.set.enabled' },
  'dsh.port': { scope: 'device', page: 'plugins', labelKey: 'integ.dsh.set.port' },
  'dsh.pairing': { scope: 'device', page: 'plugins', labelKey: 'integ.dsh.set.pairing' },
  'dsh.bridgeName': { scope: 'device', page: 'plugins', labelKey: 'integ.dsh.set.bridgeName' },
  ephemeralBannerSeen: { scope: 'device', page: 'chat', labelKey: 'eph.bannerTitle' },
  modelLoadPolicy: { scope: 'device', page: 'chat', labelKey: 'modelload.settings.title' },
  'voice.url': { scope: 'device', page: 'voice', labelKey: 'voice.set.url' },
  'voice.user': { scope: 'device', page: 'voice', labelKey: 'voice.set.user' },
  'voice.token': { scope: 'device', page: 'voice', labelKey: 'voice.set.token' },
  'voice.ttsMode': { scope: 'device', page: 'voice', labelKey: 'voice.set.ttsMode' },
  'voice.speed': { scope: 'device', page: 'voice', labelKey: 'voice.set.speed' },
  'voice.pauseScale': { scope: 'device', page: 'voice', labelKey: 'voice.set.pauseScale' },
  'voice.responseDelayMs': { scope: 'device', page: 'voice', labelKey: 'voice.set.responseDelayMs' },
  'voice.endOfTurnMs': { scope: 'device', page: 'voice', labelKey: 'voice.set.endOfTurnMs' },
  'voice.bargeIn': { scope: 'device', page: 'voice', labelKey: 'voice.set.bargeIn' },
  'voice.bargeInDb': { scope: 'device', page: 'voice', labelKey: 'voice.set.bargeInDb' },
  'voice.voice': { scope: 'device', page: 'voice', labelKey: 'voice.set.voice' },

  // synced (server /settings)
  systemPrompt: { scope: 'synced', page: 'chat', labelKey: 'label.systemPrompt' },
  effort: { scope: 'synced', page: 'models', labelKey: 'label.effort' },
  params: { scope: 'synced', page: 'models', labelKey: 'label.params' },
  devMode: { scope: 'synced', page: 'developer', labelKey: 'label.devMode' },
  tools: { scope: 'synced', page: 'plugins', labelKey: 'code.tools' },
  searchMode: { scope: 'synced', page: 'chat', labelKey: 'label.searchMode' },
  autoTitle: { scope: 'synced', page: 'chat', labelKey: 'label.autoTitle' },
  titleEvery: { scope: 'synced', page: 'chat', labelKey: 'settings.titleEvery' },
  titleModel: { scope: 'synced', page: 'chat', labelKey: 'label.titleModel' },
  modelParams: { scope: 'synced', page: 'models', labelKey: 'label.modelParams' },
  contextOverflow: { scope: 'synced', page: 'models', labelKey: 'label.contextOverflow' },
  contextLimits: { scope: 'synced', page: 'models', labelKey: 'label.contextLimits' },
  contextCompressAt: { scope: 'synced', page: 'models', labelKey: 'label.contextCompressAt' },
  contextCompressTarget: { scope: 'synced', page: 'models', labelKey: 'label.contextCompressTarget' },
  defaultContextLength: { scope: 'synced', page: 'models', labelKey: 'label.defaultContextLength' },
  notify: { scope: 'synced', page: 'code', labelKey: 'code.notify' },
  notifyUrl: { scope: 'synced', page: 'code', labelKey: 'code.notifyUrl' },
  activePetId: { scope: 'synced', page: 'appearance', labelKey: 'label.activePetId' },
  // Updates page: one searchable entry (the page has no stored setting of its own)
  updatesPage: { scope: 'device', page: 'updates', labelKey: 'settings.page.updates.desc' },
  ephemeralIdleMinutes: { scope: 'synced', page: 'chat', labelKey: 'eph.settings.idle' },
};

export interface SettingsPage {
  id: SettingsPageId;
  titleKey: string;
}

export const SETTINGS_PAGES: SettingsPage[] = [
  { id: 'general', titleKey: 'settings.page.general' },
  { id: 'appearance', titleKey: 'settings.page.appearance' },
  { id: 'models', titleKey: 'settings.page.models' },
  { id: 'chat', titleKey: 'settings.page.chat' },
  { id: 'code', titleKey: 'settings.page.code' },
  { id: 'voice', titleKey: 'settings.page.voice' },
  { id: 'plugins', titleKey: 'settings.page.plugins' },
  { id: 'updates', titleKey: 'settings.page.updates' },
  { id: 'connections', titleKey: 'settings.page.connections' },
  { id: 'developer', titleKey: 'settings.page.developer' },
];
