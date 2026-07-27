import { LogoMark } from "../../shared/components/Logo";
import { useOnboarding } from "../../shared/state/onboarding";

interface Props {
  /** Jumps straight into the thing the card describes. */
  onCreateRequest: () => void;
  onImport: () => void;
  onOpenSync: () => void;
}

interface Card {
  icon: string;
  title: string;
  body: string;
  action: string;
  run: () => void;
}

/** First-run introduction. Shown once, and replayable from Settings. */
export function WelcomeScreen({
  onCreateRequest,
  onImport,
  onOpenSync,
}: Props) {
  const { dismissWelcome, startTour } = useOnboarding();

  const cards: Card[] = [
    {
      icon: "→",
      title: "Send your first request",
      body: "REST, GraphQL, WebSocket, SSE, Socket.IO or MQTT — pick a protocol and go.",
      action: "New request",
      run: () => {
        onCreateRequest();
        dismissWelcome();
      },
    },
    {
      icon: "↓",
      title: "Bring your existing APIs",
      body: "Import an OpenAPI or Swagger spec, or a Postman collection, with docs and auth.",
      action: "Import",
      run: () => {
        onImport();
        dismissWelcome();
      },
    },
    {
      icon: "⇄",
      title: "Work with your team",
      body: "Share the workspace on your network, or commit it to GitHub for history.",
      action: "Set up sync",
      run: () => {
        onOpenSync();
        dismissWelcome();
      },
    },
  ];

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-canvas/95 p-8 backdrop-blur-sm">
      <div className="w-full max-w-2xl">
        <div className="flex flex-col items-center text-center">
          <LogoMark size={56} />
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-ink">
            Welcome to APIKit
          </h1>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted">
            An API client, load tester, mock server, uptime monitor and HTTPS
            proxy — all local-first, and all in one window.
          </p>
        </div>

        <div className="mt-7 grid gap-3 md:grid-cols-3">
          {cards.map((card) => (
            <button
              key={card.title}
              onClick={card.run}
              className="group flex flex-col rounded-lg border border-edge bg-panel p-4 text-left hover:border-brand"
            >
              <span className="text-lg leading-none text-brand">
                {card.icon}
              </span>
              <span className="mt-2 text-sm font-semibold text-ink">
                {card.title}
              </span>
              <span className="mt-1 flex-1 text-xs leading-relaxed text-muted">
                {card.body}
              </span>
              <span className="mt-3 text-xs text-brand group-hover:underline">
                {card.action} →
              </span>
            </button>
          ))}
        </div>

        <div className="mt-7 flex items-center justify-center gap-3">
          <button
            onClick={startTour}
            className="rounded-md bg-brand px-5 py-2 text-sm font-semibold text-white hover:bg-brand-bright"
          >
            Take the tour
          </button>
          <button
            onClick={dismissWelcome}
            className="rounded-md border border-edge px-5 py-2 text-sm text-muted hover:text-ink"
          >
            Skip for now
          </button>
        </div>

        <p className="mt-4 text-center text-[11px] text-muted">
          You can replay this any time from Settings.
        </p>
      </div>
    </div>
  );
}
