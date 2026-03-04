import { GoogleGenAI, Type } from "@google/genai";

// ---------------------------------------------------------------------------
// Client — lazy singleton (initialized on first use so a missing key does
// not crash the process at boot time — Cloud Run can still pass health checks)
// ---------------------------------------------------------------------------
let _ai: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (_ai) return _ai;
  const apiKey = process.env["GOOGLE_GENAI_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "[agent] GOOGLE_GENAI_API_KEY is not set. Inject it via Cloud Run env vars.",
    );
  }
  _ai = new GoogleGenAI({ apiKey });
  return _ai;
}

const MODEL = "gemini-2.5-flash";

// ---------------------------------------------------------------------------
// Structured output schema — Set-of-Mark edition
//
// The model NO LONGER guesses raw pixel coordinates.
// The screenshot will contain red numbered badges on every interactive
// element. The model must return the badge number of the target element.
// The backend resolves that number → exact center coordinates.
// ---------------------------------------------------------------------------
const SOM_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    target_id: {
      type: Type.NUMBER,
      description:
        "The numeric ID shown inside the red badge on the target element. " +
        "Return -1 if the action does not require a specific element " +
        '(e.g. action_type is "wait", "verify", "none", "completed", or "failed").',
    },
    action_type: {
      type: Type.STRING,
      description:
        "The action to execute on the identified element. " +
        "One of: click | type | scroll | navigate | wait | verify | none.",
    },
    input_text: {
      type: Type.STRING,
      description:
        'For action_type "type": the exact string to type into the element. ' +
        'For action_type "navigate": the fully-qualified target URL. ' +
        "Empty string for all other action types.",
    },
    is_error_state: {
      type: Type.BOOLEAN,
      description:
        "True if the current screenshot shows an error UI state " +
        "(error banner, validation message, HTTP error page, broken layout).",
    },
    task_status: {
      type: Type.STRING,
      enum: ["in_progress", "completed", "failed"],
      description:
        "Overall status of the multi-step objective. " +
        '"in_progress": the goal is not yet achieved, more steps are needed. ' +
        '"completed": the screenshot confirms the objective is fully done. ' +
        '"failed": a blocking error prevents the objective from being achieved.',
    },
    reasoning: {
      type: Type.STRING,
      description:
        "One concise sentence identifying which badge number was selected and why. " +
        'If task_status is "completed" or "failed", describe what visual evidence confirms that status.',
    },
  },
  required: [
    "target_id",
    "action_type",
    "input_text",
    "is_error_state",
    "task_status",
    "reasoning",
  ],
};

// ---------------------------------------------------------------------------
// System prompt — badge-ID resolver, not a coordinate guesser
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are an automated QA testing agent using a Set-of-Mark (SoM) visual grounding system.

CONTEXT:
Every interactive element in the screenshot has been marked with a distinctive red numeric badge in its top-left corner and a red border. These badges are your navigation system. You must use them — do NOT attempt to guess raw pixel coordinates.

PROCESS:
1. Read the OBJECTIVE.
2. Evaluate whether the objective has already been achieved based on the current screenshot.
3. If not yet achieved, scan for the red-badged element that fulfills the next step.
4. Return the integer badge number as target_id.
5. Set action_type to the correct action for that element.
6. Set task_status based on the current state of the overall objective.
7. Write one concise sentence in reasoning, identifying which badge number was selected and why. If task_status is "completed" or "failed", describe what visual evidence confirms that status.

TARGET_ID RULES:
- Return the exact integer shown in the red badge.
- If the objective requires no element interaction (wait, verify, none, completed, failed), return target_id = -1.
- Never invent a target_id that does not appear as a badge in the screenshot.

TASK STATUS EVALUATION (CRITICAL):
- "in_progress": The objective is NOT fully met. More actions are required. Return the next action.
- "completed": The screenshot VISUALLY CONFIRMS the objective is fully achieved.
  Example: objective was to reach a success page, and you can see a success screen, checkmark, or welcome message.
  When returning "completed", set action_type to "none" and target_id to -1.
- "failed": A BLOCKING ERROR prevents the objective. Examples: error banner, validation error that cannot be dismissed,
  HTTP 500 page, or blank/broken layout. Document the exact visual error in reasoning.
  When returning "failed", set action_type to "none" and target_id to -1.

DATA ENTRY RULES:
- If the objective requires entering text into a field, set action_type to "type" — NOT "click".
- Set target_id to the badge number of the INPUT or TEXTAREA element.
- Set input_text to the EXACT string to type.
- The backend will click to focus before typing. You do not need a separate click step.

ACTION TYPES:
- click     → single left-click on the element with this target_id
- type      → focus + keyboard input; ALWAYS set input_text to exact string
- scroll    → scroll the element or page
- navigate  → full page navigation; set input_text to URL; target_id = -1
- wait      → element not yet visible; target_id = -1
- none      → used when task_status is "completed" or "failed"

NATIVE DROPDOWN RULE (CRITICAL):
Native HTML <select> dropdowns render their options via the OS, not the DOM. You cannot click their options.
If you need to select a dropdown option:
1. Return the target_id of the <select> element itself (the badge on the dropdown box, NOT the options).
2. Set action_type to "type".
3. Set input_text to the EXACT visible text of the option you want (e.g., "11-50 people" or "11-50").
The backend will type that text and press Enter, which locks in the selection.
DO NOT use action_type "click" on a dropdown selection. It will fail.

STRICT RULE: Return only valid JSON. No prose, no markdown, no code fences.`;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** What Gemini returns — a badge ID, task_status, and action details */
export interface GeminiVerdict {
  target_id: number;
  action_type: string;
  input_text: string;
  is_error_state: boolean;
  task_status: "in_progress" | "completed" | "failed";
  reasoning: string;
}

export interface AnalyzeOptions {
  /** Base64-encoded PNG of the SoM-marked screenshot */
  imageBase64: string;
  /** Natural language objective */
  objective: string;
  /** Ordered list of actions already taken this session */
  history?: string[];
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------
export async function analyzeMarkedScreenshot(
  opts: AnalyzeOptions,
): Promise<GeminiVerdict> {
  const { imageBase64, objective, history } = opts;

  // Build the history block injected at the top of the user turn.
  // Placed BEFORE the image so the model reads context first.
  const historyBlock =
    history && history.length > 0
      ? [
          "--- SESSION HISTORY (actions already successfully executed, DO NOT REPEAT) ---",
          ...history.map((h, i) => `${i + 1}. ${h}`),
          "--- END HISTORY ---",
          "",
          "CRITICAL: Review the history above. Do NOT type into a field you have already typed into.",
          "If a field already has a value (including masked password dots), skip it and action the NEXT step.",
        ].join("\n")
      : null;

  const safeFailure = (reason: string): GeminiVerdict => ({
    target_id: -1,
    action_type: "none",
    input_text: "",
    is_error_state: true,
    task_status: "failed",
    reasoning: reason,
  });

  try {
    const response = await getClient().models.generateContent({
      model: MODEL,
      contents: [
        {
          role: "user",
          parts: [
            ...(historyBlock ? [{ text: historyBlock }] : []),
            { inlineData: { mimeType: "image/png", data: imageBase64 } },
            { text: `OBJECTIVE: ${objective}` },
          ],
        },
      ],
      config: {
        systemInstruction: SYSTEM_PROMPT,
        responseMimeType: "application/json",
        responseSchema: SOM_SCHEMA,
        temperature: 0,
        maxOutputTokens: 1024,
      },
    });

    const raw = response.text;
    if (!raw) {
      console.error("[agent] Gemini returned an empty response.");
      return safeFailure("Model returned empty response.");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error(`[agent] Malformed JSON from Gemini: ${raw.slice(0, 300)}`);
      return safeFailure("Model hallucination or truncated JSON.");
    }

    return validateVerdict(parsed);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[agent] Gemini API error: ${msg}`);
    return safeFailure(`Gemini API error: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Runtime validation
// ---------------------------------------------------------------------------
function validateVerdict(raw: unknown): GeminiVerdict {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("[agent] Response is not a JSON object.");
  }
  const obj = raw as Record<string, unknown>;

  const required: (keyof GeminiVerdict)[] = [
    "target_id",
    "action_type",
    "input_text",
    "is_error_state",
    "task_status",
    "reasoning",
  ];
  for (const f of required) {
    if (!(f in obj)) throw new Error(`[agent] Missing field: "${f}"`);
  }
  if (typeof obj["target_id"] !== "number")
    throw new Error("[agent] target_id must be a number");
  if (typeof obj["action_type"] !== "string")
    throw new Error("[agent] action_type must be a string");
  if (typeof obj["input_text"] !== "string")
    throw new Error("[agent] input_text must be a string");
  if (typeof obj["is_error_state"] !== "boolean")
    throw new Error("[agent] is_error_state must be a boolean");
  if (typeof obj["reasoning"] !== "string")
    throw new Error("[agent] reasoning must be a string");
  const validStatuses = ["in_progress", "completed", "failed"];
  if (!validStatuses.includes(String(obj["task_status"]))) {
    throw new Error(
      `[agent] task_status must be one of: ${validStatuses.join(", ")}`,
    );
  }

  return obj as unknown as GeminiVerdict;
}
