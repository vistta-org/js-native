export {
  patchAlarmReceiver,
  patchAndroidManifest,
  patchAndroidSigning,
  patchAndroidStrings,
  patchApplicationIdSuffix,
  patchBuildTask,
  patchForegroundService,
  patchMainActivity,
} from "./android.js";
export { patchCapabilities } from "./capabilities.js";
export { mergeConfig } from "./config.js";
export { patchCargoToml, patchLibRs, patchMainRs } from "./rust.js";
