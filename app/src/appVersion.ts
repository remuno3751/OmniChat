import appJson from '../app.json';

/** App version from app.json (expo.version). Used to decide whether an APK update is newer than this build. */
export const APP_VERSION: string = appJson.expo.version;
