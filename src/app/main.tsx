import React from "react";
import ReactDOM from "react-dom/client";
import { useSettings } from "../shared/state/settings";
import { useTheme } from "../shared/state/theme";
import App from "./App";

// Appearance is applied before the first render, not in an effect: the splash
// screen paints while the workspace is still opening, and an effect would run
// too late — it would flash the default dark theme and the default accent
// before switching. Both stores read their values synchronously from
// localStorage, so this costs nothing.
useSettings.getState().init();
useTheme.getState().init();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
