import net from "net";
import path from "path";
import { spawn } from "child_process";

const mode = process.argv[2] || "dev";
const startPort = Number(process.env.PORT) || 3005;
const maxAttempts = 50;

function checkListen(options) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", (err) => {
      if (err.code === "EAFNOSUPPORT" || err.code === "EADDRNOTAVAIL") {
        resolve(true);
      } else {
        resolve(false);
      }
    });
    srv.listen(options, () => {
      srv.close(() => resolve(true));
    });
  });
}

async function isPortFree(port) {
  if (!(await checkListen({ port }))) return false;
  if (!(await checkListen({ port, host: "::" }))) return false;
  if (!(await checkListen({ port, host: "::1" }))) return false;
  if (!(await checkListen({ port, host: "0.0.0.0" }))) return false;
  if (!(await checkListen({ port, host: "127.0.0.1" }))) return false;
  return true;
}

async function findAvailablePort(basePort) {
  for (let p = basePort; p < basePort + maxAttempts; p++) {
    if (await isPortFree(p)) {
      return p;
    }
    console.log(`⚠️  Port ${p} is busy, trying ${p + 1}...`);
  }
  throw new Error(
    `Could not find an open port between ${basePort} and ${basePort + maxAttempts - 1}.`
  );
}

const port = await findAvailablePort(startPort);
console.log(`\n🛡️  Zero-Trust AI Studio (${mode}) ready at: http://localhost:${port}\n`);

const nextBin = path.resolve(
  process.cwd(),
  "node_modules",
  "next",
  "dist",
  "bin",
  "next"
);

const child = spawn(
  process.execPath,
  [nextBin, mode, "-H", "localhost", "-p", String(port)],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      PORT: String(port),
      STUDIO_PORT: String(port),
    },
  }
);

child.on("exit", (code) => {
  process.exit(code ?? 0);
});