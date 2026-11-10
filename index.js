#!/usr/bin/env node
/**
 * Webhooky MCP server.
 *
 * Exposes one Webhooky endpoint as a tool, so an assistant can send a push
 * notification to the user's phone instead of writing code that does it.
 *
 * Configuration is a single environment variable:
 *   WEBHOOKY_URL=https://api.webhooky.app/YOUR_KEY
 *
 * The URL can only trigger a notification - it cannot read anything or reach an
 * account - but it is still never accepted as a tool argument, a model should not be able to send to an
 * arbitrary endpoint, and the key should not travel through the transcript.
 *
 * stdio note: stdout is the protocol channel. Everything diagnostic goes to
 * stderr, or the client sees corrupted frames.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { SOUNDS, SOUND_GROUPS, groupOf } from "./sounds.js";

const ENDPOINT = process.env.WEBHOOKY_URL;
const TIMEOUT_MS = Number(process.env.WEBHOOKY_TIMEOUT_MS || 10_000);

if (!ENDPOINT) {
  console.error(
    "webhooky-mcp: WEBHOOKY_URL is not set.\n" +
      "Create an endpoint in the Webhooky app (https://webhooky.app), copy its URL\n" +
      "and set it, e.g. WEBHOOKY_URL=https://api.webhooky.app/YOUR_KEY",
  );
  process.exit(1);
}
let parsed;
try {
  parsed = new URL(ENDPOINT);
} catch {
  console.error(`webhooky-mcp: WEBHOOKY_URL is not a URL: ${ENDPOINT}`);
  process.exit(1);
}
// Plain http is allowed only on loopback, where nothing leaves the machine;
// anywhere else the endpoint key would travel in clear text.
const isLoopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed.hostname);
if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
  console.error(
    `webhooky-mcp: WEBHOOKY_URL must use https (http is only allowed on localhost): ${ENDPOINT}\n` +
      "Expected something like https://api.webhooky.app/YOUR_KEY",
  );
  process.exit(1);
}
if (parsed.pathname.replace(/^\/+|\/+$/g, "") === "") {
  console.error(
    `webhooky-mcp: WEBHOOKY_URL is missing the endpoint key: ${ENDPOINT}\n` +
      "Expected something like https://api.webhooky.app/YOUR_KEY",
  );
  process.exit(1);
}

/** Never let the endpoint key reach the model or the transcript. */
const redact = (text) => String(text).split(ENDPOINT).join("<your endpoint>");

const server = new McpServer({ name: "webhooky", version: "1.0.0" });

server.registerTool(
  "send_notification",
  {
    description:
      "Send a push notification to the user's phone via their Webhooky endpoint. " +
      "Use this to tell the user something finished, succeeded or failed when they " +
      "are away from the screen. Pick a sound that matches the meaning: cash_register " +
      "for revenue, level_up_2 for success, buzzer or error_1 for failure, " +
      "notification_1 when it is merely informational. Call list_sounds for the full set.",
    inputSchema: z.object({
      title: z
        .string()
        .min(1)
        .max(100)
        .describe("Notification title, max 100 characters. Keep it scannable."),
      message: z
        .string()
        .max(500)
        .optional()
        .describe("Notification body, max 500 characters. Omit to use the endpoint's configured text."),
      sound: z
        .enum(SOUNDS)
        .optional()
        .describe("Sound id. Omit to use the sound configured on the endpoint."),
      vibrate: z
        .boolean()
        .optional()
        .describe("Override the endpoint's vibration setting for this notification."),
    }),
  },
  async ({ title, message, sound, vibrate }) => {
    const body = { title };
    if (message !== undefined) body.message = message;
    if (sound !== undefined) body.sound = sound;
    if (vibrate !== undefined) body.vibrate = vibrate;

    let res, text;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      text = await res.text();
    } catch (err) {
      const reason = err?.name === "TimeoutError"
        ? `no response within ${TIMEOUT_MS} ms`
        : redact(err?.message || String(err));
      return {
        isError: true,
        content: [{ type: "text", text: `Could not reach the Webhooky endpoint: ${reason}` }],
      };
    }

    let data = null;
    try { data = JSON.parse(text); } catch { /* non-JSON body handled below */ }

    if (res.status === 404) {
      return {
        isError: true,
        content: [{
          type: "text",
          text: "Webhooky returned 404: the endpoint key is wrong or the endpoint was deleted in the app. Nothing was queued.",
        }],
      };
    }
    if (!res.ok) {
      return {
        isError: true,
        content: [{ type: "text", text: `Webhooky returned HTTP ${res.status}: ${redact(text).slice(0, 300)}` }],
      };
    }

    // A 200 does not mean delivered, the free plan answers 200 when the
    // monthly quota is used up, so that senders like Stripe do not retry.
    if (data && data.success === false) {
      const period = data.period ? ` for ${data.period}` : "";
      const why = data.reason === "free_limit_reached"
        ? `the free plan's monthly notification quota is used up${period}. It refills at the start of next month, or Premium removes the limit.`
        : `reason: ${data.reason || "unknown"}.`;
      return {
        isError: true,
        content: [{ type: "text", text: `Webhooky accepted the request but delivered nothing, ${why}` }],
      };
    }

    const devices = data && typeof data.delivered === "number" ? data.delivered : null;
    const where = devices === null ? "" : devices === 1 ? " to 1 device" : ` to ${devices} devices`;
    const withSound = sound ? ` with the ${sound} sound` : "";
    return {
      content: [{ type: "text", text: `Notification "${title}" sent${where}${withSound}.` }],
    };
  },
);

server.registerTool(
  "list_sounds",
  {
    description:
      "List the notification sounds a Webhooky endpoint can play, grouped by what they " +
      "mean. Call this before send_notification when unsure which sound fits.",
    inputSchema: z.object({}),
  },
  async () => {
    const lines = Object.entries(SOUND_GROUPS).map(
      ([group, ids]) => `${group}: ${ids.join(", ")}`,
    );
    return {
      content: [{
        type: "text",
        text:
          lines.join("\n") +
          "\n\nOmit the sound argument to use whatever the endpoint is configured with.",
      }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`webhooky-mcp ready, endpoint ${ENDPOINT.replace(/\/[^/]+$/, "/***")}`);
