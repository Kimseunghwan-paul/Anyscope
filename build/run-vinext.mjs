import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(new URL("../package.json", import.meta.url));
const command = process.argv[2] ?? "dev";
let entry;
let args;

if (process.platform === "win32") {
  entry = join(dirname(require.resolve("vite/package.json")), "dist", "node", "cli.js");
  args =
    command === "build"
      ? ["build", "--configLoader", "native"]
      : command === "start"
        ? ["preview", "--configLoader", "native"]
        : ["--configLoader", "native"];
} else {
  entry = join(dirname(require.resolve("vinext/package.json")), "dist", "cli.js");
  args = [command];
}

const child = spawn(process.execPath, [entry, ...args], {
  stdio: "inherit",
  env: {
    ...process.env,
    WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH ?? ".wrangler/wrangler.log",
  },
});

child.on("exit", (code) => process.exit(code ?? 1));