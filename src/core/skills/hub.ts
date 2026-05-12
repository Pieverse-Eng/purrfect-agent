import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { basename, dirname, join, relative, sep } from "node:path";
import { SkillLoader } from "./loader.js";
import type { SkillDefinition } from "./types.js";

export interface SkillTap {
  name: string;
  url: string;
}

export interface TapSkill {
  tap: string;
  name: string;
  description: string;
  triggers: string[];
  sourcePath: string;
}

export interface SkillAuditReport {
  changed: string[];
  missing: string[];
  added: string[];
}

export interface SkillCheckResult {
  name: string;
  path: string;
  ok: boolean;
  findings: string[];
}

interface TapFile {
  taps: SkillTap[];
}

/**
 * Shipped taps that seed `~/.purrfect/skills/taps.json` on first run.
 * `pieverse` is the Pieverse-maintained onchain skill commons — Binance, OKX,
 * PancakeSwap, OpenSea, BNB Chain, x402, and ~25 more out of the box.
 *
 * Once the user adds or removes any tap, taps.json is written and these
 * defaults no longer apply — the user's explicit state wins from that point on.
 */
export const DEFAULT_TAPS: SkillTap[] = [
  { name: "pieverse", url: "Pieverse-Eng/purrfect-skills" },
];

interface SnapshotFile {
  files: Record<string, string>;
}

const SUSPICIOUS_PATTERNS: Array<[RegExp, string]> = [
  [/curl\s+[^\n|]+\|\s*(?:sh|bash)/i, "curl_pipe_shell"],
  [/wget\s+[^\n|]+\|\s*(?:sh|bash)/i, "wget_pipe_shell"],
  [/rm\s+-rf\s+(?:\/|\$HOME|~)/i, "destructive_rm"],
  [/(?:OPENAI|ANTHROPIC|GITHUB|AWS)_[A-Z_]*(?:KEY|TOKEN|SECRET)/, "credential_reference"],
  [/process\.env\.[A-Z_]*(?:KEY|TOKEN|SECRET)/, "env_secret_reference"],
];

export class SkillHub {
  readonly configDir: string;
  readonly managedDir: string;
  private readonly tapsPath: string;
  private readonly snapshotPath: string;
  private readonly tapCacheDir: string;
  private readonly defaultTaps: SkillTap[];

  constructor(options: {
    configDir: string;
    managedDir?: string;
    /**
     * Seed taps used only when taps.json doesn't yet exist. Pass `[]` to
     * disable defaults (tests do this so they don't hit the network).
     */
    defaultTaps?: SkillTap[];
  }) {
    this.configDir = options.configDir;
    this.managedDir = options.managedDir ?? join(options.configDir, "skills", "managed");
    this.tapsPath = join(options.configDir, "skills", "taps.json");
    this.snapshotPath = join(options.configDir, "skills", "snapshot.json");
    this.tapCacheDir = join(options.configDir, "skills", "taps");
    this.defaultTaps = options.defaultTaps ?? DEFAULT_TAPS;
  }

  addTap(name: string, url: string): SkillTap {
    validateSafeName(name, "tap name");
    const file = this.readTaps();
    const existing = file.taps.find((tap) => tap.name === name);
    if (existing) {
      existing.url = url;
      this.writeTaps(file);
      return existing;
    }
    const tap = { name, url };
    file.taps.push(tap);
    this.writeTaps(file);
    return tap;
  }

  removeTap(name: string): boolean {
    const file = this.readTaps();
    const before = file.taps.length;
    file.taps = file.taps.filter((tap) => tap.name !== name);
    this.writeTaps(file);
    return file.taps.length !== before;
  }

  listTaps(): SkillTap[] {
    return this.readTaps().taps.map((tap) => ({ ...tap }));
  }

  browse(): TapSkill[] {
    return this.listTaps().flatMap((tap) => this.skillsFromTap(tap));
  }

  search(query: string): TapSkill[] {
    const q = query.toLowerCase();
    return this.browse().filter(
      (skill) =>
        skill.name.toLowerCase().includes(q) ||
        skill.description.toLowerCase().includes(q) ||
        skill.triggers.some((trigger) => trigger.toLowerCase().includes(q)),
    );
  }

  inspect(name: string): SkillDefinition {
    const installed = this.loadInstalled(name);
    if (installed) return installed;

    const found = this.search(name).find((skill) => skill.name === name);
    if (!found) throw new Error(`Skill '${name}' not found`);
    const skill = SkillLoader.load(found.sourcePath);
    if (!skill) throw new Error(`Skill '${name}' is invalid`);
    return skill;
  }

  install(name: string, options: { tap?: string } = {}): SkillDefinition {
    validateSafeName(name, "skill name");
    const candidate = this.browse().find(
      (skill) => skill.name === name && (!options.tap || skill.tap === options.tap),
    );
    if (!candidate) throw new Error(`Skill '${name}' not found in taps`);

    const sourcePath = resolveSkillSourcePath(candidate.sourcePath);
    const check = checkSkillSource(sourcePath);
    if (!check.ok) {
      throw new Error(`Skill '${name}' has suspicious content: ${check.findings.join(", ")}`);
    }

    mkdirSync(this.managedDir, { recursive: true });
    const targetPath = sourcePath.kind === "directory"
      ? join(this.managedDir, name)
      : join(this.managedDir, `${name}.md`);

    if (existsSync(targetPath)) {
      rmSync(targetPath, { recursive: true, force: true });
    }
    cpSync(sourcePath.path, targetPath, { recursive: true });

    const installed = this.loadInstalled(name);
    if (!installed) throw new Error(`Installed skill '${name}' could not be loaded`);
    return installed;
  }

  update(name: string): SkillDefinition {
    this.refreshRemoteTaps();
    return this.install(name);
  }

  uninstall(name: string): boolean {
    validateSafeName(name, "skill name");
    const dirPath = join(this.managedDir, name);
    const filePath = join(this.managedDir, `${name}.md`);
    let removed = false;
    if (existsSync(dirPath)) {
      rmSync(dirPath, { recursive: true, force: true });
      removed = true;
    }
    if (existsSync(filePath)) {
      rmSync(filePath, { force: true });
      removed = true;
    }
    return removed;
  }

  check(name?: string): SkillCheckResult[] {
    return collectInstalledSkillSources(this.managedDir)
      .filter((filePath) => {
        if (!name) return true;
        const manifestPath = filePath.kind === "directory"
          ? join(filePath.path, "SKILL.md")
          : filePath.path;
        const skill = SkillLoader.load(manifestPath);
        return skill?.name === name;
      })
      .map(checkSkillSource);
  }

  snapshot(): Record<string, string> {
    const snapshot = hashManagedFiles(this.managedDir);
    mkdirSync(dirname(this.snapshotPath), { recursive: true });
    writeFileSync(this.snapshotPath, JSON.stringify({ files: snapshot }, null, 2) + "\n", "utf-8");
    return snapshot;
  }

  audit(): SkillAuditReport {
    const previous = this.readSnapshot().files;
    const current = hashManagedFiles(this.managedDir);
    const changed = Object.keys(previous).filter(
      (file) => current[file] !== undefined && current[file] !== previous[file],
    );
    const missing = Object.keys(previous).filter((file) => current[file] === undefined);
    const added = Object.keys(current).filter((file) => previous[file] === undefined);
    return {
      changed: changed.sort(),
      missing: missing.sort(),
      added: added.sort(),
    };
  }

  publish(name: string): string {
    const installed = this.loadInstalled(name);
    if (!installed?.filePath) throw new Error(`Skill '${name}' is not installed`);
    return installed.filePath;
  }

  private loadInstalled(name: string): SkillDefinition | null {
    validateSafeName(name, "skill name");
    const candidates = [
      join(this.managedDir, name, "SKILL.md"),
      join(this.managedDir, `${name}.md`),
    ];
    for (const filePath of candidates) {
      const skill = SkillLoader.load(filePath);
      if (skill?.name === name) {
        return { ...skill, sourceLayer: "managed", filePath };
      }
    }
    return null;
  }

  private skillsFromTap(tap: SkillTap): TapSkill[] {
    const tapPath = this.ensureTapPath(tap);
    return collectSkillFiles(tapPath)
      .map((sourcePath) => {
        const skill = SkillLoader.load(sourcePath);
        if (!skill) return null;
        return {
          tap: tap.name,
          name: skill.name,
          description: skill.description,
          triggers: skill.triggers,
          sourcePath,
        } satisfies TapSkill;
      })
      .filter((skill): skill is TapSkill => skill !== null);
  }

  private ensureTapPath(tap: SkillTap): string {
    if (existsSync(tap.url)) return tap.url;

    const cachePath = join(this.tapCacheDir, tap.name);
    if (existsSync(cachePath)) return cachePath;

    this.cloneTap(tap, cachePath);
    return cachePath;
  }

  private refreshRemoteTaps(): void {
    for (const tap of this.listTaps()) {
      if (existsSync(tap.url)) continue;

      const cachePath = join(this.tapCacheDir, tap.name);
      if (!existsSync(cachePath)) {
        this.cloneTap(tap, cachePath);
        continue;
      }

      execFileSync("git", ["-C", cachePath, "fetch", "--depth=1", "origin"], {
        stdio: "ignore",
      });
      execFileSync("git", ["-C", cachePath, "reset", "--hard", "FETCH_HEAD"], {
        stdio: "ignore",
      });
    }
  }

  private cloneTap(tap: SkillTap, cachePath: string): void {
    mkdirSync(this.tapCacheDir, { recursive: true });
    execFileSync("git", ["clone", "--depth=1", normalizeRepoUrl(tap.url), cachePath], {
      stdio: "ignore",
    });
  }

  private readTaps(): TapFile {
    // Never managed by the user yet → seed with bundled defaults.
    if (!existsSync(this.tapsPath)) {
      return { taps: this.defaultTaps.map((tap) => ({ ...tap })) };
    }
    try {
      const parsed = JSON.parse(readFileSync(this.tapsPath, "utf-8")) as TapFile;
      return { taps: Array.isArray(parsed.taps) ? parsed.taps : [] };
    } catch {
      return { taps: [] };
    }
  }

  private writeTaps(file: TapFile): void {
    mkdirSync(dirname(this.tapsPath), { recursive: true });
    writeFileSync(this.tapsPath, JSON.stringify(file, null, 2) + "\n", "utf-8");
  }

  private readSnapshot(): SnapshotFile {
    try {
      const parsed = JSON.parse(readFileSync(this.snapshotPath, "utf-8")) as SnapshotFile;
      return {
        files: parsed.files && typeof parsed.files === "object" ? parsed.files : {},
      };
    } catch {
      return { files: {} };
    }
  }
}

/**
 * Strip fenced code blocks (```…``` and ~~~…~~~) before scanning for
 * suspicious patterns. Skill docs routinely contain `curl … | bash`
 * examples and `process.env.X_KEY` references inside code fences for
 * human reference; without stripping, those false-positive as malicious
 * intent. Bare instructions (no fences) still get caught.
 */
function stripFencedCodeBlocks(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "");
}

function checkSkillFile(filePath: string): SkillCheckResult {
  const skill = SkillLoader.load(filePath);
  const findings: string[] = [];
  if (!skill) {
    findings.push("invalid_manifest");
  } else {
    try {
      validateSafeName(skill.name, "skill name");
    } catch {
      findings.push("unsafe_name");
    }
    const content = stripFencedCodeBlocks(readFileSync(filePath, "utf-8"));
    for (const [pattern, id] of SUSPICIOUS_PATTERNS) {
      if (pattern.test(content)) findings.push(id);
    }
  }

  return {
    name: skill?.name ?? basename(filePath),
    path: filePath,
    ok: findings.length === 0,
    findings,
  };
}

function checkSkillSource(source: { kind: "directory" | "file"; path: string }): SkillCheckResult {
  const manifestPath = source.kind === "directory" ? join(source.path, "SKILL.md") : source.path;
  const manifestCheck = checkSkillFile(manifestPath);
  const findings = [...manifestCheck.findings];

  const files = source.kind === "directory" ? collectAllFiles(source.path) : [source.path];
  for (const filePath of files) {
    if (filePath === manifestPath) continue;
    const rel = source.kind === "directory"
      ? relative(source.path, filePath).split(sep).join("/")
      : basename(filePath);
    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }
    // Strip fences for markdown (docs frequently show curl|bash and env-var
    // examples in fenced blocks). Non-markdown files (shell scripts, source
    // code) get scanned raw because there's no fence convention there.
    const scanContent = rel.endsWith(".md") ? stripFencedCodeBlocks(content) : content;
    for (const [pattern, id] of SUSPICIOUS_PATTERNS) {
      if (pattern.test(scanContent)) findings.push(`${rel}:${id}`);
    }
  }

  return {
    ...manifestCheck,
    path: source.path,
    ok: findings.length === 0,
    findings,
  };
}

function collectSkillFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        visit(fullPath);
      } else if (stat.isFile() && entry.endsWith(".md")) {
        files.push(fullPath);
      }
    }
  };
  visit(root);
  return files;
}

function collectAllFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === ".git") continue;
      const fullPath = join(dir, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        visit(fullPath);
      } else if (stat.isFile()) {
        files.push(fullPath);
      }
    }
  };
  visit(root);
  return files;
}

function collectInstalledSkillSources(root: string): Array<{ kind: "directory" | "file"; path: string }> {
  let entries: string[];
  try {
    entries = readdirSync(root).sort();
  } catch {
    return [];
  }

  const sources: Array<{ kind: "directory" | "file"; path: string }> = [];
  for (const entry of entries) {
    const fullPath = join(root, entry);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }
    if (stat.isDirectory() && existsSync(join(fullPath, "SKILL.md"))) {
      sources.push({ kind: "directory", path: fullPath });
    } else if (stat.isFile() && entry.endsWith(".md")) {
      sources.push({ kind: "file", path: fullPath });
    }
  }
  return sources;
}

function resolveSkillSourcePath(sourcePath: string): { kind: "directory" | "file"; path: string } {
  return basename(sourcePath) === "SKILL.md"
    ? { kind: "directory", path: dirname(sourcePath) }
    : { kind: "file", path: sourcePath };
}

function hashManagedFiles(root: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const filePath of collectAllFiles(root)) {
    const rel = relative(root, filePath).split(sep).join("/");
    hashes[rel] = createHash("sha256").update(readFileSync(filePath)).digest("hex");
  }
  return hashes;
}

function normalizeRepoUrl(url: string): string {
  if (/^[\w.-]+\/[\w.-]+$/.test(url)) return `https://github.com/${url}.git`;
  return url;
}

function validateSafeName(name: string, label: string): void {
  if (!name || /[/\\]/.test(name) || name === "." || name === ".." || name.startsWith("..")) {
    throw new Error(`${label} must not contain path separators, '.', or '..'`);
  }
}
