#!/usr/bin/env node

const path = require("path");
const readline = require("readline");
const {
  backupSaves,
  getBackupEntries,
  getPathsReport,
  getSaveEntries,
  restoreBackup,
  toggleBackupFavorite,
  watchSaveChanges,
} = require("./save-manager");
const { formatBytes } = require("./fs-utils");
const { askForConfirmation, selectMany, selectOne, waitForEnter, style, ANSI } = require("./prompt");

function printUsage() {
  console.log("Usage:");
  console.log("  node ./src/cli.js");
  console.log("  npm start");
  console.log("  npx @tacuchi/repo-tools");
  console.log("");
  console.log("This CLI opens an interactive menu.");
}

function printBanner() {
  const lines = [
    " _____  _    ____ _   _  ____ _   _ ___ ",
    "|_   _|/ \\  / ___| | | |/ ___| | | |_ _|",
    "  | | / _ \\| |   | | | | |   | |_| || | ",
    "  | |/ ___ \\ |___| |_| | |___|  _  || | ",
    "  |_/_/   \\_\\____|\\___/ \\____|_| |_|___|",
    "R.E.P.O. Tools CLI",
  ];

  console.log(style(lines[0], ANSI.green, ANSI.bold));
  for (const line of lines.slice(1, 5)) {
    console.log(style(line, ANSI.green));
  }
  console.log(style(lines[5], ANSI.dim, ANSI.cyan));
  console.log("");
}

function formatDate(isoString) {
  return new Date(isoString).toLocaleString();
}

function formatClock(dateValue) {
  if (!dateValue) {
    return "-";
  }

  return new Date(dateValue).toLocaleTimeString();
}

function formatDuration(startedAt) {
  if (!startedAt) {
    return "0s";
  }

  const elapsedMs = Math.max(0, Date.now() - startedAt.getTime());
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes <= 0) {
    return `${seconds}s`;
  }

  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function truncate(value, width) {
  const text = String(value ?? "");
  if (text.length <= width) {
    return text;
  }
  if (width <= 3) {
    return text.slice(0, width);
  }
  return `${text.slice(0, width - 3)}...`;
}

function pad(value, width, align = "left") {
  const text = truncate(value, width);
  return align === "right" ? text.padStart(width, " ") : text.padEnd(width, " ");
}

function printStaticTable(title, columns, rows) {
  console.log(style(title, ANSI.bold, ANSI.cyan));
  console.log("");

  if (rows.length === 0) {
    console.log("No hay datos para mostrar.");
    return;
  }

  const header = columns.map((column) => pad(column.title, column.width, column.align)).join("  ");
  console.log(style(header, ANSI.bold));
  console.log(style("-".repeat(header.length), ANSI.dim));

  for (const row of rows) {
    const line = columns
      .map((column) => pad(row[column.key], column.width, column.align))
      .join("  ");
    console.log(line);
  }
}

function clearRenderedLines(lineCount) {
  for (let index = 0; index < lineCount; index += 1) {
    readline.moveCursor(process.stdout, 0, -1);
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
  }
}

function getSaveTableColumns() {
  return [
    { key: "saveId", title: "Save ID", width: 22 },
    { key: "modifiedAt", title: "Fecha", width: 20 },
    { key: "team", title: "Equipo", width: 14 },
    { key: "players", title: "Jugadores", width: 26 },
    { key: "level", title: "Nivel", width: 7, align: "right" },
    { key: "state", title: "Estado", width: 17 },
    { key: "size", title: "Tamano", width: 10, align: "right" },
    { key: "status", title: "Valido", width: 8 },
  ];
}

function getBackupTableColumns() {
  return [
    { key: "favorite", title: "Fav", width: 3 },
    { key: "saveId", title: "Save ID", width: 20 },
    { key: "createdAt", title: "Fecha", width: 20 },
    { key: "players", title: "Jugadores", width: 22 },
    { key: "progress", title: "Progreso", width: 20 },
    { key: "source", title: "Origen", width: 12 },
    { key: "size", title: "Tamano", width: 10, align: "right" },
    { key: "label", title: "Etiqueta", width: 22 },
  ];
}

function formatPlayers(players, playerCount) {
  const list = Array.isArray(players) ? players.filter(Boolean) : [];
  const count = Number.isInteger(playerCount) ? playerCount : list.length;

  if (count === 0) {
    return "0 players";
  }

  if (list.length === 0) {
    return `${count} players`;
  }

  if (list.length <= 2) {
    return list.join(", ");
  }

  return `${list.slice(0, 2).join(", ")} +${Math.max(0, count - 2)}`;
}

function formatStateLabel(value) {
  switch (value) {
    case "post-extraction":
      return "Post-Extraction";
    case "shop-or-pre-run":
      return "Shop/Pre-Run";
    default:
      return "Unknown";
  }
}

function formatLevel(value) {
  return Number.isInteger(value) ? `L${value}` : "-";
}

function formatProgress(level, stateLabel) {
  return `${formatLevel(level)} | ${formatStateLabel(stateLabel)}`;
}

function toSaveRow(saveEntry) {
  return {
    saveId: saveEntry.saveId,
    modifiedAt: formatDate(saveEntry.modifiedAt),
    team: saveEntry.teamName || "Unknown team",
    players: formatPlayers(saveEntry.players, saveEntry.playerCount),
    level: formatLevel(saveEntry.runLevel),
    state: formatStateLabel(saveEntry.stateLabel),
    size: formatBytes(saveEntry.sizeBytes),
    status: saveEntry.isValid ? "valid" : "invalid",
  };
}

function toBackupRow(entry) {
  return {
    favorite: entry.isFavorite ? "[*]" : "-",
    saveId: entry.saveId,
    createdAt: formatDate(entry.createdAt),
    players: formatPlayers(entry.players, entry.playerCount),
    progress: formatProgress(entry.runLevel, entry.stateLabel),
    source: entry.source,
    size: formatBytes(entry.sizeBytes),
    label: entry.isFavorite
      ? `FAV ${entry.label || "-"}`
      : entry.label || "-",
  };
}

function toCreatedBackupRow(result) {
  return {
    favorite: result.manifest.isFavorite ? "[*]" : "-",
    saveId: result.manifest.saveId,
    createdAt: formatDate(result.manifest.createdAt),
    players: formatPlayers(result.manifest.players, result.manifest.playerCount),
    progress: formatProgress(result.manifest.runLevel, result.manifest.stateLabel),
    source: result.manifest.source,
    size: formatBytes(result.manifest.sizeBytes),
    label: result.manifest.isFavorite
      ? `FAV ${result.manifest.label || "-"}`
      : result.manifest.label || "-",
  };
}

async function runScanSaves() {
  const saveEntries = getSaveEntries();
  if (saveEntries.length === 0) {
    console.log("No save folders were found in the R.E.P.O. saves directory.");
    await waitForEnter("Press Enter to return to the menu.");
    return;
  }

  printStaticTable(
    "Partidas actuales detectadas",
    getSaveTableColumns(),
    saveEntries.map(toSaveRow),
  );
  console.log("");

  const selectedAction = await selectOne(
    [
      {
        action: "backup",
        label: "Guardar partidas seleccionadas",
        details: "Selecciona una o varias partidas activas y crea backups locales.",
      },
      {
        action: "back",
        label: "Volver",
        details: "Regresa al menu principal.",
      },
    ],
    "Acciones para las partidas escaneadas:",
  );

  if (selectedAction === null || selectedAction.action === "back") {
    return;
  }

  const validSaveEntries = saveEntries.filter((saveEntry) => saveEntry.isValid);
  if (validSaveEntries.length === 0) {
    console.log("No valid save folders were found to back up.");
    console.log("");
    await waitForEnter("Press Enter to return to the menu.");
    return;
  }

  const selectedItems = await selectMany(
    validSaveEntries.map((saveEntry) => ({
      ...saveEntry,
      hint: path.basename(saveEntry.primaryEs3Path),
    })),
    "Selecciona las partidas actuales para guardar:",
    {
      columns: getSaveTableColumns(),
      renderRow: (item) => toSaveRow(item),
    },
  );

  if (selectedItems === null) {
    return;
  }

  if (selectedItems.length === 0) {
    console.log("No saves selected. Nothing was backed up.");
    console.log("");
    await waitForEnter("Press Enter to return to the menu.");
    return;
  }

  console.log("");
  printStaticTable(
    "Partidas seleccionadas",
    getSaveTableColumns(),
    selectedItems.map(toSaveRow),
  );

  const confirmed = await askForConfirmation("Guardar las partidas seleccionadas en este proyecto");
  if (!confirmed) {
    return;
  }

  const results = backupSaves(selectedItems);
  console.log("");
  printStaticTable(
    "Backups creados",
    getBackupTableColumns(),
    results.map(toCreatedBackupRow),
  );
  console.log("");
  await waitForEnter("Press Enter to return to the menu.");
}

async function runRestore() {
  while (true) {
    const backups = getBackupEntries().filter((entry) => entry.isValid);
    if (backups.length === 0) {
      console.log("No local backups were found in this project.");
      await waitForEnter("Press Enter to return to the menu.");
      return;
    }

    const selectedItem = await selectOne(
      backups,
      "Selecciona una partida guardada:",
      {
        columns: getBackupTableColumns(),
        renderRow: (item) => toBackupRow(item),
      },
    );

    if (selectedItem === null) {
      return;
    }

    const selectedAction = await selectOne(
      [
        {
          action: "restore",
          label: "Restaurar partida",
          details: "Restaura este backup en la carpeta del juego.",
        },
        {
          action: "favorite",
          label: selectedItem.isFavorite ? "Quitar favorito" : "Marcar como favorito",
          details: selectedItem.isFavorite
            ? "Remueve la estrella de este backup."
            : "Marca este backup como importante.",
        },
        {
          action: "back",
          label: "Volver",
          details: "Regresa a la lista de partidas guardadas.",
        },
      ],
      `Acciones para ${selectedItem.saveId}:`,
    );

    if (selectedAction === null || selectedAction.action === "back") {
      continue;
    }

    if (selectedAction.action === "favorite") {
      const updatedEntry = toggleBackupFavorite(selectedItem.backupId);
      console.log("");
      console.log(updatedEntry.isFavorite
        ? "Backup marcado como favorito."
        : "Favorito removido del backup.");
      console.log("");
      printStaticTable(
        "Backup actualizado",
        getBackupTableColumns(),
        [toBackupRow(updatedEntry)],
      );
      console.log("");
      await waitForEnter("Press Enter to return to the list.");
      continue;
    }

    if (selectedAction.action === "restore") {
      console.log("");
      printStaticTable(
        "Backup elegido para restaurar",
        getBackupTableColumns(),
        [toBackupRow(selectedItem)],
      );
      console.log("");
      console.log(`Game destination: ${path.join(getPathsReport().gameSavesRoot, selectedItem.saveId)}`);
      console.log("A pre-restore snapshot of the current game save will be created automatically if that save already exists.");

      const confirmed = await askForConfirmation("Restaurar este backup en la carpeta del juego");
      if (!confirmed) {
        continue;
      }

      const result = restoreBackup(selectedItem);
      console.log("");
      console.log(`Restore complete: ${result.restoredTo}`);
      if (result.snapshot) {
        console.log(`Pre-restore snapshot: ${result.snapshot.snapshotPath}`);
      }
      console.log("");
      await waitForEnter("Press Enter to return to the menu.");
      return;
    }
  }
}

async function runWatch() {
  const report = getPathsReport();
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Auto-watch requires a TTY terminal.");
  }

  const spinnerFrames = ["-", "\\", "|", "/"];
  const state = {
    runningSince: new Date(),
    lastEventAt: null,
    lastBackupAt: null,
    totalBackupsCreatedThisSession: 0,
    lastBackupSummary: "No backups created yet.",
    lastError: null,
    lastSaveId: "-",
    activity: ["Waiting for save changes..."],
    renderedLines: 0,
    spinnerIndex: 0,
  };

  const pushActivity = (message, tone = "normal") => {
    const prefix = formatClock(new Date());
    const line = `[${prefix}] ${message}`;
    state.activity.unshift(
      tone === "error"
        ? style(line, ANSI.red)
        : tone === "success"
          ? style(line, ANSI.green)
          : tone === "muted"
            ? style(line, ANSI.dim)
            : line,
    );
    state.activity = state.activity.slice(0, 5);
  };

  const render = () => {
    const spinner = spinnerFrames[state.spinnerIndex % spinnerFrames.length];
    const lines = [
      style("Auto-guardado activo", ANSI.bold, ANSI.cyan),
      `${style("Status", ANSI.bold)}  ${style(`${spinner} RUNNING`, ANSI.green)}`,
      `${style("Activo", ANSI.bold)}  ${formatDuration(state.runningSince)}`,
      `${style("Observando", ANSI.bold)}  ${report.gameSavesRoot}`,
      `${style("Destino", ANSI.bold)}  ${report.autoBackupsRoot}`,
      "",
      `${style("Ultimo cambio", ANSI.bold)}  ${formatClock(state.lastEventAt)}`,
      `${style("Ultimo backup", ANSI.bold)}  ${formatClock(state.lastBackupAt)}`,
      `${style("Sesión", ANSI.bold)}  ${state.totalBackupsCreatedThisSession} backups creados`,
      `${style("Ultima partida", ANSI.bold)}  ${state.lastSaveId}`,
      `${style("Resumen", ANSI.bold)}  ${state.lastBackupSummary}`,
      `${style("Error", ANSI.bold)}  ${state.lastError || "-"}`,
      "",
      style("Actividad reciente", ANSI.bold),
      ...state.activity,
      "",
      style("Esc: volver al menu | Ctrl+C: cerrar la aplicacion", ANSI.dim),
    ];

    if (state.renderedLines > 0) {
      clearRenderedLines(state.renderedLines);
    }

    process.stdout.write(lines.join("\n") + "\n");
    state.renderedLines = lines.length;
  };

  const handleEvent = (payload) => {
    state.lastEventAt = new Date();
    state.lastSaveId = payload.saveId || state.lastSaveId;

    switch (payload.type) {
      case "scheduled":
        pushActivity(`Cambio detectado en ${payload.saveId}`, "muted");
        break;
      case "deduplicated":
        pushActivity(`Sin cambios reales en ${payload.saveId}`, "muted");
        break;
      case "backed-up":
        state.lastBackupAt = new Date();
        state.totalBackupsCreatedThisSession += 1;
        state.lastBackupSummary = `${formatLevel(payload.runLevel)} | ${formatStateLabel(payload.stateLabel)} | ${formatPlayers(payload.players, payload.playerCount)}`;
        state.lastError = null;
        pushActivity(`Backup creado para ${payload.saveId}`, "success");
        break;
      case "skipped":
        pushActivity(`Cambio ignorado en ${payload.saveId}`, "muted");
        break;
      case "error":
        state.lastError = payload.error?.message || "Unknown error";
        pushActivity(`Error en ${payload.saveId}: ${state.lastError}`, "error");
        break;
      default:
        break;
    }

    render();
  };

  await new Promise((resolve, reject) => {
    const watcher = watchSaveChanges({ onEvent: handleEvent });
    const timer = setInterval(() => {
      state.spinnerIndex = (state.spinnerIndex + 1) % spinnerFrames.length;
      render();
    }, 250);

    let closed = false;

    const cleanup = () => {
      if (closed) {
        return;
      }
      closed = true;
      clearInterval(timer);
      watcher.close();
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.removeListener("SIGINT", onSigint);
      if (state.renderedLines > 0) {
        clearRenderedLines(state.renderedLines);
        state.renderedLines = 0;
      }
    };

    const onSigint = () => {
      cleanup();
      process.stdout.write("Watcher stopped.\n");
      process.exit(0);
    };

    const onData = (buffer) => {
      const input = buffer.toString("utf8");
      if (input === "\u001b") {
        cleanup();
        resolve();
        return;
      }

      if (input === "\u0003") {
        onSigint();
      }
    };

    try {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("data", onData);
      process.on("SIGINT", onSigint);
      render();
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

async function runPaths() {
  const report = getPathsReport();
  console.log(style("Rutas detectadas", ANSI.bold, ANSI.cyan));
  console.log("");
  console.log(`Game data root     ${report.gameDataRoot}`);
  console.log(`Game saves root    ${report.gameSavesRoot}`);
  console.log(`User backups       ${report.backupsRoot}`);
  console.log(`Auto-backups root  ${report.autoBackupsRoot}`);
  console.log(`Pre-restore root   ${report.preRestoreRoot}`);
  console.log("");
  await waitForEnter("Press Enter to return to the menu.");
}

async function main() {
  try {
    if (process.argv.length > 2) {
      printUsage();
      process.exitCode = 1;
      return;
    }

    printBanner();

    while (true) {
      const selectedAction = await selectOne(
        [
          {
            action: "scan",
            label: "Escanear partidas",
            details: "Escanea las partidas actuales y permite guardarlas.",
          },
          {
            action: "restore",
            label: "Listar partidas guardadas",
            details: "Explora backups y elige si restaurar o marcar favorito.",
          },
          {
            action: "watch",
            label: "Iniciar auto-guardado por cambios",
            details: "Observa cambios en saves y genera snapshots automaticos.",
          },
          {
            action: "paths",
            label: "Ver rutas detectadas",
            details: "Muestra las rutas usadas por el juego y la aplicacion.",
          },
          {
            action: "exit",
            label: "Salir",
            details: "Cierra la aplicacion.",
          },
        ],
        "Elige la accion que quieres realizar:",
      );

      if (selectedAction === null) {
        continue;
      }

      try {
        switch (selectedAction.action) {
          case "scan":
            await runScanSaves();
            break;
          case "restore":
            await runRestore();
            break;
          case "watch":
            await runWatch();
            break;
          case "paths":
            await runPaths();
            break;
          case "exit":
            console.log("Aplicacion cerrada.");
            return;
          default:
            throw new Error(`Unsupported action: ${selectedAction.action}`);
        }
      } catch (error) {
        console.error(`Error: ${error.message}`);
        console.log("");
        await waitForEnter("Press Enter to return to the menu.");
      }
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
