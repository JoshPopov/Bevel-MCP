/**
 * Terminal presentation for the CLI: colour, symbols, boxes, the banner and a spinner.
 *
 * Colour, the logo and animation appear only on an interactive terminal (and never with NO_COLOR).
 * Without colour the output keeps the same words, symbols and layout, so piped output, a shared
 * `doctor` report and the tests stay readable and stable.
 */

const ESC = "\u001b[";
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** Display width in columns. Every code point counts as one; the CLI avoids wide emoji. */
export function visibleWidth(text: string): number {
  return [...stripAnsi(text)].length;
}

/** NO_COLOR wins, then FORCE_COLOR, then "is this an interactive, non-dumb terminal". */
export function detectColor(stream: { isTTY?: boolean }, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== "0" && env.FORCE_COLOR !== "false";
  if (env.TERM === "dumb") return false;
  return Boolean(stream.isTTY);
}

type Style = (text: string) => string;
export type Tone = "accent" | "green" | "yellow" | "red" | "dim";

/** Bevel orange, light to deep, one shade per logo row (256-colour palette). */
const LOGO_SHADES = [222, 215, 214, 208, 202, 166];

const LOGO = [
  "██████╗ ███████╗██╗   ██╗███████╗██╗     ",
  "██╔══██╗██╔════╝██║   ██║██╔════╝██║     ",
  "██████╔╝█████╗  ██║   ██║█████╗  ██║     ",
  "██╔══██╗██╔══╝  ╚██╗ ██╔╝██╔══╝  ██║     ",
  "██████╔╝███████╗ ╚████╔╝ ███████╗███████╗",
  "╚═════╝ ╚══════╝  ╚═══╝  ╚══════╝╚══════╝",
];
const LOGO_WIDTH = 2 + LOGO[0]!.length;

export interface Ui {
  readonly color: boolean;
  bold: Style;
  dim: Style;
  accent: Style;
  green: Style;
  red: Style;
  yellow: Style;
  /** "✓ text" with a green tick. */
  ok: Style;
  /** "✗ text" with a red cross. */
  fail: Style;
  /** "! text" with a yellow mark. */
  warn: Style;
  /** "1. Title", with an accented number and a bold title. */
  step(n: number, title: string): string;
  /** Aligned "key  value" rows. Keys are dimmed unless another style is given. */
  rows(entries: Array<[string, string]>, options?: { indent?: string; key?: Style }): string[];
  /**
   * A rounded box around lines, as wide as the longest line. If it would not fit in `maxWidth`
   * columns, the lines are returned indented without the frame so nothing wraps mid-box.
   */
  box(lines: string[], options?: { title?: string; indent?: string; tone?: Tone; maxWidth?: number }): string[];
  /**
   * A command's opening lines. A wide colour terminal gets the BEVEL logo with the title beside it;
   * otherwise one plain "Bevel MCP <title>" line.
   */
  heading(title: string, subtitle: string, version: string, columns?: number): string[];
  /** A prompt: unchanged without colour; otherwise "? Question [hint]" with the hint dimmed. */
  question(text: string): string;
}

export function createUi(color: boolean): Ui {
  const wrap = (open: string, close: string): Style => (text) => (color ? `${ESC}${open}m${text}${ESC}${close}m` : text);
  const bold = wrap("1", "22");
  const dim = wrap("2", "22");
  const accent = wrap("38;5;208", "39");
  const green = wrap("32", "39");
  const red = wrap("31", "39");
  const yellow = wrap("33", "39");
  const tones: Record<Tone, Style> = { accent, green, yellow, red, dim };

  return {
    color,
    bold,
    dim,
    accent,
    green,
    red,
    yellow,
    ok: (text) => `${green("✓")} ${text}`,
    fail: (text) => `${red("✗")} ${text}`,
    warn: (text) => `${yellow("!")} ${text}`,
    step: (n, title) => `${accent(bold(`${n}.`))} ${bold(title)}`,
    rows(entries, options = {}) {
      const key = options.key ?? dim;
      const width = Math.max(0, ...entries.map(([name]) => visibleWidth(name)));
      return entries.map(([name, value]) => `${options.indent ?? ""}${key(name)}${" ".repeat(width - visibleWidth(name))}  ${value}`);
    },
    box(lines, options = {}) {
      const tone = tones[options.tone ?? "dim"];
      const indent = options.indent ?? "";
      const title = options.title ? ` ${options.title} ` : "";
      const inner = Math.max(visibleWidth(title) + 2, ...lines.map((line) => visibleWidth(line) + 2));
      if (options.maxWidth !== undefined && visibleWidth(indent) + inner + 2 > options.maxWidth) {
        return [...(options.title ? [indent + bold(options.title)] : []), ...lines.map((line) => indent + line)];
      }
      const top = title
        ? `${tone("╭─")}${bold(title)}${tone(`${"─".repeat(inner - visibleWidth(title) - 1)}╮`)}`
        : tone(`╭${"─".repeat(inner)}╮`);
      return [
        indent + top,
        ...lines.map((line) => `${indent}${tone("│")} ${line}${" ".repeat(inner - visibleWidth(line) - 2)} ${tone("│")}`),
        indent + tone(`╰${"─".repeat(inner)}╯`),
      ];
    },
    heading(title, subtitle, version, columns = 80) {
      const name = `Bevel MCP ${title}`;
      if (!color || columns < LOGO_WIDTH + 2) return ["", name, ""];
      const logo = LOGO.map((line, i) => `  ${ESC}38;5;${LOGO_SHADES[i]}m${line}${ESC}39m`);
      const side = [
        "",
        "",
        `${accent(bold("MCP"))} ${dim("·")} ${bold(title)}`,
        dim(subtitle),
        "",
        dim(`v${version} · unofficial`),
      ];
      const sideWidth = Math.max(...side.map(visibleWidth));
      if (columns >= LOGO_WIDTH + 3 + sideWidth) {
        return ["", ...logo.map((line, i) => (side[i] ? `${line}   ${side[i]}` : line)), ""];
      }
      return ["", ...logo, "", `  ${side[2]}`, `  ${side[3]}`, ""];
    },
    question(text) {
      if (!color) return text;
      const [, lead = "", body = "", hint = "", tail = ""] = text.match(/^(\s*)(.*?)(\s*\[[^\]]*\])?(\s*)$/s) ?? [];
      return `${lead}${accent("?")} ${bold(body)}${hint ? dim(hint) : ""}${tail}`;
    },
  };
}

export interface Spinner {
  /** Stops animating and optionally prints a final line in its place. Safe to call twice. */
  stop(finalLine?: string): void;
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * An animated "⠋ text" line on an interactive terminal. Without colour or a raw writer it prints
 * the text once (unless `echo` is false), so logs and tests see an ordinary line.
 */
export function startSpinner(
  ui: Ui,
  out: (line: string) => void,
  write: ((chunk: string) => void) | undefined,
  text: string,
  options: { echo?: boolean } = {},
): Spinner {
  let stopped = false;
  if (!ui.color || !write) {
    if (options.echo !== false) out(text);
    return {
      stop(finalLine) {
        if (stopped) return;
        stopped = true;
        if (finalLine !== undefined) out(finalLine);
      },
    };
  }
  const lead = text.match(/^\s*/)?.[0] ?? "";
  const body = text.slice(lead.length);
  let frame = 0;
  const draw = () => write(`\r${ESC}2K${lead}${ui.accent(FRAMES[frame++ % FRAMES.length]!)} ${body}`);
  draw();
  const timer = setInterval(draw, 80);
  timer.unref?.();
  return {
    stop(finalLine) {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      write(`\r${ESC}2K`);
      if (finalLine !== undefined) out(finalLine);
    },
  };
}
