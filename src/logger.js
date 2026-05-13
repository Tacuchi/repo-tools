const fs = require("fs");
const path = require("path");
const { logFilePath, logsRoot } = require("./config");

let cachedStream = null;
let initFailed = false;

function ensureStream() {
  if (cachedStream || initFailed) {
    return cachedStream;
  }
  try {
    fs.mkdirSync(logsRoot, { recursive: true });
    const stream = fs.createWriteStream(logFilePath, { flags: "a" });
    stream.on("error", () => {
      cachedStream = null;
      initFailed = true;
    });
    cachedStream = stream;
  } catch (error) {
    initFailed = true;
    cachedStream = null;
  }
  return cachedStream;
}

function serializeMeta(meta) {
  if (meta === undefined || meta === null) {
    return "";
  }
  if (meta instanceof Error) {
    const stack = meta.stack ? meta.stack.replace(/\n/g, " | ") : "(no stack)";
    return ` | error="${meta.message}" stack="${stack}"`;
  }
  if (typeof meta === "string") {
    return ` | ${meta}`;
  }
  try {
    return ` | ${JSON.stringify(meta)}`;
  } catch (error) {
    return ` | ${String(meta)}`;
  }
}

function writeLine(level, message, meta) {
  const stream = ensureStream();
  if (!stream) {
    return;
  }
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level}] ${message}${serializeMeta(meta)}\n`;
  try {
    stream.write(line);
  } catch (error) {
    // Stream failed mid-flight; reset so next call retries.
    cachedStream = null;
  }
}

function close() {
  if (cachedStream) {
    try {
      cachedStream.end();
    } catch (error) {
      // Ignore close errors.
    }
    cachedStream = null;
  }
}

module.exports = {
  info: (message, meta) => writeLine("INFO", message, meta),
  warn: (message, meta) => writeLine("WARN", message, meta),
  error: (message, meta) => writeLine("ERROR", message, meta),
  debug: (message, meta) => {
    if (process.env.REPO_TOOLS_DEBUG) {
      writeLine("DEBUG", message, meta);
    }
  },
  close,
  getLogFilePath: () => logFilePath,
  getLogsRoot: () => logsRoot,
};
