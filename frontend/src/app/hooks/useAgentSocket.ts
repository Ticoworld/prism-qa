"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Protocol types — must mirror backend src/server.ts
// ---------------------------------------------------------------------------
export interface QaAction {
  action_type: string;
  x_coordinate: number;
  y_coordinate: number;
  target_id: number;
  /** When action_type is "scroll", "up" or "down". */
  scroll_direction?: "up" | "down";
  input_text: string;
  is_error_state: boolean;
  task_status: "in_progress" | "completed" | "failed";
  reasoning: string;
}

export interface SessionReadyMessage {
  type: "session_ready";
  url: string;
  timestamp: number;
}

export interface CaptureResultMessage {
  type: "capture_result";
  imageBase64: string;
  url: string;
  timestamp: number;
}

export interface AnalyzeResultMessage {
  type: "analyze_result";
  action: QaAction;
  objective: string;
  timestamp: number;
}

export interface ActionAckMessage {
  type: "action_ack";
  action: string;
  timestamp: number;
}

export interface ErrorMessage {
  type: "error";
  message: string;
  code: string;
}

export type ServerMessage =
  | SessionReadyMessage
  | CaptureResultMessage
  | AnalyzeResultMessage
  | ActionAckMessage
  | ErrorMessage;

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------
export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------
/** Local: ws://localhost:3001/ws. Production: set NEXT_PUBLIC_WS_URL (e.g. wss://prism-qa-backend-xxx.run.app/ws). */
const WS_BASE =
  typeof process.env.NEXT_PUBLIC_WS_URL !== "undefined" && process.env.NEXT_PUBLIC_WS_URL !== ""
    ? process.env.NEXT_PUBLIC_WS_URL
    : "ws://localhost:3001/ws";
const WS_URL =
  typeof process.env.NEXT_PUBLIC_WS_TOKEN !== "undefined" && process.env.NEXT_PUBLIC_WS_TOKEN !== ""
    ? `${WS_BASE}${WS_BASE.includes("?") ? "&" : "?"}token=${encodeURIComponent(process.env.NEXT_PUBLIC_WS_TOKEN)}`
    : WS_BASE;
const RECONNECT_DELAY_MS = 3_000;
const CONNECTION_TIMEOUT_MS = 15_000;

interface UseAgentSocketReturn {
  connectionState: ConnectionState;
  /** WebSocket URL this app connects to (so you can verify local vs cloud). */
  wsEndpoint: string;
  /** True from CONNECT click until session_ready (or error). */
  isNavigating: boolean;
  /** Latest base64 PNG from the active session */
  latestFrame: string | null;
  /** Latest structured QA action from Gemini */
  latestAnalysis: AnalyzeResultMessage | null;
  /** Ordered list of all received server messages for the terminal log */
  messageLog: ServerMessage[];
  /** Current page URL from the browser session */
  sessionUrl: string | null;
  sendCapture: () => void;
  sendAnalyze: (objective: string) => void;
  sendAction: (action: QaAction) => void;
  sendInit: (url: string) => void;
  /** Call after connection error or timeout to try again. */
  retryConnection: () => void;
}

export function useAgentSocket(): UseAgentSocketReturn {
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timedOutRef = useRef(false);
  const hadConnectedRef = useRef(false);

  const [connectionState, setConnectionState] =
    useState<ConnectionState>("disconnected");
  const [isNavigating, setIsNavigating] = useState(false);
  const [latestFrame, setLatestFrame] = useState<string | null>(null);
  const [latestAnalysis, setLatestAnalysis] =
    useState<AnalyzeResultMessage | null>(null);
  const [messageLog, setMessageLog] = useState<ServerMessage[]>([]);
  const [sessionUrl, setSessionUrl] = useState<string | null>(null);

  const appendLog = useCallback((msg: ServerMessage) => {
    setMessageLog((prev) => [...prev, msg]);
  }, []);

  const connect = useCallback(() => {
    if (
      socketRef.current &&
      (socketRef.current.readyState === WebSocket.OPEN ||
        socketRef.current.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    timedOutRef.current = false;
    hadConnectedRef.current = false;
    setConnectionState("connecting");
    const ws = new WebSocket(WS_URL);
    socketRef.current = ws;

    connectionTimeoutRef.current = setTimeout(() => {
      connectionTimeoutRef.current = null;
      if (ws.readyState === WebSocket.CONNECTING) {
        timedOutRef.current = true;
        ws.close();
        setConnectionState("error");
      }
    }, CONNECTION_TIMEOUT_MS);

    ws.onopen = () => {
      hadConnectedRef.current = true;
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
        connectionTimeoutRef.current = null;
      }
      setConnectionState("connected");
    };

    ws.onmessage = (event: MessageEvent<string>) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(event.data) as ServerMessage;
      } catch {
        console.error("[ws] Failed to parse message:", event.data);
        return;
      }

      switch (msg.type) {
        case "session_ready":
          setIsNavigating(false);
          // Only update sessionUrl if the backend has actually navigated somewhere.
          if (msg.url) setSessionUrl(msg.url);
          appendLog(msg);
          break;

        case "capture_result":
          setLatestFrame(msg.imageBase64);
          // Capture results are high-frequency — don't spam the log
          break;

        case "analyze_result":
          setLatestAnalysis(msg);
          appendLog(msg);
          break;

        case "action_ack":
          appendLog(msg);
          break;

        case "error":
          setIsNavigating(false);
          appendLog(msg);
          break;
      }
    };

    ws.onerror = () => {
      setConnectionState("error");
    };

    ws.onclose = () => {
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
        connectionTimeoutRef.current = null;
      }
      socketRef.current = null;
      if (timedOutRef.current) {
        timedOutRef.current = false;
        setConnectionState("error");
        return;
      }
      // Connection failed before ever opening (e.g. backend down) → show error + Try again, no auto-reconnect
      if (!hadConnectedRef.current) {
        setConnectionState("error");
        return;
      }
      setConnectionState("disconnected");
      reconnectTimerRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
    };
  }, [appendLog]);

  const retryConnection = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    connect();
  }, [connect]);

  // Connect on mount, clean up on unmount
  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (connectionTimeoutRef.current) clearTimeout(connectionTimeoutRef.current);
      socketRef.current?.close();
    };
  }, [connect]);

  // ── Send helpers ─────────────────────────────────────────────────────────
  const sendRaw = useCallback((payload: object) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(payload));
    }
  }, []);

  const sendCapture = useCallback(() => {
    sendRaw({ type: "capture" });
  }, [sendRaw]);

  const sendAnalyze = useCallback(
    (objective: string) => {
      sendRaw({ type: "analyze", objective });
    },
    [sendRaw],
  );

  const sendInit = useCallback(
    (url: string) => {
      setIsNavigating(true);
      sendRaw({ type: "init", url });
    },
    [sendRaw],
  );

  const sendAction = useCallback(
    (action: QaAction) => {
      if (action.action_type === "click") {
        sendRaw({
          type: "action",
          action: "click",
          x: action.x_coordinate,
          y: action.y_coordinate,
          target_id: action.target_id,
        });
      } else if (action.action_type === "type") {
        sendRaw({
          type: "action",
          action: "type",
          text: action.input_text,
          x: action.x_coordinate,
          y: action.y_coordinate,
          target_id: action.target_id,
        });
      } else if (action.action_type === "navigate") {
        sendRaw({ type: "action", action: "navigate", url: action.input_text });
      } else if (action.action_type === "scroll") {
        sendRaw({
          type: "action",
          action: "scroll",
          x: action.x_coordinate,
          y: action.y_coordinate,
          direction: action.scroll_direction ?? "down",
        });
      }
      // wait / verify / none → no physical action sent
    },
    [sendRaw],
  );

  return {
    connectionState,
    wsEndpoint: WS_BASE,
    isNavigating,
    latestFrame,
    latestAnalysis,
    messageLog,
    sessionUrl,
    sendCapture,
    sendAnalyze,
    sendAction,
    sendInit,
    retryConnection,
  };
}
