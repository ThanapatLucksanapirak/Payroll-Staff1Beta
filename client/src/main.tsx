import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { disableZoom } from "./lib/noZoom";
import { registerServiceWorker } from "./lib/pwa";

if (!window.location.hash) window.location.hash = "#/";
disableZoom();
createRoot(document.getElementById("root")!).render(<App />);
registerServiceWorker();
