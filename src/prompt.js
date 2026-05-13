const readline = require("readline");

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  bgCyan: "\x1b[46m",
  black: "\x1b[30m",
  inverse: "\x1b[7m",
};

function supportsAnsi() {
  return Boolean(process.stdout.isTTY && process.env.NO_COLOR !== "1");
}

function style(text, ...codes) {
  if (!supportsAnsi()) {
    return text;
  }

  return `${codes.join("")}${text}${ANSI.reset}`;
}

function visibleLength(text) {
  return String(text).replace(/\x1b\[[0-9;]*m/g, "").length;
}

function truncate(text, width) {
  const value = String(text ?? "");
  if (width <= 0) {
    return "";
  }
  if (value.length <= width) {
    return value.padEnd(width, " ");
  }
  if (width <= 3) {
    return value.slice(0, width);
  }
  return `${value.slice(0, width - 3)}...`;
}

function padVisible(text, width) {
  const currentLength = visibleLength(text);
  if (currentLength >= width) {
    return text;
  }
  return text + " ".repeat(width - currentLength);
}

function clearScreen(lines) {
  for (let index = 0; index < lines; index += 1) {
    readline.moveCursor(process.stdout, 0, -1);
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
  }
}

function askForConfirmation(message) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(`${message} (y/N): `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(String(answer).trim()));
    });
  });
}

function waitForEnter(message = "Press Enter to return to the menu.") {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      resolve();
      return;
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(`${message}`, () => {
      rl.close();
      resolve();
    });
  });
}

function getTerminalWidth() {
  if (!process.stdout.isTTY || !process.stdout.columns) {
    return 100;
  }
  return Math.max(80, process.stdout.columns);
}

function getTerminalHeight() {
  if (!process.stdout.isTTY || !process.stdout.rows) {
    return 24;
  }
  return Math.max(10, process.stdout.rows);
}

function getMenuViewport(state) {
  const reserved = 9;
  const available = Math.max(4, getTerminalHeight() - reserved);
  const hasDetails = state.filtered.some((item) => item && item.details);
  const perItem = hasDetails ? 2 : 1;
  return Math.max(1, Math.floor(available / perItem));
}

function getTableViewport() {
  const reserved = 11;
  return Math.max(3, getTerminalHeight() - reserved);
}

function getViewport(state) {
  return state.columns ? getTableViewport() : getMenuViewport(state);
}

function getSearchableText(item, columns, renderRow) {
  if (!item) {
    return "";
  }
  if (columns && typeof renderRow === "function") {
    const row = renderRow(item, columns) || {};
    return Object.values(row).map((value) => String(value ?? "")).join(" ").toLowerCase();
  }
  const label = String(item.label ?? "");
  const details = String(item.details ?? "");
  return `${label} ${details}`.toLowerCase();
}

function getActiveTogglePredicates(state) {
  if (!state.toggleFilters || state.toggleFilters.length === 0) {
    return [];
  }
  const predicates = [];
  for (const filter of state.toggleFilters) {
    const index = state.toggleStates.get(filter.key) ?? 0;
    const slot = filter.cycle[index];
    if (slot && typeof slot.predicate === "function") {
      predicates.push(slot.predicate);
    }
  }
  return predicates;
}

function applyFilter(state) {
  const query = state.searchQuery.trim().toLowerCase();
  let result = state.items;

  const togglePredicates = getActiveTogglePredicates(state);
  if (togglePredicates.length > 0) {
    result = result.filter((item) => togglePredicates.every((predicate) => predicate(item)));
  }

  if (query) {
    result = result.filter((item) =>
      getSearchableText(item, state.columns, state.renderRow).includes(query),
    );
  }

  state.filtered = result;
  if (state.filtered.length === 0) {
    state.cursor = 0;
    state.viewportOffset = 0;
    return;
  }
  if (state.cursor >= state.filtered.length) {
    state.cursor = state.filtered.length - 1;
  }
  if (state.cursor < 0) {
    state.cursor = 0;
  }
}

function buildToggleSummary(state) {
  if (!state.toggleFilters || state.toggleFilters.length === 0) {
    return "";
  }
  return state.toggleFilters
    .map((filter) => {
      const index = state.toggleStates.get(filter.key) ?? 0;
      const slot = filter.cycle[index];
      return `${filter.label}: ${slot ? slot.label : "?"}`;
    })
    .join(" | ");
}

function ensureCursorVisible(state) {
  const viewport = getViewport(state);
  if (state.filtered.length === 0) {
    state.viewportOffset = 0;
    return;
  }
  if (state.cursor < state.viewportOffset) {
    state.viewportOffset = state.cursor;
  } else if (state.cursor >= state.viewportOffset + viewport) {
    state.viewportOffset = state.cursor - viewport + 1;
  }
  const maxOffset = Math.max(0, state.filtered.length - viewport);
  if (state.viewportOffset > maxOffset) {
    state.viewportOffset = maxOffset;
  }
  if (state.viewportOffset < 0) {
    state.viewportOffset = 0;
  }
}

function buildPositionLine(state) {
  const total = state.filtered.length;
  if (total === 0) {
    return state.searchQuery
      ? `Sin coincidencias para "${state.searchQuery}" (${state.items.length} total)`
      : "Sin items para mostrar.";
  }
  const viewport = getViewport(state);
  const from = state.viewportOffset + 1;
  const to = Math.min(total, state.viewportOffset + viewport);
  const page = Math.floor(state.viewportOffset / viewport) + 1;
  const totalPages = Math.max(1, Math.ceil(total / viewport));
  const filterNote = state.searchQuery
    ? ` | filtro "${state.searchQuery}" (${total}/${state.items.length})`
    : "";
  const toggleSummary = buildToggleSummary(state);
  const toggleNote = toggleSummary ? ` | ${toggleSummary}` : "";
  return `Item ${state.cursor + 1} de ${total} | ventana ${from}-${to} | pagina ${page}/${totalPages}${filterNote}${toggleNote}`;
}

function buildToggleHelp(state) {
  if (!state.toggleFilters || state.toggleFilters.length === 0) {
    return "";
  }
  const parts = state.toggleFilters.map((filter) => `${filter.key}=${filter.label.toLowerCase()}`);
  return ` | ${parts.join(" ")}`;
}

function getActiveHelpText(state) {
  if (state.searchMode) {
    return "Escribe para filtrar | Enter aplica | Esc cancela | Ctrl+C salir";
  }
  if (state.helpText) {
    return state.helpText;
  }
  const toggleHelp = buildToggleHelp(state);
  return state.multi
    ? `Up/Down navega | Espacio marca | / busca${toggleHelp} | PgUp/PgDn salta | Home/End extremos | Enter confirma | Esc vuelve | Ctrl+C salir`
    : `Up/Down navega | / busca${toggleHelp} | PgUp/PgDn salta | Home/End extremos | Enter confirma | Esc vuelve | Ctrl+C salir`;
}

function normalizeColumns(columns) {
  return columns.map((column) => ({
    key: column.key,
    title: column.title,
    width: column.width,
    align: column.align || "left",
  }));
}

function formatCell(value, width, align = "left") {
  const text = truncate(value ?? "", width);
  return align === "right" ? text.padStart(width, " ") : text.padEnd(width, " ");
}

function buildTableLine(values, columns, separator = "  ") {
  return columns
    .map((column) => formatCell(values[column.key], column.width, column.align))
    .join(separator);
}

function colorizeStatus(value) {
  const text = String(value ?? "");
  if (/^(yes|valid|manual)$/i.test(text)) {
    return style(text, ANSI.green);
  }
  if (/^(no|invalid|pre-restore)$/i.test(text)) {
    return style(text, ANSI.red);
  }
  if (/auto-watch/i.test(text)) {
    return style(text, ANSI.cyan);
  }
  return text;
}

function colorizeFavorite(value) {
  const text = String(value ?? "");
  if (text.trim() === "[*]" || text.trim() === "*") {
    return style(text, ANSI.yellow, ANSI.bold);
  }
  return style(text, ANSI.dim);
}

function defaultRenderRow(item, columns) {
  const row = {};
  for (const column of columns) {
    const rawValue = item[column.key];
    row[column.key] = rawValue == null ? "" : String(rawValue);
  }
  return row;
}

function renderSearchBar(state) {
  if (!state.searchMode && !state.searchQuery) {
    return null;
  }
  const prefix = state.searchMode
    ? style("Buscar:", ANSI.bold, ANSI.cyan)
    : style("Filtro activo:", ANSI.bold, ANSI.yellow);
  const cursor = state.searchMode ? style("_", ANSI.bold) : "";
  return `${prefix} ${state.searchQuery}${cursor}`;
}

function renderMenu(state) {
  const output = [];
  const total = state.filtered.length;
  const viewport = getMenuViewport(state);
  const offset = state.viewportOffset;
  const end = Math.min(total, offset + viewport);
  const visible = state.filtered.slice(offset, end);

  output.push(style(state.message, ANSI.bold, ANSI.cyan));
  output.push(style(buildPositionLine(state), ANSI.dim));
  output.push(style(getActiveHelpText(state), ANSI.dim));
  output.push("");

  if (offset > 0) {
    output.push(style(`  ^ ${offset} mas arriba`, ANSI.dim));
  }

  if (visible.length === 0) {
    output.push(style("   (sin coincidencias)", ANSI.dim));
  } else {
    visible.forEach((item, vIndex) => {
      const index = offset + vIndex;
      const focused = index === state.cursor;
      const pointer = focused ? style(">>", ANSI.bold, ANSI.cyan) : "  ";
      const label = focused
        ? style(item.label, ANSI.inverse)
        : style(item.label, ANSI.bold);
      output.push(`${pointer} ${label}`);
      if (item.details) {
        output.push(`   ${style(item.details, ANSI.dim)}`);
      }
    });
  }

  if (end < total) {
    output.push(style(`  v ${total - end} mas abajo`, ANSI.dim));
  }

  const searchBar = renderSearchBar(state);
  if (searchBar) {
    output.push("");
    output.push(searchBar);
  }

  process.stdout.write(output.join("\n") + "\n");
  return output.length;
}

function computeTableColumns(state) {
  const baseColumns = normalizeColumns(state.columns);
  const terminalWidth = getTerminalWidth();
  const separatorWidth = 2;
  const controlWidth = state.multi ? 6 : 3;
  const desiredWidth = controlWidth + baseColumns.reduce((sum, column) => sum + column.width, 0) + (baseColumns.length - 1) * separatorWidth;

  if (desiredWidth <= terminalWidth) {
    return baseColumns;
  }

  let overflow = desiredWidth - terminalWidth;
  const shrinkable = [...baseColumns].sort((left, right) => right.width - left.width);

  for (const column of shrinkable) {
    const minWidth = Math.max(8, Math.min(column.width, String(column.title).length + 2));
    const available = column.width - minWidth;
    if (available <= 0) {
      continue;
    }

    const reduction = Math.min(available, overflow);
    column.width -= reduction;
    overflow -= reduction;
    if (overflow <= 0) {
      break;
    }
  }

  return baseColumns;
}

function renderTable(state) {
  const output = [];
  const columns = computeTableColumns(state);
  const rowRenderer = state.renderRow || defaultRenderRow;
  const total = state.filtered.length;
  const viewport = getTableViewport();
  const offset = state.viewportOffset;
  const end = Math.min(total, offset + viewport);
  const visible = state.filtered.slice(offset, end);

  output.push(style(state.message, ANSI.bold, ANSI.cyan));
  output.push(style(buildPositionLine(state), ANSI.dim));
  output.push(style(getActiveHelpText(state), ANSI.dim));
  output.push("");

  const headerMap = {};
  for (const column of columns) {
    headerMap[column.key] = column.title;
  }

  const controlHeader = state.multi ? "Sel" : "Nav";
  const headerLine = `${controlHeader.padEnd(state.multi ? 5 : 3, " ")}${buildTableLine(headerMap, columns)}`;
  output.push(style(headerLine, ANSI.bold));
  output.push(style("-".repeat(visibleLength(headerLine)), ANSI.dim));

  if (offset > 0) {
    output.push(style(`  ^ ${offset} mas arriba`, ANSI.dim));
  }

  if (visible.length === 0) {
    output.push(style("   (sin coincidencias)", ANSI.dim));
  } else {
    visible.forEach((item, vIndex) => {
      const index = offset + vIndex;
      const focused = index === state.cursor;
      const isSelected = state.multi ? state.selected.has(item) : false;
      const prefix = state.multi
        ? `${focused ? ">" : " "} ${isSelected ? "[x]" : "[ ]"} `
        : `${focused ? ">" : " "}  `;
      const rawRow = rowRenderer(item, columns);

      const cells = columns.map((column) => {
        const plainValue = rawRow[column.key] ?? "";
        const visibleText = truncate(plainValue, column.width);
        const paddedPlain = column.align === "right"
          ? visibleText.padStart(column.width, " ")
          : visibleText.padEnd(column.width, " ");
        let paddedStyled = paddedPlain;
        if (column.key === "status" || column.key === "source") {
          paddedStyled = colorizeStatus(paddedPlain);
        } else if (column.key === "favorite") {
          paddedStyled = colorizeFavorite(paddedPlain);
        }
        return padVisible(paddedStyled, column.width);
      });

      let rowText = prefix + cells.join("  ");
      if (focused) {
        rowText = style(rowText, ANSI.inverse);
      } else if (item && item.isFavorite) {
        rowText = style(rowText, ANSI.bold);
      }
      output.push(rowText);
    });
  }

  if (end < total) {
    output.push(style(`  v ${total - end} mas abajo`, ANSI.dim));
  }

  const searchBar = renderSearchBar(state);
  if (searchBar) {
    output.push("");
    output.push(searchBar);
  }

  process.stdout.write(output.join("\n") + "\n");
  return output.length;
}

function createSelectionPromise(items, message, options = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return Promise.reject(new Error("Interactive selection requires a TTY terminal."));
  }

  if (items.length === 0) {
    return options.multi ? Promise.resolve([]) : Promise.reject(new Error("No item selected."));
  }

  return new Promise((resolve) => {
    const toggleFilters = Array.isArray(options.toggleFilters) ? options.toggleFilters : [];
    const toggleStates = new Map();
    for (const filter of toggleFilters) {
      toggleStates.set(filter.key, 0);
    }

    const state = {
      items,
      filtered: items,
      message,
      cursor: 0,
      viewportOffset: 0,
      selected: new Set(),
      renderedLines: 0,
      multi: Boolean(options.multi),
      columns: options.columns || null,
      renderRow: options.renderRow || null,
      searchQuery: "",
      searchMode: false,
      helpText: options.helpText || "",
      toggleFilters,
      toggleStates,
    };

    applyFilter(state);

    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stdout.removeListener("resize", onResize);
    };

    const repaint = () => {
      if (state.renderedLines > 0) {
        clearScreen(state.renderedLines);
      }
      ensureCursorVisible(state);
      state.renderedLines = state.columns ? renderTable(state) : renderMenu(state);
    };

    const finish = (result) => {
      cleanup();
      process.stdout.write("\n");
      resolve(result);
    };

    const goBack = () => {
      cleanup();
      process.stdout.write("\n");
      resolve(null);
    };

    const interrupt = () => {
      cleanup();
      process.stdout.write("\n");
      process.kill(process.pid, "SIGINT");
    };

    const moveCursor = (delta) => {
      if (state.filtered.length === 0) {
        return;
      }
      state.cursor = Math.max(0, Math.min(state.filtered.length - 1, state.cursor + delta));
    };

    const jumpTo = (index) => {
      if (state.filtered.length === 0) {
        return;
      }
      state.cursor = Math.max(0, Math.min(state.filtered.length - 1, index));
    };

    const onResize = () => {
      state.renderedLines = 0;
      process.stdout.write("\x1b[2J\x1b[H");
      repaint();
    };

    const onData = (buffer) => {
      const input = buffer.toString("utf8");

      if (state.searchMode) {
        if (input === "") {
          interrupt();
          return;
        }
        if (input === "") {
          state.searchMode = false;
          state.searchQuery = "";
          applyFilter(state);
          repaint();
          return;
        }
        if (input === "\r") {
          state.searchMode = false;
          repaint();
          return;
        }
        if (input === "" || input === "\b") {
          state.searchQuery = state.searchQuery.slice(0, -1);
          applyFilter(state);
          repaint();
          return;
        }
        if (input.length === 1 && input >= " " && input <= "~") {
          state.searchQuery += input;
          applyFilter(state);
          repaint();
          return;
        }
        return;
      }

      if (input === "") {
        interrupt();
        return;
      }

      if (input === "") {
        if (state.searchQuery) {
          state.searchQuery = "";
          applyFilter(state);
          repaint();
          return;
        }
        goBack();
        return;
      }

      if (input === "[A") {
        moveCursor(-1);
        repaint();
        return;
      }

      if (input === "[B") {
        moveCursor(1);
        repaint();
        return;
      }

      if (input === "[5~") {
        moveCursor(-getViewport(state));
        repaint();
        return;
      }

      if (input === "[6~") {
        moveCursor(getViewport(state));
        repaint();
        return;
      }

      if (input === "[H" || input === "[1~" || input === "OH") {
        jumpTo(0);
        repaint();
        return;
      }

      if (input === "[F" || input === "[4~" || input === "OF") {
        jumpTo(state.filtered.length - 1);
        repaint();
        return;
      }

      if (input === "/") {
        state.searchMode = true;
        repaint();
        return;
      }

      if (state.toggleFilters.length > 0) {
        let handled = false;
        for (const filter of state.toggleFilters) {
          if (input === filter.key) {
            const currentIndex = state.toggleStates.get(filter.key) ?? 0;
            const nextIndex = (currentIndex + 1) % filter.cycle.length;
            state.toggleStates.set(filter.key, nextIndex);
            applyFilter(state);
            repaint();
            handled = true;
            break;
          }
        }
        if (handled) {
          return;
        }
      }

      if (state.multi && input === " ") {
        const item = state.filtered[state.cursor];
        if (item) {
          if (state.selected.has(item)) {
            state.selected.delete(item);
          } else {
            state.selected.add(item);
          }
        }
        repaint();
        return;
      }

      if (input === "\r") {
        if (state.multi) {
          const selectedItems = state.items.filter((item) => state.selected.has(item));
          finish(selectedItems);
          return;
        }
        const item = state.filtered[state.cursor];
        if (item) {
          finish(item);
        }
      }
    };

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
    process.stdout.on("resize", onResize);
    repaint();
  });
}

function selectMany(items, message, options = {}) {
  return createSelectionPromise(items, message, { ...options, multi: true });
}

function selectOne(items, message, options = {}) {
  return createSelectionPromise(items, message, { ...options, multi: false });
}

module.exports = {
  askForConfirmation,
  selectMany,
  selectOne,
  waitForEnter,
  style,
  ANSI,
};
