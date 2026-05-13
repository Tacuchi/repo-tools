const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const { execSync } = require("child_process");
const {
  autoBackupsRoot,
  backupsRoot,
  exportsRoot,
  gameDataRoot,
  gameSavesRoot,
  preRestoreRoot,
} = require("./config");
const {
  copyDirectory,
  ensureDir,
  formatLocalTimestamp,
  getDirectorySize,
  hashDirectory,
  isInternalGameBackup,
  listFilesRecursive,
  pathExists,
  readFileSafe,
  readJson,
  removeDirectory,
  sanitizeName,
  sleep,
  writeJson,
} = require("./fs-utils");
const logger = require("./logger");

const HASH_OPTIONS = { skipInternalBackups: true };
const manifestCache = new Map();

function readCachedManifest(manifestPath) {
  try {
    const stats = fs.statSync(manifestPath);
    const cached = manifestCache.get(manifestPath);
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      return cached.data;
    }
    const data = readJson(manifestPath);
    manifestCache.set(manifestPath, { mtimeMs: stats.mtimeMs, size: stats.size, data });
    return data;
  } catch (error) {
    manifestCache.delete(manifestPath);
    throw error;
  }
}

function invalidateManifestCache(manifestPath) {
  manifestCache.delete(manifestPath);
}

const ES3_PASSWORD = "Why would you want to cheat?... :o It's no fun. :') :'D";

function getPathsReport() {
  return {
    gameDataRoot,
    gameSavesRoot,
    backupsRoot,
    autoBackupsRoot,
    preRestoreRoot,
    exportsRoot,
  };
}

function decryptEs3File(primaryEs3Path) {
  if (!primaryEs3Path || !pathExists(primaryEs3Path)) {
    return null;
  }

  try {
    const buffer = readFileSafe(primaryEs3Path);
    if (!buffer || buffer.length < 17) {
      return null;
    }

    const iv = buffer.subarray(0, 16);
    const encrypted = buffer.subarray(16);
    const key = crypto.pbkdf2Sync(Buffer.from(ES3_PASSWORD, "utf8"), iv, 100, 16, "sha1");
    const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
    let decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

    if (decrypted[0] === 0x1f && decrypted[1] === 0x8b) {
      decrypted = zlib.gunzipSync(decrypted);
    }

    return JSON.parse(decrypted.toString("utf8"));
  } catch (error) {
    return null;
  }
}

function inferStateLabel(saveLevelFlag) {
  if (saveLevelFlag === 1) {
    return "post-extraction";
  }

  if (saveLevelFlag === 0) {
    return "shop-or-pre-run";
  }

  return "unknown-state";
}

function extractHumanMetadata(saveGame) {
  if (!saveGame || typeof saveGame !== "object") {
    return null;
  }

  const runStats = saveGame.dictionaryOfDictionaries?.value?.runStats || {};
  const playerNames = saveGame.playerNames?.value || {};
  const players = Object.values(playerNames)
    .map((value) => String(value).trim())
    .filter(Boolean);
  const saveLevelFlag = Number.isInteger(runStats["save level"]) ? runStats["save level"] : null;
  const runLevel = Number.isInteger(runStats.level) ? runStats.level : null;

  return {
    teamName: typeof saveGame.teamName?.value === "string" && saveGame.teamName.value.trim()
      ? saveGame.teamName.value.trim()
      : null,
    players,
    playerCount: players.length,
    runLevel,
    saveLevelFlag,
    currency: Number.isInteger(runStats.currency) ? runStats.currency : null,
    lives: Number.isInteger(runStats.lives) ? runStats.lives : null,
    totalHaul: Number.isInteger(runStats.totalHaul) ? runStats.totalHaul : null,
    stateLabel: inferStateLabel(saveLevelFlag),
  };
}

function inferPhaseMetadata(primaryEs3Path) {
  const saveGame = decryptEs3File(primaryEs3Path);
  const humanMetadata = extractHumanMetadata(saveGame);

  if (!humanMetadata) {
    return null;
  }

  return {
    level: humanMetadata.runLevel,
    saveLevelFlag: humanMetadata.saveLevelFlag,
    state: humanMetadata.stateLabel,
    teamName: humanMetadata.teamName,
    players: humanMetadata.players,
    playerCount: humanMetadata.playerCount,
    currency: humanMetadata.currency,
    lives: humanMetadata.lives,
    totalHaul: humanMetadata.totalHaul,
    mapName: null,
  };
}

function buildSaveEntry(baseEntry, phaseMetadata) {
  const players = Array.isArray(phaseMetadata?.players) ? phaseMetadata.players : [];

  return {
    ...baseEntry,
    phaseMetadata,
    teamName: phaseMetadata?.teamName || null,
    players,
    playerCount: Number.isInteger(phaseMetadata?.playerCount) ? phaseMetadata.playerCount : players.length,
    runLevel: Number.isInteger(phaseMetadata?.level) ? phaseMetadata.level : null,
    saveLevelFlag: Number.isInteger(phaseMetadata?.saveLevelFlag) ? phaseMetadata.saveLevelFlag : null,
    stateLabel: phaseMetadata?.state || "unknown-state",
    currency: Number.isInteger(phaseMetadata?.currency) ? phaseMetadata.currency : null,
    lives: Number.isInteger(phaseMetadata?.lives) ? phaseMetadata.lives : null,
    totalHaul: Number.isInteger(phaseMetadata?.totalHaul) ? phaseMetadata.totalHaul : null,
    mapName: phaseMetadata?.mapName || null,
  };
}

function getFallbackPhaseMetadata(entryOrManifest) {
  const players = Array.isArray(entryOrManifest?.players)
    ? entryOrManifest.players.filter(Boolean).map((player) => String(player))
    : [];
  const playerCount = Number.isInteger(entryOrManifest?.playerCount)
    ? entryOrManifest.playerCount
    : players.length;
  const runLevel = Number.isInteger(entryOrManifest?.runLevel)
    ? entryOrManifest.runLevel
    : Number.isInteger(entryOrManifest?.phaseMetadata?.level)
      ? entryOrManifest.phaseMetadata.level
      : null;
  const saveLevelFlag = Number.isInteger(entryOrManifest?.saveLevelFlag)
    ? entryOrManifest.saveLevelFlag
    : Number.isInteger(entryOrManifest?.phaseMetadata?.saveLevelFlag)
      ? entryOrManifest.phaseMetadata.saveLevelFlag
      : null;
  const stateLabel = entryOrManifest?.stateLabel
    || entryOrManifest?.phaseMetadata?.state
    || inferStateLabel(saveLevelFlag);

  if (
    !entryOrManifest?.teamName
    && players.length === 0
    && runLevel == null
    && saveLevelFlag == null
    && !entryOrManifest?.phaseMetadata
  ) {
    return null;
  }

  return {
    level: runLevel,
    state: stateLabel,
    teamName: entryOrManifest?.teamName || entryOrManifest?.phaseMetadata?.teamName || null,
    players,
    playerCount,
    currency: Number.isInteger(entryOrManifest?.currency)
      ? entryOrManifest.currency
      : Number.isInteger(entryOrManifest?.phaseMetadata?.currency)
        ? entryOrManifest.phaseMetadata.currency
        : null,
    lives: Number.isInteger(entryOrManifest?.lives)
      ? entryOrManifest.lives
      : Number.isInteger(entryOrManifest?.phaseMetadata?.lives)
        ? entryOrManifest.phaseMetadata.lives
        : null,
    totalHaul: Number.isInteger(entryOrManifest?.totalHaul)
      ? entryOrManifest.totalHaul
      : Number.isInteger(entryOrManifest?.phaseMetadata?.totalHaul)
        ? entryOrManifest.phaseMetadata.totalHaul
        : null,
    mapName: entryOrManifest?.mapName || entryOrManifest?.phaseMetadata?.mapName || null,
    saveLevelFlag,
  };
}

function createPhaseLabel(sourceSave, contentHash, phaseMetadata) {
  if (phaseMetadata) {
    const pieces = [];

    if (Number.isInteger(phaseMetadata.level)) {
      pieces.push(`level-${phaseMetadata.level}`);
    }

    if (phaseMetadata.state) {
      pieces.push(String(phaseMetadata.state));
    }

    if (pieces.length > 0) {
      return pieces.join("__");
    }
  }

  return `transition-detected__${contentHash.slice(0, 8)}`;
}

function getSaveEntries() {
  if (!pathExists(gameSavesRoot)) {
    return [];
  }

  const folders = fs
    .readdirSync(gameSavesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const folderPath = path.join(gameSavesRoot, entry.name);
      const files = listFilesRecursive(folderPath);
      const es3Files = files.filter((filePath) => filePath.toLowerCase().endsWith(".es3"));
      const preferredFile = path.join(folderPath, `${entry.name}.es3`);
      const primaryEs3Path = es3Files.find((filePath) => path.normalize(filePath) === path.normalize(preferredFile)) || es3Files[0] || null;
      const stats = fs.statSync(folderPath);
      const phaseMetadata = inferPhaseMetadata(primaryEs3Path);

      return buildSaveEntry({
        saveId: entry.name,
        folderName: entry.name,
        folderPath,
        primaryEs3Path,
        modifiedAt: stats.mtime.toISOString(),
        sizeBytes: getDirectorySize(folderPath),
        isValid: Boolean(primaryEs3Path),
      }, phaseMetadata);
    });

  return folders.sort((left, right) => new Date(right.modifiedAt) - new Date(left.modifiedAt));
}

function findPrimaryEs3InFolder(folderPath, saveId) {
  if (!folderPath || !pathExists(folderPath)) {
    return null;
  }

  const files = listFilesRecursive(folderPath).filter((filePath) => filePath.toLowerCase().endsWith(".es3"));
  const preferredFile = saveId ? path.join(folderPath, `${saveId}.es3`) : null;
  return files.find((filePath) => preferredFile && path.normalize(filePath) === path.normalize(preferredFile))
    || files[0]
    || null;
}

function createBackupManifest(sourceSave, backupFolderPath, backupId, options = {}) {
  const files = listFilesRecursive(backupFolderPath).map((filePath) => path.relative(backupFolderPath, filePath));
  const contentHash = options.contentHash || hashDirectory(backupFolderPath, HASH_OPTIONS);
  const phaseMetadata = options.phaseMetadata || sourceSave.phaseMetadata || inferPhaseMetadata(path.join(backupFolderPath, path.basename(sourceSave.primaryEs3Path || "")));
  const label = options.label || createPhaseLabel(sourceSave, contentHash, phaseMetadata);

  return {
    backupId,
    createdAt: new Date().toISOString(),
    sourceRoot: sourceSave.folderPath,
    saveId: sourceSave.saveId,
    primaryFile: sourceSave.primaryEs3Path ? path.basename(sourceSave.primaryEs3Path) : null,
    label,
    source: options.source || "manual",
    isFavorite: Boolean(options.isFavorite),
    contentHash,
    phaseMetadata,
    teamName: phaseMetadata?.teamName || null,
    players: Array.isArray(phaseMetadata?.players) ? phaseMetadata.players : [],
    playerCount: Number.isInteger(phaseMetadata?.playerCount) ? phaseMetadata.playerCount : 0,
    runLevel: Number.isInteger(phaseMetadata?.level) ? phaseMetadata.level : null,
    saveLevelFlag: Number.isInteger(options.saveLevelFlag)
      ? options.saveLevelFlag
      : Number.isInteger(sourceSave.saveLevelFlag)
        ? sourceSave.saveLevelFlag
        : null,
    stateLabel: phaseMetadata?.state || "unknown-state",
    currency: Number.isInteger(phaseMetadata?.currency) ? phaseMetadata.currency : null,
    lives: Number.isInteger(phaseMetadata?.lives) ? phaseMetadata.lives : null,
    totalHaul: Number.isInteger(phaseMetadata?.totalHaul) ? phaseMetadata.totalHaul : null,
    mapName: phaseMetadata?.mapName || null,
    files,
    sizeBytes: getDirectorySize(backupFolderPath),
  };
}

function backupSaves(selectedSaves, options = {}) {
  const targetRoot = options.targetRoot || backupsRoot;
  const sourceLabel = options.source || "manual";
  ensureDir(targetRoot);

  const results = [];

  for (const saveEntry of selectedSaves) {
    const contentHash = hashDirectory(saveEntry.folderPath, HASH_OPTIONS);
    const phaseMetadata = saveEntry.phaseMetadata || inferPhaseMetadata(saveEntry.primaryEs3Path);
    const label = options.label || createPhaseLabel(saveEntry, contentHash, phaseMetadata);
    const backupId = `${formatLocalTimestamp()}__${sanitizeName(saveEntry.saveId)}__${sanitizeName(label)}`;
    const destinationPath = path.join(targetRoot, backupId);
    const saveDestination = path.join(destinationPath, saveEntry.saveId);

    ensureDir(destinationPath);
    copyDirectory(saveEntry.folderPath, saveDestination);
    const manifest = createBackupManifest(saveEntry, saveDestination, backupId, {
      source: sourceLabel,
      label,
      contentHash,
      phaseMetadata,
      saveLevelFlag: saveEntry.saveLevelFlag,
    });
    const manifestPath = path.join(destinationPath, "manifest.json");
    writeJson(manifestPath, manifest);
    invalidateManifestCache(manifestPath);

    logger.info("backup created", {
      saveId: saveEntry.saveId,
      backupId,
      source: sourceLabel,
      label,
      runLevel: manifest.runLevel,
      stateLabel: manifest.stateLabel,
      players: manifest.players,
      sizeBytes: manifest.sizeBytes,
      contentHash: contentHash ? contentHash.slice(0, 12) : null,
    });

    results.push({
      backupId,
      destinationPath,
      manifest,
    });
  }

  return results;
}

function readBackupEntriesFromRoot(rootPath, source) {
  if (!pathExists(rootPath)) {
    return [];
  }

  return fs
    .readdirSync(rootPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const manifestPath = path.join(rootPath, entry.name, "manifest.json");
      if (!pathExists(manifestPath)) {
        return null;
      }

      const manifest = readCachedManifest(manifestPath);
      const saveFolderPath = path.join(rootPath, entry.name, manifest.saveId);
      const inferredPhaseMetadata = inferPhaseMetadata(findPrimaryEs3InFolder(saveFolderPath, manifest.saveId));
      const phaseMetadata = getFallbackPhaseMetadata(manifest) || inferredPhaseMetadata;
      const players = Array.isArray(phaseMetadata?.players) ? phaseMetadata.players : [];

      return {
        backupId: manifest.backupId,
        createdAt: manifest.createdAt,
        saveId: manifest.saveId,
        primaryFile: manifest.primaryFile,
        destinationPath: path.join(rootPath, entry.name),
        saveFolderPath,
        sizeBytes: manifest.sizeBytes,
        files: manifest.files,
        label: manifest.label || null,
        source: manifest.source || source,
        isFavorite: Boolean(manifest.isFavorite),
        contentHash: manifest.contentHash || null,
        phaseMetadata,
        teamName: phaseMetadata?.teamName || null,
        players,
        playerCount: Number.isInteger(phaseMetadata?.playerCount) ? phaseMetadata.playerCount : players.length,
        runLevel: Number.isInteger(phaseMetadata?.level) ? phaseMetadata.level : null,
        saveLevelFlag: Number.isInteger(phaseMetadata?.saveLevelFlag) ? phaseMetadata.saveLevelFlag : null,
        stateLabel: phaseMetadata?.state || "unknown-state",
        currency: Number.isInteger(phaseMetadata?.currency) ? phaseMetadata.currency : null,
        lives: Number.isInteger(phaseMetadata?.lives) ? phaseMetadata.lives : null,
        totalHaul: Number.isInteger(phaseMetadata?.totalHaul) ? phaseMetadata.totalHaul : null,
        mapName: phaseMetadata?.mapName || null,
        isValid: pathExists(saveFolderPath),
      };
    })
    .filter(Boolean);
}

function getBackupEntries() {
  const entries = [
    ...readBackupEntriesFromRoot(backupsRoot, "manual"),
    ...readBackupEntriesFromRoot(autoBackupsRoot, "auto-watch"),
    ...readBackupEntriesFromRoot(preRestoreRoot, "pre-restore"),
  ];

  return entries.sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
}

function toggleBackupFavorite(backupId) {
  const backupEntry = getBackupEntries().find((entry) => entry.backupId === backupId);

  if (!backupEntry) {
    throw new Error(`Backup ${backupId} was not found.`);
  }

  const manifestPath = path.join(backupEntry.destinationPath, "manifest.json");
  if (!pathExists(manifestPath)) {
    throw new Error(`Backup ${backupId} is missing its manifest.`);
  }

  const manifest = readJson(manifestPath);
  manifest.isFavorite = !Boolean(manifest.isFavorite);
  writeJson(manifestPath, manifest);
  invalidateManifestCache(manifestPath);
  logger.info("toggle favorite", { backupId, isFavorite: manifest.isFavorite });

  return getBackupEntries().find((entry) => entry.backupId === backupId) || {
    ...backupEntry,
    isFavorite: manifest.isFavorite,
  };
}

function isGameRunning() {
  try {
    const output = execSync("tasklist", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return /REPO\.exe/i.test(output);
  } catch (error) {
    return false;
  }
}

function snapshotCurrentSave(saveId) {
  const sourcePath = path.join(gameSavesRoot, saveId);
  if (!pathExists(sourcePath)) {
    return null;
  }

  ensureDir(preRestoreRoot);
  const snapshotId = `${formatLocalTimestamp()}__${sanitizeName(saveId)}`;
  const snapshotPath = path.join(preRestoreRoot, snapshotId);
  const destinationSavePath = path.join(snapshotPath, saveId);
  ensureDir(snapshotPath);
  copyDirectory(sourcePath, destinationSavePath);
  const currentEntry = getSaveEntries().find((entry) => entry.saveId === saveId) || null;
  const phaseMetadata = getFallbackPhaseMetadata(currentEntry || {});
  const players = Array.isArray(phaseMetadata?.players) ? phaseMetadata.players : [];

  const manifest = {
    backupId: snapshotId,
    createdAt: new Date().toISOString(),
    sourceRoot: sourcePath,
    saveId,
    primaryFile: null,
    label: "pre-restore",
    source: "pre-restore",
    contentHash: hashDirectory(destinationSavePath, HASH_OPTIONS),
    phaseMetadata,
    teamName: phaseMetadata?.teamName || null,
    players,
    playerCount: Number.isInteger(phaseMetadata?.playerCount) ? phaseMetadata.playerCount : players.length,
    runLevel: Number.isInteger(phaseMetadata?.level) ? phaseMetadata.level : null,
    saveLevelFlag: Number.isInteger(phaseMetadata?.saveLevelFlag) ? phaseMetadata.saveLevelFlag : null,
    stateLabel: phaseMetadata?.state || "unknown-state",
    currency: Number.isInteger(phaseMetadata?.currency) ? phaseMetadata.currency : null,
    lives: Number.isInteger(phaseMetadata?.lives) ? phaseMetadata.lives : null,
    totalHaul: Number.isInteger(phaseMetadata?.totalHaul) ? phaseMetadata.totalHaul : null,
    mapName: phaseMetadata?.mapName || null,
    files: listFilesRecursive(destinationSavePath).map((filePath) => path.relative(destinationSavePath, filePath)),
    sizeBytes: getDirectorySize(destinationSavePath),
  };
  const manifestPath = path.join(snapshotPath, "manifest.json");
  writeJson(manifestPath, manifest);
  invalidateManifestCache(manifestPath);

  return {
    snapshotId,
    snapshotPath,
  };
}

function restoreBackup(backupEntry) {
  if (isGameRunning()) {
    logger.warn("restore aborted: game running", { saveId: backupEntry.saveId });
    throw new Error("R.E.P.O. appears to be running. Close REPO.exe before restoring a save.");
  }

  if (!backupEntry.isValid) {
    logger.error("restore aborted: invalid backup", { backupId: backupEntry.backupId });
    throw new Error(`Backup ${backupEntry.backupId} is missing its save folder.`);
  }

  ensureDir(gameSavesRoot);
  const currentSaveSnapshot = snapshotCurrentSave(backupEntry.saveId);
  const destinationSavePath = path.join(gameSavesRoot, backupEntry.saveId);

  removeDirectory(destinationSavePath);
  copyDirectory(backupEntry.saveFolderPath, destinationSavePath);

  logger.info("restore completed", {
    saveId: backupEntry.saveId,
    backupId: backupEntry.backupId,
    restoredTo: destinationSavePath,
    snapshotId: currentSaveSnapshot ? currentSaveSnapshot.snapshotId : null,
  });

  return {
    restoredTo: destinationSavePath,
    snapshot: currentSaveSnapshot,
  };
}

function getLatestContentHashBySaveId(sourceName) {
  const entries = getBackupEntries()
    .filter((entry) => entry.isValid && entry.source === sourceName && entry.contentHash)
    .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
  const latestBySaveId = new Map();

  for (const entry of entries) {
    if (!latestBySaveId.has(entry.saveId)) {
      latestBySaveId.set(entry.saveId, entry.contentHash);
    }
  }

  return latestBySaveId;
}

async function waitForStableSave(folderPath, attempts = 6, delayMs = 350) {
  let previousHash = null;

  for (let index = 0; index < attempts; index += 1) {
    if (!pathExists(folderPath)) {
      await sleep(delayMs);
      continue;
    }

    const currentHash = hashDirectory(folderPath, HASH_OPTIONS);
    if (currentHash && previousHash === currentHash) {
      return currentHash;
    }

    previousHash = currentHash;
    await sleep(delayMs);
  }

  return previousHash;
}

function watchSaveChanges(options = {}) {
  ensureDir(gameSavesRoot);
  ensureDir(autoBackupsRoot);

  const debounceMs = options.debounceMs || 1200;
  const stableAttempts = options.stableAttempts || 6;
  const stableDelayMs = options.stableDelayMs || 350;
  const latestHashes = getLatestContentHashBySaveId("auto-watch");
  const pendingTimers = new Map();
  const inFlight = new Set();
  let watcherClosed = false;

  const log = options.onEvent || (() => {});

  const scheduleSave = (saveId, reason) => {
    if (!saveId) {
      return;
    }

    if (pendingTimers.has(saveId)) {
      clearTimeout(pendingTimers.get(saveId));
    }

    const timer = setTimeout(async () => {
      pendingTimers.delete(saveId);

      if (inFlight.has(saveId) || watcherClosed) {
        return;
      }

      const folderPath = path.join(gameSavesRoot, saveId);
      if (!pathExists(folderPath)) {
        log({ type: "skipped", saveId, reason: "folder-missing" });
        return;
      }

      inFlight.add(saveId);

      try {
        const contentHash = await waitForStableSave(folderPath, stableAttempts, stableDelayMs);
        if (!contentHash) {
          log({ type: "skipped", saveId, reason: "hash-unavailable" });
          return;
        }

        if (latestHashes.get(saveId) === contentHash) {
          log({ type: "deduplicated", saveId, reason, contentHash });
          return;
        }

        const saveEntries = getSaveEntries();
        const saveEntry = saveEntries.find((entry) => entry.saveId === saveId && entry.isValid);
        if (!saveEntry) {
          log({ type: "skipped", saveId, reason: "invalid-save" });
          return;
        }

        const results = backupSaves([saveEntry], {
          targetRoot: autoBackupsRoot,
          source: "auto-watch",
        });
        const result = results[0];
        latestHashes.set(saveId, result.manifest.contentHash);
        logger.info("auto-watch backup", {
          saveId,
          reason,
          backupId: result.backupId,
          label: result.manifest.label,
        });
        log({
          type: "backed-up",
          saveId,
          reason,
          backupId: result.backupId,
          destinationPath: result.destinationPath,
          label: result.manifest.label,
          runLevel: result.manifest.runLevel,
          stateLabel: result.manifest.stateLabel,
          players: result.manifest.players,
          playerCount: result.manifest.playerCount,
          contentHash: result.manifest.contentHash,
        });
      } catch (error) {
        logger.error("auto-watch backup failed", { saveId, reason, error });
        log({ type: "error", saveId, error });
      } finally {
        inFlight.delete(saveId);
      }
    }, debounceMs);

    pendingTimers.set(saveId, timer);
    log({ type: "scheduled", saveId, reason });
  };

  const watcher = fs.watch(gameSavesRoot, { recursive: true }, (eventType, filename) => {
    const relativePath = String(filename || "").replace(/\//g, path.sep);
    const segments = relativePath.split(path.sep).filter(Boolean);
    const saveId = segments[0];

    if (!saveId) {
      return;
    }

    scheduleSave(saveId, `${eventType}:${relativePath || "."}`);
  });

  return {
    close() {
      watcherClosed = true;
      watcher.close();
      for (const timer of pendingTimers.values()) {
        clearTimeout(timer);
      }
      pendingTimers.clear();
    },
  };
}

function resolveEs3Path(entry) {
  if (!entry) {
    return null;
  }
  if (entry.primaryEs3Path && pathExists(entry.primaryEs3Path)) {
    return entry.primaryEs3Path;
  }
  if (entry.saveFolderPath) {
    return findPrimaryEs3InFolder(entry.saveFolderPath, entry.saveId);
  }
  if (entry.folderPath) {
    return findPrimaryEs3InFolder(entry.folderPath, entry.saveId);
  }
  return null;
}

function decryptSaveAsJson(entryOrPath) {
  const es3Path = typeof entryOrPath === "string"
    ? entryOrPath
    : resolveEs3Path(entryOrPath);
  if (!es3Path) {
    return null;
  }
  return decryptEs3File(es3Path);
}

function exportSaveAsJsonFile(entryOrPath, destinationPath) {
  const data = decryptSaveAsJson(entryOrPath);
  if (!data) {
    return null;
  }
  ensureDir(path.dirname(destinationPath));
  fs.writeFileSync(destinationPath, JSON.stringify(data, null, 2) + "\n", "utf8");
  return destinationPath;
}

function buildExportFilename(entry, kind) {
  const identifier = entry?.backupId || entry?.saveId || "save";
  const timestamp = formatLocalTimestamp();
  return `${timestamp}__${sanitizeName(identifier)}__${kind}.json`;
}

function exportEntryToJson(entry, kind) {
  const filename = buildExportFilename(entry, kind);
  const destinationPath = path.join(exportsRoot, filename);
  return exportSaveAsJsonFile(entry, destinationPath);
}

function getAutoBackupsBySaveId() {
  const grouped = new Map();
  for (const entry of readBackupEntriesFromRoot(autoBackupsRoot, "auto-watch")) {
    if (!grouped.has(entry.saveId)) {
      grouped.set(entry.saveId, []);
    }
    grouped.get(entry.saveId).push(entry);
  }
  for (const list of grouped.values()) {
    list.sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
  }
  return grouped;
}

function pruneAutoBackups(saveId, keepCount) {
  if (!Number.isInteger(keepCount) || keepCount < 0) {
    throw new Error(`keepCount must be a non-negative integer, received ${keepCount}.`);
  }
  const entries = readBackupEntriesFromRoot(autoBackupsRoot, "auto-watch")
    .filter((entry) => entry.saveId === saveId)
    .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));

  const removed = [];
  let kept = 0;
  for (const entry of entries) {
    if (entry.isFavorite) {
      continue;
    }
    if (kept < keepCount) {
      kept += 1;
      continue;
    }
    removeDirectory(entry.destinationPath);
    invalidateManifestCache(path.join(entry.destinationPath, "manifest.json"));
    removed.push(entry);
  }
  if (removed.length > 0) {
    logger.info("auto-backups pruned", { saveId, keepCount, removedCount: removed.length });
  }
  return removed;
}

module.exports = {
  autoBackupsRoot,
  backupSaves,
  decryptSaveAsJson,
  exportEntryToJson,
  exportSaveAsJsonFile,
  exportsRoot,
  getAutoBackupsBySaveId,
  getBackupEntries,
  getPathsReport,
  getSaveEntries,
  isGameRunning,
  pruneAutoBackups,
  resolveEs3Path,
  restoreBackup,
  toggleBackupFavorite,
  watchSaveChanges,
};
