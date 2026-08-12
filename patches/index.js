export {
  patchAndroidManifest,
  patchAndroidStrings,
  patchAppGradleSigning,
  patchBuildTask,
  patchMainActivity,
} from "./android.js";
export { patchCapabilities } from "./capabilities.js";
export { mergeConfig } from "./config.js";
export { patchCargoToml, patchLibRs, patchMainRs } from "./rust.js";
