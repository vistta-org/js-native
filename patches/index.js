export {
  patchAndroidManifest,
  patchAndroidStrings,
  patchAppGradle,
  patchBuildTask,
  patchMainActivity,
  patchVisttaNetwork,
  patchVisttaService,
} from "./android.js";
export { patchCapabilities } from "./capabilities.js";
export { mergeConfig } from "./config.js";
export { patchCargoToml, patchLibRs, patchMainRs } from "./rust.js";
