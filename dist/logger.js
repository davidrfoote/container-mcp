"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = void 0;
const fs_1 = require("fs");
const LOG_FILE = process.env.LOG_FILE ?? "/home/david/container-mcp.log";
const MAX_SIZE = 10 * 1024 * 1024; // 10 MB
function rotate() {
    try {
        const stat = (0, fs_1.statSync)(LOG_FILE);
        if (stat.size >= MAX_SIZE) {
            (0, fs_1.renameSync)(LOG_FILE, `${LOG_FILE}.1`);
        }
    }
    catch {
        // file doesn't exist yet — no rotation needed
    }
}
function write(level, args) {
    const ts = new Date().toISOString();
    const line = `${ts} [${level}] ${args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`;
    rotate();
    try {
        (0, fs_1.appendFileSync)(LOG_FILE, line, "utf8");
    }
    catch {
        // best-effort file write — don't crash the process
    }
}
exports.logger = {
    log(...args) {
        const ts = new Date().toISOString();
        const msg = args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
        process.stdout.write(`${ts} [INFO] ${msg}\n`);
        write("INFO", args);
    },
    warn(...args) {
        const ts = new Date().toISOString();
        const msg = args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
        process.stdout.write(`${ts} [WARN] ${msg}\n`);
        write("WARN", args);
    },
    error(...args) {
        const ts = new Date().toISOString();
        const msg = args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
        process.stderr.write(`${ts} [ERROR] ${msg}\n`);
        write("ERROR", args);
    },
};
