import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Both packages ship CommonJS with `__esModule` and `exports.default`. Under NodeNext,
// TypeScript types a default import of such a module as the module *namespace* — which has no
// construct or call signature — even though `module.exports` really is the class/function at
// runtime under tsx and plain Node alike. Importing ajv's named class export and reaching
// through `.default` for the formats plugin gives types that match what actually runs.
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsPkg from "ajv-formats";

const addFormats = addFormatsPkg.default;

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readJson<T = Record<string, unknown>>(relPath: string): T {
  return JSON.parse(readFileSync(resolve(rootDir, relPath), "utf8")) as T;
}

const problems: string[] = [];
const passed: string[] = [];

const pkg = readJson<{
  name: string;
  version: string;
  mcpName?: string;
  engines?: { node?: string };
}>("package.json");
const lock = readJson<{
  name?: string;
  version?: string;
  packages?: Record<string, { engines?: { node?: string } }>;
}>("package-lock.json");
const manifest = readJson<{
  manifest_version?: string;
  version?: string;
  icon?: string;
  server?: { entry_point?: string };
}>("manifest.json");
const server = readJson<{
  $schema?: string;
  name?: string;
  description?: string;
  version?: string;
  packages?: Array<{ version?: string; identifier?: string; registryType?: string; transport?: { type?: string } }>;
}>("server.json");
const claudePlugin = readJson<{
  name?: string;
  version?: string;
  commands?: string;
  skills?: string;
}>(".claude-plugin/plugin.json");
const marketplace = readJson<{
  metadata?: { version?: string };
  plugins?: Array<{ name?: string; version?: string; skills?: string[] }>;
}>(".claude-plugin/marketplace.json");

// 1. Validate server.json against MCP Registry contract (<= 100 char description, namespace, stdio transport)
const serverSchema = {
  type: "object",
  required: ["$schema", "name", "description", "version", "repository", "packages"],
  properties: {
    $schema: { type: "string", format: "uri" },
    name: { type: "string", pattern: "^io\\.github\\.[a-zA-Z0-9_-]+/[a-zA-Z0-9._-]+$" },
    description: { type: "string", minLength: 1, maxLength: 100 },
    version: { type: "string", pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+" },
    websiteUrl: { type: "string", format: "uri" },
    repository: {
      type: "object",
      required: ["url", "source"],
      properties: {
        url: { type: "string", format: "uri" },
        source: { type: "string" },
      },
    },
    packages: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["registryType", "identifier", "version", "transport"],
        properties: {
          registryType: { const: "npm" },
          identifier: { type: "string", minLength: 1 },
          version: { type: "string" },
          transport: {
            type: "object",
            required: ["type"],
            properties: {
              type: { enum: ["stdio", "streamable-http", "sse"] },
            },
          },
          environmentVariables: {
            type: "array",
            items: {
              type: "object",
              required: ["name", "description"],
              properties: {
                name: { type: "string" },
                description: { type: "string" },
                isRequired: { type: "boolean" },
                isSecret: { type: "boolean" },
                format: { type: "string" },
                default: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
};

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const validateServer = ajv.compile(serverSchema);
if (validateServer(server)) {
  passed.push(`server.json valid (description ${server.description?.length ?? 0}/100 chars)`);
} else {
  for (const err of validateServer.errors ?? []) {
    problems.push(`server.json${err.instancePath} ${err.message}`);
  }
}

// 2. npm mcpName & identifier parity
if (pkg.mcpName !== server.name) {
  problems.push(`package.json mcpName "${pkg.mcpName}" != server.json name "${server.name}"`);
} else {
  passed.push(`mcpName matches server.json (${pkg.mcpName})`);
}
if (server.packages?.[0]?.identifier !== pkg.name) {
  problems.push(`server.json packages[0].identifier "${server.packages?.[0]?.identifier}" != package.json "${pkg.name}"`);
} else {
  passed.push(`server.json package identifier matches package.json (${pkg.name})`);
}

// 3. Version agreement across every surface
const versionSrc = readFileSync(resolve(rootDir, "src/version.ts"), "utf8");
const readme = readFileSync(resolve(rootDir, "README.md"), "utf8");
const security = readFileSync(resolve(rootDir, "SECURITY.md"), "utf8");
const changelog = readFileSync(resolve(rootDir, "CHANGELOG.md"), "utf8");

const srcVer = /HANDY_VERSION\s*=\s*"([^"]+)"/.exec(versionSrc)?.[1];
const badgeVer = /badge\/version-([0-9]+\.[0-9]+\.[0-9]+)-/.exec(readme)?.[1];
const changelogVer = /^## \[([0-9]+\.[0-9]+\.[0-9]+)\]/m.exec(changelog)?.[1];

const versionSites: Array<[string, string | undefined]> = [
  ["package.json", pkg.version],
  ["package-lock.json", lock.version],
  ["manifest.json", manifest.version],
  ["server.json", server.version],
  ["server.json packages[0]", server.packages?.[0]?.version],
  [".claude-plugin/plugin.json", claudePlugin.version],
  [".claude-plugin/marketplace.json metadata", marketplace.metadata?.version],
  [".claude-plugin/marketplace.json plugins[0]", marketplace.plugins?.[0]?.version],
  ["src/version.ts", srcVer],
  ["README.md badge", badgeVer],
  ["CHANGELOG.md", changelogVer],
];

const missingSites = versionSites.filter(([, v]) => !v).map(([k]) => k);
if (missingSites.length > 0) {
  problems.push(`Missing version in: ${missingSites.join(", ")}`);
}
const distinctVersions = [...new Set(versionSites.map(([, v]) => v).filter((v): v is string => Boolean(v)))];
if (distinctVersions.length !== 1) {
  problems.push(`Version drift across files: ${versionSites.map(([k, v]) => `${k}=${v}`).join(", ")}`);
} else {
  passed.push(`All ${versionSites.length} version surfaces agree (${distinctVersions[0]})`);
}

// 4. SECURITY.md release line check
const supportedLine = /\|\s*([0-9]+\.[0-9]+)\.x\s*\|\s*✅/.exec(security)?.[1];
const releaseLine = pkg.version.split(".").slice(0, 2).join(".");
if (supportedLine !== releaseLine) {
  problems.push(`SECURITY.md supports "${supportedLine ?? "none"}.x" instead of "${releaseLine}.x"`);
} else {
  passed.push(`SECURITY.md supports release line (${supportedLine}.x)`);
}

// 5. MCPB manifest checks
if (manifest.manifest_version !== "0.3") {
  problems.push(`manifest.json must declare manifest_version "0.3"`);
} else {
  passed.push("MCPB manifest_version is 0.3");
}
for (const assetPath of [manifest.icon, manifest.server?.entry_point, ".mcp.json"]) {
  if (!assetPath || !existsSync(resolve(rootDir, assetPath))) {
    problems.push(`Required packaged file missing: ${assetPath}`);
  } else if (statSync(resolve(rootDir, assetPath)).size === 0) {
    problems.push(`Packaged file is empty: ${assetPath}`);
  }
}

// 6. Validate skills/<name>/SKILL.md frontmatter and referenced files
const allowedFrontmatter = new Set(["name", "description", "license", "allowed-tools", "metadata", "compatibility"]);
const skillsRoot = resolve(rootDir, "skills");
const skillDirs = existsSync(skillsRoot)
  ? readdirSync(skillsRoot, { withFileTypes: true }).filter((d) => d.isDirectory())
  : [];

if (skillDirs.length === 0) {
  problems.push("No skills found under skills/");
}

for (const dir of skillDirs) {
  const skillFile = resolve(skillsRoot, dir.name, "SKILL.md");
  if (!existsSync(skillFile)) {
    problems.push(`skills/${dir.name}/SKILL.md missing`);
    continue;
  }
  const text = readFileSync(skillFile, "utf8").replace(/\r\n/g, "\n");
  const fmMatch = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!fmMatch) {
    problems.push(`skills/${dir.name}/SKILL.md missing YAML frontmatter`);
    continue;
  }
  const fm: Record<string, string> = {};
  for (const line of fmMatch[1]!.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    fm[key] = val;
    if (!allowedFrontmatter.has(key)) {
      problems.push(`skills/${dir.name}/SKILL.md has disallowed frontmatter key "${key}"`);
    }
  }
  if (fm.name !== dir.name) {
    problems.push(`skills/${dir.name}/SKILL.md frontmatter name "${fm.name}" != folder "${dir.name}"`);
  }
  if (!/^[a-z0-9-]{1,64}$/.test(fm.name ?? "")) {
    problems.push(`skills/${dir.name}/SKILL.md invalid skill name "${fm.name}"`);
  }
  if (!fm.description || fm.description.length > 1024) {
    problems.push(`skills/${dir.name}/SKILL.md description missing or > 1024 chars`);
  }

  const refRegex = /`((?:references|assets|scripts)\/[\w./-]+\.\w+)`/g;
  let refMatch: RegExpExecArray | null;
  while ((refMatch = refRegex.exec(text)) !== null) {
    const relRef = refMatch[1]!;
    if (!existsSync(resolve(skillsRoot, dir.name, relRef))) {
      problems.push(`skills/${dir.name}/SKILL.md references missing file "${relRef}"`);
    }
  }
  passed.push(`Skill "${dir.name}" valid with all references resolved`);
}

// 7. Validate slash commands under commands/
const cmdRoot = resolve(rootDir, "commands");
const cmdFiles = existsSync(cmdRoot) ? readdirSync(cmdRoot).filter((f) => f.endsWith(".md")) : [];
if (cmdFiles.length === 0) {
  problems.push("No plugin commands found under commands/");
} else {
  for (const file of cmdFiles) {
    const content = readFileSync(resolve(cmdRoot, file), "utf8").replace(/\r\n/g, "\n");
    if (!/^---\n[\s\S]*?description:\s*\S+/m.test(content)) {
      problems.push(`commands/${file} missing frontmatter description`);
    }
  }
  passed.push(`${cmdFiles.length} plugin slash commands validated (${cmdFiles.join(", ")})`);
}

for (const msg of passed) {
  console.log(`  + ${msg}`);
}
if (problems.length > 0) {
  console.error("\nValidation failed:");
  for (const p of problems) {
    console.error(`  ! ${p}`);
  }
  process.exit(1);
}
console.log("\nAll release, plugin, MCP, and skill checks passed.");
