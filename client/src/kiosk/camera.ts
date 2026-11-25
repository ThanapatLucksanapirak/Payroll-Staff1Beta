// Front-camera snapshots for "photo on punch". The camera starts when the
// employee reaches the action screen (so it has warmed up by the time they
// tap), and a small JPEG is grabbed at the moment of the punch. Anything that
// goes wrong (no camera, permission denied, insecure page, not ready yet)
// simply means "no photo": the punch itself never waits on the camera.
import { useCallback, useEffect, useRef, useState } from "react";

const WIDTH = 320;
const QUALITY = 0.6;

export type CameraStatus = "off" | "starting" | "ready" | "unavailable";

export function useCamera(active: boolean) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [status, setStatus] = useState<CameraStatus>("off");

  useEffect(() => {
    if (!active) { setStatus("off"); return; }
    const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    if (!md?.getUserMedia) { setStatus("unavailable"); return; }
    let cancelled = false;
    setStatus("starting");
    md.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false })
      .then((stream) => {
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        const v = videoRef.current;
        if (v) {
          v.srcObject = stream;
          v.muted = true;
          v.playsInline = true;
          void v.play().catch(() => undefined);
        }
        setStatus("ready");
      })
      .catch(() => { if (!cancelled) setStatus("unavailable"); });
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

  /** A small JPEG data URL of the current frame, or null when there is none. */
  const snapshot = useCallback((): string | null => {
    try {
      const v = videoRef.current;
      if (!v || !streamRef.current || !v.videoWidth || !v.videoHeight) return null;
      const scale = WIDTH / v.videoWidth;
      const canvas = document.createElement("canvas");
      canvas.width = WIDTH;
      canvas.height = Math.round(v.videoHeight * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      const url = canvas.toDataURL("image/jpeg", QUALITY);
      return url.startsWith("data:image/jpeg") ? url : null;
    } catch {
      return null;
    }
  }, []);

  return { status, attach, snapshot };
}
