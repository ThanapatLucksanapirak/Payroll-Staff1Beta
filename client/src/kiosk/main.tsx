import { createRoot } from "react-dom/client";
import { KioskApp } from "./KioskApp";
import "./kiosk.css";

createRoot(document.getElementById("root")!).render(<KioskApp />);
