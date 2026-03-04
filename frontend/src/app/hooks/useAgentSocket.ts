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
const WS_URL = "wss://prism-qa-backend-959993808456.us-central1.run.app/ws";
const RECONNECT_DELAY_MS = 3_000;

interface UseAgentSocketReturn {
  connectionState: ConnectionState;
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
}

export function useAgentSocket(): UseAgentSocketReturn {
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [connectionState, setConnectionState] =
    useState<ConnectionState>("disconnected");
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

    setConnectionState("connecting");
    const ws = new WebSocket(WS_URL);
    socketRef.current = ws;

    ws.onopen = () => {
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
          appendLog(msg);
          break;
      }
    };

    ws.onerror = () => {
      setConnectionState("error");
    };

    ws.onclose = () => {
      setConnectionState("disconnected");
      socketRef.current = null;
      // Auto-reconnect
      reconnectTimerRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
    };
  }, [appendLog]);

  // Connect on mount, clean up on unmount
  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
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
        });
      } else if (action.action_type === "type") {
        // click + type: send coordinates so backend can focus before typing
        sendRaw({
          type: "action",
          action: "type",
          text: action.input_text,
          x: action.x_coordinate,
          y: action.y_coordinate,
        });
      } else if (action.action_type === "navigate") {
        sendRaw({ type: "action", action: "navigate", url: action.input_text });
      } else if (action.action_type === "scroll") {
        sendRaw({
          type: "action",
          action: "scroll",
          x: action.x_coordinate,
          y: action.y_coordinate,
          deltaY: 300,
        });
      }
      // wait / verify / none → no physical action sent
    },
    [sendRaw],
  );

  return {
    connectionState,
    latestFrame,
    latestAnalysis,
    messageLog,
    sessionUrl,
    sendCapture,
    sendAnalyze,
    sendAction,
    sendInit,
  };
}
