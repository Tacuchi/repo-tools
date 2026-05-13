const path = require("path");
const os = require("os");

const projectRoot = path.resolve(__dirname, "..");
const userHome = os.homedir();

function getDefaultDocumentsRoot() {
  const windowsDocuments = process.env.USERPROFILE
    ? path.join(process.env.USERPROFILE, "Documents")
    : null;
  const candidates = [
    windowsDocuments,
    path.join(userHome, "Documents"),
    userHome,
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (require("fs").existsSync(candidate)) {
        return candidate;
      }
    } catch (error) {
      // Ignore and continue to the next candidate.
    }
  }

  return path.join(userHome, "Documents");
}

const defaultGameDataRoot = path.join(
  userHome,
  "AppData",
  "LocalLow",
  "semiwork",
  "Repo",
);
const gameDataRoot = process.env.REPO_SAVE_GAME_DATA_ROOT || defaultGameDataRoot;

const gameSavesRoot = path.join(gameDataRoot, "saves");
const defaultAppDataRoot = path.join(getDefaultDocumentsRoot(), "REPO Save Tool");
const appDataRoot = process.env.REPO_SAVE_APP_DATA_ROOT || defaultAppDataRoot;
const backupsRoot = path.join(appDataRoot, "backups");
const autoBackupsRoot = path.join(appDataRoot, "auto-backups");
const preRestoreRoot = path.join(appDataRoot, "pre-restore");
const exportsRoot = path.join(appDataRoot, "exports");
const logsRoot = path.join(appDataRoot, "logs");
const logFilePath = path.join(logsRoot, "repo-tools.log");

module.exports = {
  projectRoot,
  gameDataRoot,
  gameSavesRoot,
  appDataRoot,
  backupsRoot,
  autoBackupsRoot,
  preRestoreRoot,
  exportsRoot,
  logsRoot,
  logFilePath,
};
