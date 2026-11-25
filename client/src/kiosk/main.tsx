import { createRoot } from "react-dom/client";
import { KioskApp } from "./KioskApp";
import "./kiosk.css";
import { registerServiceWorker } from "../lib/pwa";

createRoot(document.getElementById("root")!).render(<KioskApp />);
registerServiceWorker();
