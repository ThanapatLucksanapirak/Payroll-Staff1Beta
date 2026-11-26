import { createRoot } from "react-dom/client";
import { KioskApp } from "./KioskApp";
import "./kiosk.css";
import { disableZoom } from "../lib/noZoom";
import { registerServiceWorker } from "../lib/pwa";
import { noteAndroidApp } from "./appDownload";

noteAndroidApp();
disableZoom();
createRoot(document.getElementById("root")!).render(<KioskApp />);
registerServiceWorker();
