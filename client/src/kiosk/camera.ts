// Front-camera snapshots for "photo on punch". The camera starts when the
// employee reaches the action screen (so it has warmed up by the time they
// tap), and a small JPEG is grabbed at the moment of the punch.
//
// When photos are on, a punch needs a photo with a face in it: if the camera
// is blocked, missing or covered, or no face is seen, the kiosk says so and
// the punch isn't sent (see capture()). After a couple of tries without a face
// the kiosk offers to punch anyway: the photo is still taken and the punch is
// flagged "no face" for the manager (capture({ allowNoFace: true })), so
// nobody is locked out but a covered camera never goes unnoticed. A blocked or
// missing camera still stops the punch: a manager can add it on Live, or turn
// photos off for the device.
import { useCallback, useEffect, useRef, useState } from "react";
import { FACE_MESSAGES, checkFace, loadFaceDetector } from "./face";

const WIDTH = 320;
const QUALITY = 0.6;

/** off: not running · starting · ready · blocked: permission denied · unavailable: no camera / not https / failed */
export type CameraStatus = "off" | "starting" | "ready" | "blocked" | "unavailable";

/** face: "seen" when a face was found, "missing" for a punch the employee sent anyway without one. */
export type Capture =
  | { ok: true; photo: string; face: "seen" | "missing" }
  | { ok: false; message: string; /** true when the camera works but no face was found (the punch may be sent anyway) */ noFace: boolean };

export const CAMERA_MESSAGES = {
  blocked: "Camera blocked. This time clock needs the camera to take your photo. Ask a manager to allow camera access for this page.",
  unavailable: "Camera not available. This time clock needs a working camera to take your photo. Ask a manager.",
  starting: "The camera is starting. Wait a moment and try again.",
} as const;

export function useCamera(active: boolean) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [status, setStatus] = useState<CameraStatus>("off");
  /** Live hint for the preview: is a face in view right now? (null = not known yet) */
  const [faceSeen, setFaceSeen] = useState<boolean | null>(null);

  useEffect(() => {
    if (!active) { setStatus("off"); setFaceSeen(null); return; }
    void loadFaceDetector(); // warm up while the camera starts
    const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    if (!md?.getUserMedia) { setStatus("unavailable"); return; }
    let cancelled = false;
    setStatus("starting");
    md.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false })
      .then((stream) => {
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        // A camera unplugged or taken by another app ends the track.
        for (const t of stream.getVideoTracks()) t.addEventListener("ended", () => { if (!cancelled) setStatus("unavailable"); });
        const v = videoRef.current;
        if (v) {
          v.srcObject = stream;
          v.muted = true;
          v.playsInline = true;
          void v.play().catch(() => undefined);
        }
        setStatus("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const name = (err as { name?: string } | null)?.name;
        setStatus(name === "NotAllowedError" || name === "SecurityError" ? "blocked" : "unavailable");
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

  // Live "face found" hint while the camera runs.
  useEffect(() => {
    if (status !== "ready") { setFaceSeen(null); return; }
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const c = frame();
      if (c) { const r = await checkFace(c); if (!stop) setFaceSeen(r.ok); }
      if (!stop) timer = setTimeout(tick, 700);
    };
    timer = setTimeout(tick, 300);
    return () => { stop = true; if (timer) clearTimeout(timer); };
  }, [status, frame]);

  /**
   * Take the punch photo: a small JPEG of the current frame, only if the camera
   * works and a face is in it. Otherwise a message saying why (the punch must
   * not be sent). With allowNoFace, a working camera's frame is returned even
   * without a face, marked face: "missing".
   */
  const capture = useCallback(async (opts?: { allowNoFace?: boolean }): Promise<Capture> => {
    const fail = (message: string, noFace = false): Capture => ({ ok: false, message, noFace });
    if (status === "blocked") return fail(CAMERA_MESSAGES.blocked);
    if (status === "unavailable" || status === "off") return fail(CAMERA_MESSAGES.unavailable);
    if (status === "starting") return fail(CAMERA_MESSAGES.starting);
    const canvas = frame();
    if (!canvas) return fail(FACE_MESSAGES.no_frame);
    const jpeg = (c: HTMLCanvasElement): string | null => {
      try {
        const url = c.toDataURL("image/jpeg", QUALITY);
        return url.startsWith("data:image/jpeg") ? url : null;
      } catch {
        return null;
      }
    };
    const face = await checkFace(canvas);
    let missing: "no_face" | "covered" | "unchecked" | null = face.ok ? null : face.reason === "no_frame" ? null : face.reason;
    if (!face.ok && !missing) return fail(FACE_MESSAGES.no_frame);
    if (!missing) {
      // Confirm on a second frame a moment later, so one lucky frame isn't enough.
      await new Promise((r) => setTimeout(r, 150));
      const again = frame();
      const second = again ? await checkFace(again) : ({ ok: false, reason: "no_frame" } as const);
      if (!second.ok) {
        if (second.reason === "no_frame") return fail(FACE_MESSAGES.no_frame);
        missing = second.reason;
      }
    }
    if (missing && !opts?.allowNoFace) return fail(FACE_MESSAGES[missing], true);
    const photo = jpeg(canvas);
    if (!photo) return fail(FACE_MESSAGES.no_frame);
    return { ok: true, photo, face: missing ? "missing" : "seen" };
  }, [status, frame]);

  return { status, faceSeen, attach, capture };
}
