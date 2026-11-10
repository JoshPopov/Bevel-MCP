import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createUi, detectColor, startSpinner, stripAnsi, visibleWidth } from "../src/cli/ui.js";

const plain = createUi(false);
const color = createUi(true);

describe("terminal colour detection", () => {
  it("uses colour only on an interactive terminal, and respects NO_COLOR, FORCE_COLOR and TERM=dumb", () => {
    assert.equal(detectColor({ isTTY: true }, {}), true);
    assert.equal(detectColor({ isTTY: false }, {}), false);
    assert.equal(detectColor({}, {}), false);
    assert.equal(detectColor({ isTTY: true }, { NO_COLOR: "1" }), false);
    assert.equal(detectColor({ isTTY: true }, { NO_COLOR: "" }), true, "an empty NO_COLOR is ignored");
    assert.equal(detectColor({ isTTY: true }, { NO_COLOR: "1", FORCE_COLOR: "1" }), false, "NO_COLOR wins");
    assert.equal(detectColor({ isTTY: false }, { FORCE_COLOR: "1" }), true);
    assert.equal(detectColor({ isTTY: true }, { FORCE_COLOR: "0" }), false);
    assert.equal(detectColor({ isTTY: true }, { TERM: "dumb" }), false);
  });
});

describe("ui helpers", () => {
  it("plain output has no escape codes, and colour output has the same text underneath", () => {
    const samples = (ui: typeof plain) => [
      ui.ok("done"), ui.fail("broken"), ui.warn("careful"), ui.step(2, "Connect to Bevel"),
      ...ui.rows([["Client", "Claude Code"], ["Token source", "macOS Keychain"]], { indent: "   " }),
      ...ui.box(["one", "three"], { title: "Title", indent: "  " }),
      ui.question("\n   Add Bevel to Claude? [y/N] "),
    ];
    const plainLines = samples(plain);
    assert.ok(plainLines.every((line) => !line.includes("\u001b")));
    assert.deepEqual(plainLines.slice(0, 4), ["✓ done", "✗ broken", "! careful", "2. Connect to Bevel"]);
    assert.deepEqual(plainLines.slice(4, 6), ["   Client        Claude Code", "   Token source  macOS Keychain"]);
    const colourLines = samples(color);
    assert.ok(colourLines.slice(0, 9).every((line) => line.includes("\u001b[")));
    assert.deepEqual(colourLines.slice(0, 9).map(stripAnsi), plainLines.slice(0, 9));
  });

  it("boxes are rectangular, with or without colour, and drop the frame when too wide", () => {
    for (const ui of [plain, color]) {
      const lines = ui.box(["short", ui.bold("a longer line"), ""], { title: "Setup complete", indent: "   ", tone: "green" });
      assert.equal(lines.length, 5);
      assert.equal(new Set(lines.map(visibleWidth)).size, 1, lines.map(stripAnsi).join("\n"));
      assert.match(stripAnsi(lines[0]!), /^   ╭─ Setup complete ─+╮$/);
      assert.match(stripAnsi(lines[4]!), /^   ╰─+╯$/);
    }
    assert.deepEqual(plain.box(["x".repeat(30)], { indent: "  ", maxWidth: 20 }), ["  " + "x".repeat(30)]);
  });

  it("shows the logo only on a wide colour terminal", () => {
    assert.deepEqual(plain.heading("setup", "Connect", "1.0.0"), ["", "Bevel MCP setup", ""]);
    assert.deepEqual(color.heading("setup", "Connect", "1.0.0", 40), ["", "Bevel MCP setup", ""]);
    const wide = color.heading("setup", "Connect your Bevel data to Claude", "1.0.0", 100).map(stripAnsi);
    assert.ok(wide.some((line) => line.includes("██████╗ ███████╗")));
    assert.ok(wide.some((line) => line.includes("MCP · setup")));
    assert.ok(wide.some((line) => line.includes("v1.0.0 · unofficial")));
    assert.ok(wide.every((line) => visibleWidth(line) <= 100));
    const medium = color.heading("setup", "Connect your Bevel data to Claude", "1.0.0", 60).map(stripAnsi);
    assert.ok(medium.every((line) => visibleWidth(line) <= 60), "the title moves under the logo");
    assert.ok(medium.includes("  MCP · setup"));
  });

  it("dims the answer hint in a coloured prompt", () => {
    const prompt = color.question("\n   Client [1] ");
    assert.ok(prompt.startsWith("\n   "));
    assert.equal(stripAnsi(prompt), "\n   ? Client [1] ");
    assert.equal(plain.question("\n   Client [1] "), "\n   Client [1] ");
  });
});

describe("spinner", () => {
  it("prints the text once without colour, and the final line on stop", () => {
    const lines: string[] = [];
    const spinner = startSpinner(plain, (line) => lines.push(line), () => assert.fail("no raw writes"), "   Waiting…");
    spinner.stop("   ✓ Done");
    spinner.stop("   twice");
    assert.deepEqual(lines, ["   Waiting…", "   ✓ Done"]);
    const quiet: string[] = [];
    startSpinner(plain, (line) => quiet.push(line), undefined, "Checking…", { echo: false }).stop();
    assert.deepEqual(quiet, []);
  });

  it("animates in place on a colour terminal and clears its line", () => {
    const lines: string[] = [];
    const chunks: string[] = [];
    const spinner = startSpinner(color, (line) => lines.push(line), (chunk) => chunks.push(chunk), "   Waiting…");
    assert.match(stripAnsi(chunks[0]!), /^\r   ⠋ Waiting…$/);
    spinner.stop("   ✓ Done");
    assert.ok(chunks.at(-1)!.startsWith("\r\u001b[2K"));
    assert.deepEqual(lines, ["   ✓ Done"]);
  });
});
