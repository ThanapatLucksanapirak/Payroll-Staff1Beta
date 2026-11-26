// App-like behaviour on phones and tablets: no pinch or double-tap zoom.
//
// iOS Safari ignores user-scalable=no in the viewport tag, so zooming is also
// stopped here: the gesture* events (pinch on iOS) and touchmove with two or
// more fingers (pinch elsewhere). The listeners must be non-passive so
// preventDefault() works. Double-tap zoom is turned off with CSS
// touch-action: manipulation on the page (see index.css, kiosk.css,
// portal.css), and form fields are at least 16px on touch screens so iOS
// doesn't zoom in when one is focused.
export function disableZoom() {
  if (typeof document === "undefined") return;
  const stop = (e: Event) => { if (e.cancelable) e.preventDefault(); };
  const opts: AddEventListenerOptions = { passive: false };
  document.addEventListener("gesturestart", stop, opts);
  document.addEventListener("gesturechange", stop, opts);
  document.addEventListener("gestureend", stop, opts);
  document.addEventListener("touchmove", (e) => { if (e.touches.length > 1) stop(e); }, opts);
}
