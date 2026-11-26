// Front-camera snapshots for "photo on punch". The camera starts when the
// employee reaches the action screen (so it has warmed up by the time they
// tap), and a small JPEG is grabbed at the moment of the punch.
//
// When photos are on, a punch needs a photo with a face in it. A blocked,
// missing or covered camera is caught here; whether a face is in the photo is
// decided by the server when the punch arrives (server/faceCheck.ts), which
// refuses it with a message the kiosk shows. There is no way to punch without
// a face: a manager can add the punch on Live, or turn photos off for the device.
import { useCallback, useEffect, useRef, useState } from "react";
import { FACE_MESSAGES, checkFrame } from "./face";

const WIDTH = 320;
const QUALITY = 0.6;

/** off: not running · starting · ready · blocked: permission denied · unavailable: no camera / not https / failed */
export type CameraStatus = "off" | "starting" | "ready" | "blocked" | "unavailable";

export type Capture = { ok: true; photo: string } | { ok: false; message: string };

export const CAMERA_MESSAGES = {
  blocked: "Camera blocked. This time clock needs the camera to take your photo. Ask a manager to allow camera access for this page.",
  unavailable: "Camera not available. This time clock needs a working camera to take your photo. Ask a manager.",
  starting: "The camera is starting. Wait a moment and try again.",
} as const;

/** True when the browser reports camera permission as denied for this page. */
async function cameraDenied(): Promise<boolean> {
  try {
    const st = await navigator.permissions?.query({ name: "camera" as PermissionName });
    return st?.state === "denied";
  } catch {
    return false; // Safari and older browsers can't be asked about the camera
  }
}

export function useCamera(active: boolean) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [status, setStatus] = useState<CameraStatus>("off");
  /** Live hint for the preview: is a face in view right now? (null = not known yet) */
  const [faceSeen, setFaceSeen] = useState<boolean | null>(null);

  useEffect(() => {
    if (!active) { setStatus("off"); setFaceSeen(null); return; }
    const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    if (!md?.getUserMedia) { setStatus("unavailable"); return; }
    let cancelled = false;
    setStatus("starting");
    md.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false })
      .then((stream) => {
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        // A camera unplugged or taken by another app ends the track.
        // A camera that stops mid-session because access was taken away reads as
        // "blocked" (a manager can fix it), not "not available".
        for (const t of stream.getVideoTracks()) t.addEventListener("ended", () => { void cameraDenied().then((denied) => { if (!cancelled) setStatus(denied ? "blocked" : "unavailable"); }); });
        const v = videoRef.current;
        if (v) {
          v.srcObject = stream;
          v.muted = true;
          v.playsInline = true;
          void v.play().catch(() => undefined);
        }
        setStatus("ready");
      })
      .catch(async (err: unknown) => {
        if (cancelled) return;
        const name = (err as { name?: string } | null)?.name;
        // Browsers don't all say "not allowed" when the camera was denied (an
        // Android app without camera permission, a dismissed prompt): ask the
        // permission state too, so a denied camera always reads as "blocked".
        const denied = name === "NotAllowedError" || name === "SecurityError" || (await cameraDenied());
        if (!cancelled) setStatus(denied ? "blocked" : "unavailable");
      });
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [active]);

  // The <video> may mount after the stream arrived.
  const attach = useCallback((el: HTMLVideoElement | null) => {
    videoRef.current = el;
    if (el && streamRef.current && el.srcObject !== streamRef.current) {
      el.srcObject = streamRef.current;
      el.muted = true;
      el.playsInline = true;
      void el.play().catch(() => undefined);
    }
  }, []);

  /** The current frame on a small canvas, or null when there is none. */
  const frame = useCallback((): HTMLCanvasElement | null => {
    try {
      const v = videoRef.current;
      if (!v || !streamRef.current || !v.videoWidth || !v.videoHeight) return null;
      const scale = WIDTH / v.videoWidth;
      const canvas = document.createElement("canvas");
      canvas.width = WIDTH;
      canvas.height = Math.round(v.videoHeight * scale);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      return canvas;
    } catch {
      return null;
    }
  }, []);

  // Live hint while the camera runs: red when the lens looks covered (false), otherwise unknown (null).
  // Whether a face is in the photo is only known once the server checks it.
  useEffect(() => {
    if (status !== "ready") { setFaceSeen(null); return; }
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const c = frame();
      if (c && !stop) setFaceSeen(checkFrame(c).ok ? null : false);
      if (!stop) timer = setTimeout(tick, 700);
    };
    timer = setTimeout(tick, 300);
    return () => { stop = true; if (timer) clearTimeout(timer); };
  }, [status, frame]);

  /**
   * Take the punch photo: a small JPEG of the current frame, if the camera works
   * and the lens isn't covered. Otherwise a message saying why (the punch must
   * not be sent). The server then checks the photo for a face.
   */
  const capture = useCallback(async (): Promise<Capture> => {
    if (status === "blocked") return { ok: false, message: CAMERA_MESSAGES.blocked };
    if (status === "unavailable" || status === "off") return { ok: false, message: CAMERA_MESSAGES.unavailable };
    if (status === "starting") return { ok: false, message: CAMERA_MESSAGES.starting };
    const canvas = frame();
    if (!canvas) return { ok: false, message: FACE_MESSAGES.no_frame };
    const look = checkFrame(canvas);
    if (!look.ok) return { ok: false, message: FACE_MESSAGES[look.reason] };
    try {
      const url = canvas.toDataURL("image/jpeg", QUALITY);
      return url.startsWith("data:image/jpeg") ? { ok: true, photo: url } : { ok: false, message: FACE_MESSAGES.no_frame };
    } catch {
      return { ok: false, message: FACE_MESSAGES.no_frame };
    }
  }, [status, frame]);

  return { status, faceSeen, attach, capture };
}
