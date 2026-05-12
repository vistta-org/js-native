// Unified camera integration for Capacitor (app), Electron (desktop), and web.

// @ts-ignore
/** @typedef {import("@capacitor/camera").Photo} Photo */

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function pickFile({ accept = "image/*", capture = "" } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    if (capture) input.capture = capture;
    input.style.position = "fixed";
    input.style.left = "-9999px";
    document.body.appendChild(input);
    input.addEventListener("change", () => {
      const file = input.files && input.files[0];
      document.body.removeChild(input);
      resolve(file || null);
    });
    input.click();
  });
}

/**
 * Take a photo.
 * - On Capacitor (`window.platform === "mobile"`) uses the native Camera.
 * - On desktop (`window.platform === "desktop"`) attempts getUserMedia then falls back to file picker.
 * - On web falls back to file picker.
 * @param {object} [options]
 * @returns {Promise<any>} Platform-dependent result (Capacitor Photo or File/DataURL wrapper)
 */
export async function takePhoto(options) {
  if (typeof window === "undefined") throw new Error("takePhoto() requires a browser environment");

  if (window.platform === "mobile") {
    // @ts-ignore
    const { Camera, CameraResultType } = await import("@capacitor/camera");
    return Camera.getPhoto({ resultType: CameraResultType.Uri, ...options });
  }

  if (window.platform === "desktop") {
    try {
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        const track = stream.getVideoTracks()[0];
        if (typeof ImageCapture !== "undefined") {
          const ic = new ImageCapture(track);
          try {
            const blob = await ic.takePhoto();
            stream.getTracks().forEach((t) => t.stop());
            const dataUrl = await blobToDataURL(blob);
            return { dataUrl, blob };
          } catch {
            stream.getTracks().forEach((t) => t.stop());
          }
        } else {
          const video = document.createElement("video");
          video.autoplay = true;
          video.srcObject = stream;
          await new Promise((r) => (video.onloadedmetadata = r));
          const canvas = document.createElement("canvas");
          canvas.width = video.videoWidth || 640;
          canvas.height = video.videoHeight || 480;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          stream.getTracks().forEach((t) => t.stop());
          const dataUrl = canvas.toDataURL("image/png");
          return { dataUrl };
        }
      }
    } catch {
      // Do Nothing
    }
    const file = await pickFile({ accept: "image/*", capture: "environment" });
    return file;
  }
  const file = await pickFile({ accept: "image/*" });
  return file;
}

/**
 * Pick an image from gallery/files.
 * Works across app/desktop/web; app uses Capacitor gallery, others use file picker.
 * @param {object} [options]
 */
export async function pickImage(options) {
  if (typeof window === "undefined") throw new Error("pickImage() requires a browser environment");

  if (window.platform === "mobile") {
    // @ts-ignore
    const { Camera, CameraResultType, CameraSource } = await import("@capacitor/camera");
    return Camera.getPhoto({ resultType: CameraResultType.Uri, source: CameraSource.Photos, ...options });
  }

  const file = await pickFile({ accept: "image/*" });
  return file;
}

export default { takePhoto, pickImage };
