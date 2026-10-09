// The IPC lifetime ties each owned OpenCode process to the monitor, including
// an abrupt workbench exit. Only this child process receives termination.
import { spawn } from "node:child_process";
const [command, ...args] = process.argv.slice(2);
const child = spawn(command, args, { cwd: process.cwd(), env: process.env, shell: false, windowsHide: true, stdio: ["ignore", "inherit", "inherit"] });
let stopping = false, timer;
function stop() {
  if (stopping) return;
  stopping = true; child.kill("SIGTERM");
  timer = setTimeout(() => child.kill("SIGKILL"), 5000); timer.unref?.();
}
process.on("disconnect", stop);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("message", message => { if (message?.type === "stop") stop(); });
child.on("error", error => { process.stderr.write(`${error.message}\n`); process.exit(1); });
child.on("close", code => { clearTimeout(timer); process.exit(code ?? 1); });
