const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function pathExists(targetPath) {
  return fs.existsSync(targetPath);
}

function ensureDir(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function formatLocalTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("-") + "_" + [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join("-");
}

function sanitizeName(value) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function copyDirectory(sourceDir, destinationDir) {
  fs.cpSync(sourceDir, destinationDir, {
    recursive: true,
    force: true,
    errorOnExist: false,
  });
}

function removeDirectory(targetPath) {
  if (pathExists(targetPath)) {
    fs.rmSync(targetPath, { recursive: true, force: true });
  }
}

function getDirectorySize(targetPath) {
  let totalBytes = 0;
  const stack = [targetPath];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        totalBytes += fs.statSync(fullPath).size;
      }
    }
  }

  return totalBytes;
}

function listFilesRecursive(targetPath) {
  const files = [];
  const stack = [targetPath];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }

  return files.sort();
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = -1;

  do {
    value /= 1024;
    index += 1;
  } while (value >= 1024 && index < units.length - 1);

  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[index]}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hashFiles(filePaths, basePath = null) {
  const hash = crypto.createHash("sha256");

  for (const filePath of filePaths) {
    const hashedPath = basePath ? path.relative(basePath, filePath) : filePath;
    hash.update(hashedPath);
    hash.update("\0");
    hash.update(fs.readFileSync(filePath));
    hash.update("\0");
  }

  return hash.digest("hex");
}

function hashDirectory(targetPath) {
  const files = listFilesRecursive(targetPath);
  return hashFiles(files, targetPath);
}

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath);
  } catch (error) {
    return null;
  }
}

module.exports = {
  ensureDir,
  formatBytes,
  formatLocalTimestamp,
  getDirectorySize,
  copyDirectory,
  listFilesRecursive,
  pathExists,
  readJson,
  readFileSafe,
  removeDirectory,
  sanitizeName,
  sleep,
  writeJson,
  hashDirectory,
};
