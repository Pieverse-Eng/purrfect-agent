import { ansiColor } from "./formatter.js";
import { getContextLength } from "../core/model-metadata.js";
import { VERSION } from "../version.js";

export interface BannerOptions {
  model: string;
  cwd: string;
  toolCount: number;
  skillCount: number;
  memoryEntries?: number;
  tools?: string[];
  sessionId?: string;
  version?: string;
}

function formatContextLength(tokens: number): string {
  return `${Math.round(tokens / 1000)}K`;
}

// ── Cat face art (pieverse.io mascot) ────────────────────────────────
const CAT_ART = [
  `          ====                 ===        `,
  `       =========            =========     `,
  `    =============         ============    `,
  `  =========================-=============  `,
  ` ============================================ `,
  `================================================ `,
  `==================================================`,
  `====================================================`,
  `===============---============---=====================`,
  `===============------==========------==================`,
  `===============------==========------===================`,
  `=================----============----====================`,
  `============================================================`,
  `  ==-----=-------------------------------------=----        `,
];

// ── Block letter title ───────────────────────────────────────────────
const TITLE_ART = [
  ` ██████╗ ██╗   ██╗██████╗ ██████╗       ███████╗███████╗ ██████╗████████╗`,
  ` ██╔══██╗██║   ██║██╔══██╗██╔══██╗      ██╔════╝██╔════╝██╔════╝╚══██╔══╝`,
  ` ██████╔╝██║   ██║██████╔╝██████╔╝█████╗█████╗  █████╗  ██║        ██║   `,
  ` ██╔═══╝ ██║   ██║██╔══██╗██╔══██╗╚════╝██╔══╝  ██╔══╝  ██║        ██║   `,
  ` ██║     ╚██████╔╝██║  ██║██║  ██║      ██║     ███████╗╚██████╗   ██║   `,
  ` ╚═╝      ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝      ╚═╝     ╚══════╝ ╚═════╝   ╚═╝   `,
];

// ── Box drawing helpers ──────────────────────────────────────────────
function boxTop(width: number): string {
  return `╭${"─".repeat(width)}╮`;
}
function boxBottom(width: number): string {
  return `╰${"─".repeat(width)}╯`;
}
function boxRow(content: string, width: number): string {
  const visLen = stripAnsi(content).length;
  const pad = Math.max(0, width - visLen);
  return `│${content}${" ".repeat(pad)}│`;
}
function boxEmpty(width: number): string {
  return `│${" ".repeat(width)}│`;
}
function boxSeparator(width: number): string {
  return `├${"─".repeat(width)}┤`;
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Build a fancy welcome banner inspired by hermes-agent's TUI.
 * Features: block-letter title, braille cat art, boxed info panel with
 * tools/skills listing, model/session/CWD details.
 */
export function buildBanner(options: BannerOptions): string {
  const {
    model,
    cwd,
    toolCount,
    skillCount,
    memoryEntries,
    tools,
    sessionId,
    version,
  } = options;
  const ctx = formatContextLength(getContextLength(model));
  const ver = version ?? VERSION;
  const sid = sessionId ? sessionId.slice(0, 8) : "--------";
  const termWidth = process.stdout.columns ?? 100;
  const rows: string[] = [];

  // ── Title ──
  rows.push("");
  if (termWidth >= 70) {
    for (const line of TITLE_ART) {
      rows.push(ansiColor(line, "cyan"));
    }
  } else {
    rows.push(ansiColor("  🐱 PURR-FECT AGENT", "cyan"));
  }
  rows.push("");

  // ── Boxed panel ──
  const boxWidth = Math.min(90, termWidth - 2);
  const headerText = `  purrfect v${ver} · ${model} (${ctx} context)  `;

  rows.push(boxTop(boxWidth));

  // ── Cat art centered in box ──
  for (const artLine of CAT_ART) {
    const pad = Math.max(0, boxWidth - artLine.length);
    const leftPad = Math.floor(pad / 2);
    const rightPad = pad - leftPad;
    rows.push(`│${" ".repeat(leftPad)}${ansiColor(artLine, "yellow")}${" ".repeat(rightPad)}│`);
  }

  rows.push(boxSeparator(boxWidth));

  // ── Header ──
  rows.push(boxRow(
    ansiColor(` ${headerText}`, "cyan") +
    " ".repeat(Math.max(0, boxWidth - headerText.length - 1)),
    boxWidth,
  ));
  rows.push(boxSeparator(boxWidth));

  // ── Info panel: tools, skills, memory in columns ──
  const infoLines: string[] = [];

  // Tools + skills on one line
  const toolsStr = tools && tools.length > 0
    ? tools.slice(0, 8).join(", ") + (tools.length > 8 ? ` (+${tools.length - 8})` : "")
    : `${toolCount} registered`;
  infoLines.push(ansiColor(` Tools:   `, "white") + ansiColor(toolsStr, "gray"));

  const skillsStr = skillCount > 0 ? `${skillCount} loaded` : "(none configured)";
  infoLines.push(ansiColor(` Skills:  `, "white") + ansiColor(skillsStr, "gray"));

  if (memoryEntries && memoryEntries > 0) {
    infoLines.push(ansiColor(` Memory:  `, "white") + ansiColor(`${memoryEntries} durable entries`, "gray"));
  }

  for (const info of infoLines) {
    const visLen = stripAnsi(info).length;
    const pad = Math.max(0, boxWidth - visLen);
    rows.push(`│${info}${" ".repeat(pad)}│`);
  }

  rows.push(boxSeparator(boxWidth));

  // ── Bottom info row ──
  const bottomLeft = ` ${model} · ${cwd}`;
  const bottomRight = `Session: ${sid} `;
  const bottomPad = " ".repeat(Math.max(0, boxWidth - bottomLeft.length - bottomRight.length));
  rows.push(boxRow(
    ansiColor(bottomLeft, "gray") + bottomPad + ansiColor(bottomRight, "gray"),
    boxWidth,
  ));

  // ── Summary row ──
  const parts = [`${toolCount} tools`, `${skillCount} skills`];
  if (memoryEntries && memoryEntries > 0) parts.push(`${memoryEntries} memories`);
  const summary = ` ${parts.join(" · ")} · /help for commands `;
  const summaryPad = " ".repeat(Math.max(0, boxWidth - summary.length));
  rows.push(boxRow(ansiColor(summary, "gray") + summaryPad, boxWidth));

  rows.push(boxBottom(boxWidth));
  rows.push("");

  return rows.join("\n");
}

/**
 * Build a single-line compact banner for narrow terminals (< 80 cols).
 */
export function buildCompactBanner(options: BannerOptions): string {
  const { model, toolCount } = options;
  return `🐱 purrfect | ${model} | ${toolCount} tools | /help`;
}
