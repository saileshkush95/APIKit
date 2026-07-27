import { useMemo } from "react";
import { Joyride, STATUS, type EventData, type Step } from "react-joyride";
import { useOnboarding } from "../../shared/state/onboarding";

/**
 * Steps are matched to elements by `data-tour`. Anything not on screen right
 * now is dropped rather than pointing the tour at nothing.
 */
const STEPS: Step[] = [
  {
    target: '[data-tour="nav"]',
    title: "Everything lives here",
    content:
      "Client for sending requests, Runner for whole collections, Load for stress tests, Monitor for scheduled checks, Mock for canned responses, Proxy to intercept traffic, and Sync to share with your team.",
    placement: "right",
  },
  {
    target: '[data-tour="collection"]',
    title: "Your collection",
    content:
      "Organise requests into folders, nested as deep as you like. Drag to rearrange, right-click for more, and use ↓ to import an OpenAPI spec or Postman collection.",
    placement: "right",
  },
  {
    target: '[data-tour="urlbar"]',
    title: "Build a request",
    content:
      "Choose a protocol, pick a method and type a URL. Variables written as {{name}} are filled in from the active environment, and ⌘↵ sends it.",
    placement: "bottom",
  },
  {
    target: '[data-tour="request-tabs"]',
    title: "Params, auth, body — and more",
    content:
      "Query params, authorization, headers and body. Scripts run before and after the request, Tests assert on the response, and Docs and Comments are shared with everyone syncing this workspace.",
    placement: "bottom",
  },
  {
    target: '[data-tour="environments"]',
    title: "Environments",
    content:
      "Swap between staging and production without editing a request. Mark a variable secret and its value stays on this machine — never synced, never exported.",
    placement: "bottom",
  },
  {
    target: '[data-tour="workspace"]',
    title: "Workspaces",
    content:
      "Each workspace has its own collection, environments, mocks and monitors. Switch or create them here.",
    placement: "bottom",
  },
];

export function Tour() {
  const { tourRunning, stopTour } = useOnboarding();

  // Resolved when the tour starts, so a hidden panel cannot strand it.
  const steps = useMemo(() => {
    if (!tourRunning) return [];
    return STEPS.filter((step) =>
      document.querySelector(step.target as string),
    );
  }, [tourRunning]);

  function onEvent({ status }: EventData) {
    if (status === STATUS.FINISHED || status === STATUS.SKIPPED) {
      stopTour();
    }
  }

  if (!tourRunning || steps.length === 0) return null;

  return (
    <Joyride
      steps={steps}
      run
      continuous
      scrollToFirstStep={false}
      onEvent={onEvent}
      locale={{
        back: "Back",
        close: "Close",
        last: "Done",
        next: "Next",
        skip: "Skip",
      }}
      // Theme tokens, so the tour follows light/dark and the accent colour.
      options={{
        arrowColor: "var(--color-panel)",
        backgroundColor: "var(--color-panel)",
        primaryColor: "var(--color-brand)",
        textColor: "var(--color-ink)",
        overlayColor: "rgba(0, 0, 0, 0.6)",
        spotlightRadius: 6,
        skipBeacon: true,
        showProgress: true,
        buttons: ["back", "primary", "skip"],
        // Clicking the dimmed area should not abandon the tour by accident.
        overlayClickAction: false,
        zIndex: 90,
      }}
      styles={{
        tooltip: { borderRadius: 8, fontSize: 13, padding: 16 },
        tooltipTitle: { fontSize: 14, fontWeight: 600, margin: 0 },
        tooltipContent: {
          padding: "8px 0 0",
          lineHeight: 1.6,
          color: "var(--color-muted)",
        },
        buttonPrimary: {
          borderRadius: 6,
          fontSize: 12,
          fontWeight: 600,
          padding: "6px 14px",
        },
        buttonBack: { color: "var(--color-muted)", fontSize: 12 },
        buttonSkip: { color: "var(--color-muted)", fontSize: 12 },
      }}
    />
  );
}
