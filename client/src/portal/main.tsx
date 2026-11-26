import { createRoot } from "react-dom/client";
import { PortalApp } from "./PortalApp";
import "./portal.css";
import { disableZoom } from "../lib/noZoom";
import { registerServiceWorker } from "../lib/pwa";

disableZoom();
createRoot(document.getElementById("root")!).render(<PortalApp />);
registerServiceWorker();
