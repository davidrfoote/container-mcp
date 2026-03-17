import { appendFileSync, renameSync, statSync } from "fs";

const LOG_FILE = process.env.LOG_FILE ?? "/home/david/container-mcp.log";
const MAX_SIZE = 10 * 1024 * 1024; // 10 MB

function rotate(): void {
  try {
    const stat = statSync(LOG_FILE);
    if (stat.size >= MAX_SIZE) {
      renameSync(LOG_FILE, `${LOG_FILE}.1`);
    }
  } catch {
    // file doesn't exist yet — no rotation needed
  }
}

function write(level: string, args: unknown[]): void {
  const ts = new Date().toISOString();
  const line = `${ts} [${level}] ${args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`;
  rotate();
  try {
    appendFileSync(LOG_FILE, line, "utf8");
  } catch {
    // best-effort file write — don't crash the process
  }
}

export const logger = {
  log(...args: unknown[]): void {
    const ts = new Date().toISOString();
    const msg = args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    process.stdout.write(`${ts} [INFO] ${msg}\n`);
    write("INFO", args);
  },
  warn(...args: unknown[]): void {
    const ts = new Date().toISOString();
    const msg = args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    process.stdout.write(`${ts} [WARN] ${msg}\n`);
    write("WARN", args);
  },
  error(...args: unknown[]): void {
    const ts = new Date().toISOString();
    const msg = args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    process.stderr.write(`${ts} [ERROR] ${msg}\n`);
    write("ERROR", args);
  },
};
