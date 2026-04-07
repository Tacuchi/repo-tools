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

function renderMenu(state) {
  const output = [];
  output.push(style(state.message, ANSI.bold, ANSI.cyan));
  output.push(style("Use Up/Down to move, Enter to confirm, Esc to go back, Ctrl+C to exit.", ANSI.dim));
  output.push("");

  state.items.forEach((item, index) => {
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
  output.push(style(state.message, ANSI.bold, ANSI.cyan));
  output.push(style(state.helpText, ANSI.dim));
  output.push("");

  const headerMap = {};
  for (const column of columns) {
    headerMap[column.key] = column.title;
  }

  const controlHeader = state.multi ? "Sel" : "Nav";
  const headerLine = `${controlHeader.padEnd(state.multi ? 5 : 3, " ")}${buildTableLine(headerMap, columns)}`;
  output.push(style(headerLine, ANSI.bold));
  output.push(style("-".repeat(visibleLength(headerLine)), ANSI.dim));

  state.items.forEach((item, index) => {
    const focused = index === state.cursor;
    const selected = state.multi ? state.selected.has(index) : false;
    const prefix = state.multi
      ? `${focused ? ">" : " "} ${selected ? "[x]" : "[ ]"} `
      : `${focused ? ">" : " "}  `;
    const rawRow = rowRenderer(item, columns);
    const coloredRow = {};

    for (const column of columns) {
      const value = rawRow[column.key] ?? "";
      coloredRow[column.key] = column.key === "status" || column.key === "source"
        ? colorizeStatus(value)
        : String(value);
    }

    const cells = columns
      .map((column) => {
        const plainValue = rawRow[column.key] ?? "";
        const visible = truncate(plainValue, column.width);
        const paddedPlain = column.align === "right"
          ? visible.padStart(column.width, " ")
          : visible.padEnd(column.width, " ");
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

  return new Promise((resolve, reject) => {
    const state = {
      items,
      message,
      cursor: 0,
      selected: new Set(),
      renderedLines: 0,
      multi: Boolean(options.multi),
      columns: options.columns || null,
      renderRow: options.renderRow || null,
      helpText: options.helpText || (options.multi
        ? "Use Up/Down to move, Space to toggle, Enter to confirm, Esc to go back, Ctrl+C to exit."
        : "Use Up/Down to move, Enter to confirm, Esc to go back, Ctrl+C to exit."),
    };

    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
    };

    const repaint = () => {
      if (state.renderedLines > 0) {
        clearScreen(state.renderedLines);
      }
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

    const onData = (buffer) => {
      const input = buffer.toString("utf8");

      if (input === "\u0003") {
        interrupt();
        return;
      }

      if (input === "\u001b") {
        goBack();
        return;
      }

      if (input === "\u001b[A") {
        state.cursor = (state.cursor - 1 + state.items.length) % state.items.length;
        repaint();
        return;
      }

      if (input === "\u001b[B") {
        state.cursor = (state.cursor + 1) % state.items.length;
        repaint();
        return;
      }

      if (state.multi && input === " ") {
        if (state.selected.has(state.cursor)) {
          state.selected.delete(state.cursor);
        } else {
          state.selected.add(state.cursor);
        }
        repaint();
        return;
      }

      if (input === "\r") {
        if (state.multi) {
          const selectedItems = [...state.selected]
            .sort((left, right) => left - right)
            .map((index) => state.items[index]);
          finish(selectedItems);
          return;
        }

        finish(state.items[state.cursor]);
      }
    };

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
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
