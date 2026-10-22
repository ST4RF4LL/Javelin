#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { checkedJson } from "../lib/runtime-testing/controller.mjs";
import { check } from "../lib/runtime-testing/contract.mjs";

try {
  check(["runtime-testing.v1", "runtime-testing.v2"].includes(process.env.AUDIT_RUNTIME_PROTOCOL), "runtime-protocol-not-selected");
  const root = process.env.AUDIT_RUNTIME_STATE_ROOT;
  const state = await checkedJson(root, "state.json");
  const command = process.argv[2] ?? "status";
  check(["status", "enqueue", "close", "cancel"].includes(command), "runtime-command-invalid");
  const terminal = ["SKIPPED", "CLOSED", "QUARANTINED", "BLOCKED"].includes(state.status);
  let connection;
  if (!terminal || ["close", "cancel"].includes(command) && !["CLOSED", "SKIPPED"].includes(state.status)) {
    try { connection = JSON.parse(await readFile(process.env.AUDIT_RUNTIME_CONNECTION_PATH, "utf8")); }
    catch (error) { if (!terminal || error.code !== "ENOENT") throw error; }
  }
  if (terminal && !connection) {
    // An unavailable environment is not proof that the evidence was sealed.
    // Recovery without a live controller may only consume an existing bundle.
    if (["close", "cancel"].includes(command)) {
      const evidence = await checkedJson(root, "evidence-set.json");
      check(evidence.authorization_digest === state.authorization_digest && evidence.status === state.status, "runtime-evidence-not-sealed");
    }
    const result = command === "enqueue" ? { status: "SKIPPED", reason: state.reason ?? "ENVIRONMENT_CLOSED" } : state;
    if (state.protocol === "runtime-testing.v2" && result === state) for (const key of ["scopes", "finding_revisions", "outbox", "evidence"]) delete result[key];
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    check(/^http:\/\/127\.0\.0\.1:\d+$/.test(connection.endpoint), "runtime-controller-endpoint-invalid");
    const body = command === "enqueue" ? await checkedJson(process.env.AUDIT_REPORTS_ROOT, process.argv[3]) : {};
    const response = await fetch(`${connection.endpoint}/${command}`, { method: "POST", headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(55_000) });
    const result = await response.json(); check(response.ok, result.error ?? "runtime-controller-failed");
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
} catch (error) { process.stderr.write(`${error.code ?? error.message}\n`); process.exitCode = 1; }
