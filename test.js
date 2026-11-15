/**
 * Drives the server over real stdio with a stub Webhooky endpoint, so the
 * protocol handshake, the tool schemas and every response branch are exercised
 * the way a client would exercise them.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import assert from "node:assert/strict";

let reply = { status: 200, body: { success: true, delivered: 1, devices: 1 } };
let lastRequest = null;

const stub = createServer((req, res) => {
  let buf = "";
  req.on("data", (c) => (buf += c));
  req.on("end", () => {
    lastRequest = { method: req.method, path: req.url, body: JSON.parse(buf || "{}") };
    res.writeHead(reply.status, { "Content-Type": "application/json" });
    res.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
  });
});
stub.listen(0);
await once(stub, "listening");
const url = `http://127.0.0.1:${stub.address().port}/TESTKEY123`;

// http on loopback is allowed by the server's own validation, so the stub needs
// no special casing.
const child = spawn(process.execPath, ["index.js"], {
  env: { ...process.env, WEBHOOKY_URL: url },
  stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (d) => (stderr += d));

let buffer = "";
const pending = new Map();
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
let nextId = 1;
const rpc = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 8000);
  });

/**
 * Runs a second server with its own environment and asks it the basics. Used
 * to check what a client, or a directory building a listing, sees when the
 * server is started with nothing configured.
 */
async function probe(envOverrides) {
  const env = { ...process.env };
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const p = spawn(process.execPath, ["index.js"], { env, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  const waiting = new Map();
  p.stdout.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const m = JSON.parse(line);
      if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    }
  });
  let id = 1;
  const ask = (method, params) =>
    new Promise((resolve, reject) => {
      const mine = id++;
      waiting.set(mine, resolve);
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mine, method, params }) + "\n");
      setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 8000);
    });
  try {
    await ask("initialize", {
      protocolVersion: "2025-06-18", capabilities: {},
      clientInfo: { name: "probe", version: "1" },
    });
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const list = await ask("tools/list", {});
    const call = await ask("tools/call", { name: "send_notification", arguments: { title: "x" } });
    const sounds = await ask("tools/call", { name: "list_sounds", arguments: {} });
    return {
      tools: (list.result?.tools || []).map((x) => x.name),
      call: call.result,
      sounds: sounds.result,
    };
  } finally {
    p.kill();
  }
}

let pass = 0, fail = 0;
const t = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : "  " + detail}`);
};

try {
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  });
  t("initialize antwortet", !!init.result, JSON.stringify(init).slice(0, 120));
  t("Servername ist webhooky", init.result?.serverInfo?.name === "webhooky", init.result?.serverInfo?.name);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const list = await rpc("tools/list", {});
  const names = (list.result?.tools || []).map((x) => x.name).sort();
  t("zwei Tools angeboten", JSON.stringify(names) === '["list_sounds","send_notification"]', JSON.stringify(names));
  const send = list.result.tools.find((x) => x.name === "send_notification");
  const props = send?.inputSchema?.properties || {};
  t("title ist Pflichtfeld", (send?.inputSchema?.required || []).includes("title"));
  t("sound ist als enum deklariert", Array.isArray(props.sound?.enum) && props.sound.enum.length === 41,
     String(props.sound?.enum?.length));
  t("cash_register im enum", (props.sound?.enum || []).includes("cash_register"));

  // --- Erfolgsfall
  reply = { status: 200, body: { success: true, delivered: 2, devices: 2 } };
  let r = await rpc("tools/call", { name: "send_notification", arguments: { title: "Deploy done", sound: "level_up_2" } });
  t("Erfolg: kein Fehler", r.result?.isError !== true, JSON.stringify(r.result).slice(0, 140));
  t("Erfolg: nennt Geräteanzahl", /2 devices/.test(r.result?.content?.[0]?.text || ""), r.result?.content?.[0]?.text);
  t("Erfolg: POST mit JSON-Body", lastRequest?.method === "POST" && lastRequest.body.title === "Deploy done");
  t("Erfolg: sound durchgereicht", lastRequest?.body.sound === "level_up_2");
  t("Erfolg: message weggelassen statt null", !("message" in lastRequest.body), JSON.stringify(lastRequest.body));

  // --- Monatslimit: HTTP 200, aber NICHT zugestellt
  reply = { status: 200, body: { success: false, accepted: true, delivered: 0, reason: "free_limit_reached", period: "2026-10" } };
  r = await rpc("tools/call", { name: "send_notification", arguments: { title: "Nope" } });
  t("Limit: wird als Fehler gemeldet", r.result?.isError === true, JSON.stringify(r.result).slice(0, 140));
  t("Limit: erklärt den Monat", /2026-10/.test(r.result?.content?.[0]?.text || ""), r.result?.content?.[0]?.text);
  t("Limit: erwähnt Auffüllen", /refills/.test(r.result?.content?.[0]?.text || ""));

  // --- 404
  reply = { status: 404, body: { success: false, error: "not found" } };
  r = await rpc("tools/call", { name: "send_notification", arguments: { title: "x" } });
  t("404: als Fehler gemeldet", r.result?.isError === true);
  t("404: nennt gelöschten Endpunkt", /deleted|wrong/.test(r.result?.content?.[0]?.text || ""), r.result?.content?.[0]?.text);

  // --- Schema-Verletzung
  reply = { status: 200, body: { success: true, delivered: 1 } };
  r = await rpc("tools/call", { name: "send_notification", arguments: { title: "x", sound: "not_a_sound" } });
  t("ungültiger Sound wird abgewiesen", r.error != null || r.result?.isError === true,
     JSON.stringify(r).slice(0, 160));

  r = await rpc("tools/call", { name: "send_notification", arguments: { title: "x".repeat(101) } });
  t("Titel über 100 Zeichen wird abgewiesen", r.error != null || r.result?.isError === true,
     JSON.stringify(r).slice(0, 160));

  // --- list_sounds
  r = await rpc("tools/call", { name: "list_sounds", arguments: {} });
  const txt = r.result?.content?.[0]?.text || "";
  t("list_sounds nennt Gruppen", /Money & sales/.test(txt) && /Failure & warning/.test(txt), txt.slice(0, 90));
  t("list_sounds nennt cash_register", /cash_register/.test(txt));

  // --- Key darf nicht durchsickern
  t("Endpunkt-Key nicht in stderr", !stderr.includes("TESTKEY123"), stderr.slice(0, 160));

  // --- Ohne Konfiguration muss der Server trotzdem Auskunft geben, sonst
  //     steht in jedem Verzeichnis "keine Werkzeuge".
  const blank = await probe({ WEBHOOKY_URL: undefined });
  t("ohne WEBHOOKY_URL nennt tools/list beide Werkzeuge",
     blank.tools.includes("send_notification") && blank.tools.includes("list_sounds"),
     JSON.stringify(blank.tools));
  t("ohne WEBHOOKY_URL meldet erst der Aufruf den Fehler",
     blank.call?.isError === true &&
       /WEBHOOKY_URL is not set/.test(blank.call?.content?.[0]?.text || ""),
     JSON.stringify(blank.call).slice(0, 160));
  t("ohne WEBHOOKY_URL bleibt list_sounds nutzbar",
     /cash_register/.test(blank.sounds?.content?.[0]?.text || ""));

  const plainHttp = await probe({ WEBHOOKY_URL: "http://api.webhooky.app/KEY" });
  t("http ausserhalb localhost: Werkzeuge bleiben sichtbar",
     plainHttp.tools.length === 2, JSON.stringify(plainHttp.tools));
  t("http ausserhalb localhost: der Aufruf erklärt warum",
     /must use https/.test(plainHttp.call?.content?.[0]?.text || ""),
     JSON.stringify(plainHttp.call).slice(0, 160));

  const noKey = await probe({ WEBHOOKY_URL: "https://api.webhooky.app/" });
  t("URL ohne Schlüssel: der Aufruf nennt den fehlenden Schlüssel",
     /missing the endpoint key/.test(noKey.call?.content?.[0]?.text || ""),
     JSON.stringify(noKey.call).slice(0, 160));
} catch (e) {
  fail++; console.log("  FAIL  Ausnahme:", e.message);
} finally {
  child.kill(); stub.close();
}
console.log(`\n  ${pass} bestanden, ${fail} fehlgeschlagen`);
process.exit(fail ? 1 : 0);
