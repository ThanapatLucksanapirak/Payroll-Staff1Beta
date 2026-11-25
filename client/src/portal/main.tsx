import { createRoot } from "react-dom/client";
import { PortalApp } from "./PortalApp";
import "./portal.css";
import { registerServiceWorker } from "../lib/pwa";

createRoot(document.getElementById("root")!).render(<PortalApp />);
registerServiceWorker();
