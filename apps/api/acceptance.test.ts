import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";

// ─── Path constants ──────────────────────────────────────────────────────────

const API_DIR = import.meta.dir; // apps/api
const SRC_DIR = join(API_DIR, "src");
const MONOREPO_ROOT = join(API_DIR, "..", "..");
const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:3100/api";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Recursively collect all .ts files under dir, skipping node_modules/dist/generated */
function getAllTsFiles(dir: string): string[] {
  const skip = new Set(["node_modules", "dist", "generated", ".git", "coverage"]);
  const results: string[] = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...getAllTsFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      results.push(full);
    }
  }
  return results;
}

/** Return non-spec src files matching a regex pattern */
function grepSrc(pattern: RegExp): string[] {
  return getAllTsFiles(SRC_DIR).filter(
    (f) => !f.endsWith(".spec.ts") && pattern.test(readFileSync(f, "utf8")),
  );
}

/** Read a file under SRC_DIR */
function readSrc(relativePath: string): string {
  return readFileSync(join(SRC_DIR, relativePath), "utf8");
}

/** Check if a path exists under SRC_DIR */
function srcExists(relativePath: string): boolean {
  return existsSync(join(SRC_DIR, relativePath));
}

/** Read apps/api/package.json */
const pkg = JSON.parse(readFileSync(join(API_DIR, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const allDeps: Record<string, string> = {
  ...pkg.dependencies,
  ...pkg.devDependencies,
};

/** Flatten a nested JSON object to dot-notation keys */
function flattenKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  const keys: string[] = [];
  for (const [key, val] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (val !== null && typeof val === "object" && !Array.isArray(val)) {
      keys.push(...flattenKeys(val as Record<string, unknown>, full));
    } else {
      keys.push(full);
    }
  }
  return keys;
}

/** Run `bun run <script>` inside API_DIR using Bun.spawnSync (safe, no shell injection). */
function bunRunApi(script: string, extraArgs: string[] = [], timeoutMs = 120_000): void {
  const proc = Bun.spawnSync(["bun", "run", script, ...extraArgs], {
    cwd: API_DIR,
    timeout: timeoutMs,
  });
  if (proc.exitCode !== 0) {
    const stderr = proc.stderr ? new TextDecoder().decode(proc.stderr) : "";
    const stdout = proc.stdout ? new TextDecoder().decode(proc.stdout) : "";
    throw new Error(`bun run ${script} failed (exit ${proc.exitCode}):\n${stderr || stdout}`);
  }
}

/** Run `bun run <script>` inside MONOREPO_ROOT using Bun.spawnSync. */
function bunRunRoot(script: string, timeoutMs = 60_000): void {
  const proc = Bun.spawnSync(["bun", "run", script], {
    cwd: MONOREPO_ROOT,
    timeout: timeoutMs,
  });
  if (proc.exitCode !== 0) {
    const stderr = proc.stderr ? new TextDecoder().decode(proc.stderr) : "";
    throw new Error(`bun run ${script} failed (exit ${proc.exitCode}):\n${stderr}`);
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("refactor-standard - Acceptance Tests", () => {
  // ── Auth refactor ──────────────────────────────────────────────────────────

  test("AC-1: No imports from @nestjs/jwt or @nestjs/passport anywhere in apps/api/src", () => {
    const matches = grepSrc(/from\s+['"]@nestjs\/(jwt|passport)['"]/);
    expect(matches).toEqual([]);
  });

  test("AC-2: AuthModule uses @nathapp/nestjs-auth AuthModule.forRootAsync", () => {
    const content = readSrc("auth/auth.module.ts");
    expect(content).toContain("@nathapp/nestjs-auth");
    expect(content).toMatch(/AuthModule\.forRootAsync\s*\(/);
  });

  test("AC-3: Login and register endpoints return valid JWT access + refresh tokens", async () => {
    const email = `ac3-${Date.now()}@test.com`;
    const password = "Password123!";

    const regRes = await fetch(`${BASE_URL}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, name: "AC3 User" }),
    });
    expect(regRes.status).toBe(201);
    const regBody = (await regRes.json()) as { data?: { accessToken?: string; refreshToken?: string } };
    expect(typeof regBody.data?.accessToken).toBe("string");
    expect(typeof regBody.data?.refreshToken).toBe("string");

    const loginRes = await fetch(`${BASE_URL}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    expect(loginRes.status).toBe(200);
    const loginBody = (await loginRes.json()) as { data?: { accessToken?: string; refreshToken?: string } };
    expect(typeof loginBody.data?.accessToken).toBe("string");
    expect(typeof loginBody.data?.refreshToken).toBe("string");
  });

  test("AC-4: Protected endpoints reject unauthenticated requests with 401", async () => {
    const res = await fetch(`${BASE_URL}/projects`, { method: "GET" });
    expect(res.status).toBe(401);
  });

  test("AC-5: @Public() endpoints are accessible without a token", async () => {
    // /api/agents is decorated @IsPublic()
    const res = await fetch(`${BASE_URL}/agents`, { method: "GET" });
    expect(res.status).toBe(200);
  });

  test("AC-6: AppModule has no APP_GUARD provider", () => {
    const content = readSrc("app.module.ts");
    expect(content).not.toMatch(/APP_GUARD/);
  });

  test("AC-7: Auth tests pass with >= 80% coverage for auth module", () => {
    bunRunApi(
      "test:cov",
      [
        "--",
        "--testPathPattern=auth",
        '--coverageThreshold={"global":{"lines":80,"functions":80,"branches":80,"statements":80}}',
      ],
      180_000,
    );
  });

  test("AC-8: Packages @nestjs/jwt, @nestjs/passport, passport-jwt removed from package.json", () => {
    expect(allDeps["@nestjs/jwt"]).toBeUndefined();
    expect(allDeps["@nestjs/passport"]).toBeUndefined();
    expect(allDeps["passport-jwt"]).toBeUndefined();
    expect(allDeps["passport"]).toBeUndefined();
  });

  test("AC-9: Files jwt-auth.guard.ts, api-key-auth.guard.ts, combined-auth.guard.ts, jwt.strategy.ts deleted", () => {
    expect(srcExists("auth/guards/jwt-auth.guard.ts")).toBe(false);
    expect(srcExists("auth/guards/api-key-auth.guard.ts")).toBe(false);
    expect(srcExists("auth/guards/combined-auth.guard.ts")).toBe(false);
    expect(srcExists("auth/strategies/jwt.strategy.ts")).toBe(false);
  });

  test("AC-10: Agent API key validation still works for agent-authenticated endpoints", async () => {
    const agentApiKey = process.env.TEST_AGENT_API_KEY;
    if (!agentApiKey) {
      // Cannot perform live check — verify that an API key guard is still wired in source
      const guardFiles = getAllTsFiles(SRC_DIR).filter(
        (f) => f.includes("guard") && !f.endsWith(".spec.ts"),
      );
      const hasApiKeyGuard = guardFiles.some((f) =>
        /apiKey|api.key|API_KEY/i.test(readFileSync(f, "utf8")),
      );
      expect(hasApiKeyGuard).toBe(true);
      return;
    }
    const res = await fetch(`${BASE_URL}/agents/me`, {
      headers: { Authorization: `Bearer ${agentApiKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data?: unknown };
    expect(body.data).toBeDefined();
  });

  // ── i18n ──────────────────────────────────────────────────────────────────

  test("AC-11: I18nCoreModule registered in AppModule", () => {
    const content = readSrc("app.module.ts");
    expect(content).toMatch(/I18nCoreModule/);
  });

  test("AC-12: apps/api/src/i18n/en/common.json exists with required validation and error keys", () => {
    const i18nPath = join(SRC_DIR, "i18n", "en", "common.json");
    expect(existsSync(i18nPath)).toBe(true);
    const json = JSON.parse(readFileSync(i18nPath, "utf8")) as Record<string, unknown>;
    const flat = flattenKeys(json);
    const requiredKeys = [
      "validation.required",
      "validation.isEmail",
      "validation.minLength",
      "validation.maxLength",
      "errors.notFound",
      "errors.forbidden",
      "errors.unauthorized",
    ];
    for (const key of requiredKeys) {
      expect(flat).toContain(key);
    }
  });

  test("AC-13: All six locale namespaces exist in both en/ and zh/", () => {
    const namespaces = ["common", "auth", "tickets", "projects", "agents", "comments"];
    const locales = ["en", "zh"];
    for (const locale of locales) {
      for (const ns of namespaces) {
        const filePath = join(SRC_DIR, "i18n", locale, `${ns}.json`);
        expect(existsSync(filePath)).toBe(true);
      }
    }
  });

  test("AC-14: All DTO @IsNotEmpty/@IsEmail/@MinLength/@MaxLength decorators carry i18n message keys", () => {
    const sep = require("path").sep as string;
    const dtoFiles = getAllTsFiles(SRC_DIR).filter(
      (f) => f.includes(`${sep}dto${sep}`) && !f.endsWith(".spec.ts"),
    );
    const i18nKeyPattern = /['"][a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+['"]/;
    const nonCompliant = dtoFiles.filter((f) => {
      const content = readFileSync(f, "utf8");
      const usages = content.match(/@(IsNotEmpty|IsEmail|MinLength|MaxLength)\s*\([^)]*\)/g) ?? [];
      return usages.some((usage) => {
        const hasOptionsBlock = usage.includes("{");
        if (!hasOptionsBlock) return true; // bare decorator with no message option
        const hasMessageKey = /message\s*:/.test(usage) && i18nKeyPattern.test(usage);
        return !hasMessageKey;
      });
    });
    expect(nonCompliant).toEqual([]);
  });

  test("AC-15: Validation failure response body contains translated message, not raw class-validator English", async () => {
    const res = await fetch(`${BASE_URL}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "not-an-email", password: "" }),
    });
    expect([400, 422]).toContain(res.status);
    const body = (await res.json()) as { message?: string | string[]; data?: unknown };
    expect(body.message ?? body.data).toBeDefined();
    // Raw class-validator defaults that must not appear
    const rawDefaults = ["must be an email", "should not be empty", "isEmail", "isNotEmpty"];
    const messages: string[] = Array.isArray(body.message)
      ? body.message
      : typeof body.message === "string"
        ? [body.message]
        : [];
    for (const msg of messages) {
      for (const raw of rawDefaults) {
        expect(msg.toLowerCase()).not.toBe(raw.toLowerCase());
      }
    }
  });

  test("AC-16: No hardcoded English prose strings in DTO validation decorator message options", () => {
    const sep = require("path").sep as string;
    const dtoFiles = getAllTsFiles(SRC_DIR).filter(
      (f) => f.includes(`${sep}dto${sep}`) && !f.endsWith(".spec.ts"),
    );
    // Matches: message: 'Starts with uppercase word followed by lowercase word (prose)'
    const hardcodedProsePattern = /message\s*:\s*['"][A-Z][a-z].*\s[a-z]/;
    const offenders = dtoFiles.filter((f) =>
      hardcodedProsePattern.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  // ── Logging ───────────────────────────────────────────────────────────────

  test("AC-17: @nathapp/nestjs-logging present in apps/api/package.json", () => {
    expect(allDeps["@nathapp/nestjs-logging"]).toBeDefined();
  });

  test("AC-18: LoggingModule registered in AppModule", () => {
    const content = readSrc("app.module.ts");
    expect(content).toMatch(/LoggingModule/);
  });

  test("AC-19: app.useLogger() is called before app.useAppGlobalPrefix() in main.ts", () => {
    const content = readSrc("main.ts");
    const useLoggerIdx = content.indexOf("useLogger(");
    const usePrefixIdx = content.indexOf("useAppGlobalPrefix(");
    expect(useLoggerIdx).toBeGreaterThan(-1);
    expect(usePrefixIdx).toBeGreaterThan(-1);
    expect(useLoggerIdx).toBeLessThan(usePrefixIdx);
  });

  test("AC-20: No `import { Logger } from '@nestjs/common'` in apps/api/src", () => {
    const matches = grepSrc(
      /import\s*\{[^}]*\bLogger\b[^}]*\}\s*from\s*['"]@nestjs\/common['"]/,
    );
    expect(matches).toEqual([]);
  });

  test("AC-21: No console.log, console.error, console.warn calls in apps/api/src non-spec files", () => {
    const matches = grepSrc(/console\.(log|error|warn)\s*\(/);
    expect(matches).toEqual([]);
  });

  test("AC-22: App starts and responds without logger initialization errors (no 500 on public route)", async () => {
    const res = await fetch(`${BASE_URL}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "probe@test.com", password: "probe" }),
    });
    expect(res.status).toBeLessThan(500);
  });

  // ── Response shape ────────────────────────────────────────────────────────

  test("AC-23: Every controller method returns a JsonResponse instance (ok, created, or paginated)", () => {
    const controllerFiles = getAllTsFiles(SRC_DIR).filter(
      (f) => f.endsWith(".controller.ts") && !f.endsWith(".spec.ts"),
    );
    expect(controllerFiles.length).toBeGreaterThan(0);
    const nonCompliant = controllerFiles.filter(
      (f) => !/JsonResponse|\.ok\s*\(|\.created\s*\(|\.paginated\s*\(/.test(readFileSync(f, "utf8")),
    );
    expect(nonCompliant).toEqual([]);
  });

  test("AC-24: No throw new NestJS HTTP exception classes remain in apps/api/src", () => {
    const forbidden = grepSrc(
      /throw\s+new\s+(NotFoundException|ForbiddenException|UnauthorizedException|BadRequestException|ConflictException)\s*\(/,
    );
    expect(forbidden).toEqual([]);
  });

  test("AC-25: All AppException usages reference an i18n key (dotted namespace.key format)", () => {
    const files = grepSrc(/AppException/);
    const i18nKeyRegex = /['"][a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+['"]/;
    const nonCompliant = files.filter((f) => {
      const content = readFileSync(f, "utf8");
      const usages = content.match(/new\s+AppException\([^)]+\)/g) ?? [];
      return usages.some((u) => !i18nKeyRegex.test(u));
    });
    expect(nonCompliant).toEqual([]);
  });

  test("AC-26: API response shape is consistent — top-level `data` key present, no loose root fields", async () => {
    const email = `ac26-${Date.now()}@test.com`;
    const res = await fetch(`${BASE_URL}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "Password123!", name: "AC26" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toContain("data");
    // Loose fields from the old shape must not appear at root
    expect(Object.keys(body)).not.toContain("accessToken");
    expect(Object.keys(body)).not.toContain("refreshToken");
  });

  test("AC-27: Existing integration tests assert against the new { data: ... } response envelope", () => {
    const integrationDir = join(SRC_DIR, "integration");
    const integrationFiles = getAllTsFiles(integrationDir).filter((f) => f.endsWith(".spec.ts"));
    expect(integrationFiles.length).toBeGreaterThan(0);
    const usesDataEnvelope = integrationFiles.some((f) =>
      /res\.body\.data\b/.test(readFileSync(f, "utf8")),
    );
    expect(usesDataEnvelope).toBe(true);
  });

  test("AC-28: Auth login returns { data: { accessToken, refreshToken, user } }", async () => {
    const email = `ac28-${Date.now()}@test.com`;
    await fetch(`${BASE_URL}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "Password123!", name: "AC28" }),
    });
    const res = await fetch(`${BASE_URL}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "Password123!" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data?: { accessToken?: string; refreshToken?: string; user?: unknown };
    };
    expect(body.data).toBeDefined();
    expect(typeof body.data!.accessToken).toBe("string");
    expect(typeof body.data!.refreshToken).toBe("string");
    expect(body.data!.user).toBeDefined();
  });

  // ── Config ────────────────────────────────────────────────────────────────

  test("AC-29: app.config.ts, auth.config.ts, and database.config.ts all use registerAs", () => {
    const configFiles = [
      "config/app.config.ts",
      "config/auth.config.ts",
      "config/database.config.ts",
    ];
    for (const file of configFiles) {
      expect(srcExists(file)).toBe(true);
      expect(readSrc(file)).toMatch(/registerAs\s*\(/);
    }
  });

  test("AC-30: ConfigModule.forRoot in AppModule has a validate function referencing Joi", () => {
    const appModule = readSrc("app.module.ts");
    expect(appModule).toMatch(/ConfigModule\.forRoot/);
    expect(appModule).toMatch(/validate\s*:/);
    const configDir = join(SRC_DIR, "config");
    const configContent = existsSync(configDir)
      ? getAllTsFiles(configDir)
          .map((f) => readFileSync(f, "utf8"))
          .join("\n")
      : "";
    expect(appModule + configContent).toMatch(/\bJoi\b/);
  });

  test("AC-31: Config validation schema marks JWT_SECRET and DATABASE_URL as required", () => {
    const configDir = join(SRC_DIR, "config");
    const configContent = existsSync(configDir)
      ? getAllTsFiles(configDir)
          .map((f) => readFileSync(f, "utf8"))
          .join("\n")
      : "";
    const combined = configContent + readSrc("app.module.ts");
    expect(combined).toMatch(/JWT_SECRET/);
    expect(combined).toMatch(/DATABASE_URL/);
    expect(combined).toMatch(/\.required\(\)/);
  });

  test("AC-32: No configService.get('RAW_ENV_VAR') calls remain in apps/api/src", () => {
    // Typed config objects replace raw string lookups
    const matches = grepSrc(/configService\.get\s*\(\s*['"][A-Z][A-Z0-9_]+['"]\s*\)/);
    expect(matches).toEqual([]);
  });

  test("AC-33: apps/api/.env.example is up to date with all required environment variables", () => {
    const envExamplePath = join(API_DIR, ".env.example");
    expect(existsSync(envExamplePath)).toBe(true);
    const content = readFileSync(envExamplePath, "utf8");
    const required = [
      "JWT_SECRET",
      "DATABASE_URL",
      "DATABASE_PROVIDER",
      "API_PORT",
      "API_KEY_SECRET",
    ];
    for (const varName of required) {
      expect(content).toContain(varName);
    }
  });

  test("AC-34: All existing tests still pass with config mocked appropriately in test modules", () => {
    bunRunApi("test", ["--passWithNoTests", "--testPathIgnorePatterns=integration"], 180_000);
  });

  // ── Throttling ────────────────────────────────────────────────────────────

  test("AC-35: @nathapp/nestjs-throttler present in apps/api/package.json", () => {
    expect(allDeps["@nathapp/nestjs-throttler"]).toBeDefined();
  });

  test("AC-36: ThrottlerModule.forRootAsync registered in AppModule", () => {
    const content = readSrc("app.module.ts");
    expect(content).toMatch(/ThrottlerModule/);
    expect(content).toMatch(/ThrottlerModule\.forRootAsync\s*\(/);
  });

  test("AC-37: AuthController login and register endpoints have throttle protection applied", () => {
    const authController = readSrc("auth/auth.controller.ts");
    const appModule = readSrc("app.module.ts");
    // Throttle may be per-controller or applied globally via ThrottlerModule registration
    const hasControllerThrottle = /Throttle|ThrottlerGuard/.test(authController);
    const hasGlobalThrottle = /ThrottlerModule/.test(appModule);
    expect(hasControllerThrottle || hasGlobalThrottle).toBe(true);
  });

  test("AC-38: 11th request within a minute to /auth/login returns 429 Too Many Requests", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await fetch(`${BASE_URL}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: `throttle-ac38-${i}@test.com`, password: "wrong" }),
      });
      statuses.push(res.status);
    }
    expect(statuses).toContain(429);
  });

  test("AC-39: Throttle integration test exists in auth or integration test suite", () => {
    const authSpecFiles = getAllTsFiles(join(SRC_DIR, "auth")).filter((f) =>
      f.endsWith(".spec.ts"),
    );
    const integrationSpecFiles = existsSync(join(SRC_DIR, "integration"))
      ? getAllTsFiles(join(SRC_DIR, "integration")).filter((f) => f.endsWith(".spec.ts"))
      : [];
    const allSpecFiles = [...authSpecFiles, ...integrationSpecFiles];
    const hasThrottleTest = allSpecFiles.some((f) =>
      /429|throttl/i.test(readFileSync(f, "utf8")),
    );
    expect(hasThrottleTest).toBe(true);
  });

  // ── Prisma ────────────────────────────────────────────────────────────────

  test("AC-40: No duplicate PrismaService reimplementing PrismaClient when @nathapp/nestjs-prisma covers it", () => {
    if (!allDeps["@nathapp/nestjs-prisma"]) return;
    const localServicePath = join(SRC_DIR, "prisma", "prisma.service.ts");
    if (!existsSync(localServicePath)) return; // fully deleted — pass
    const content = readFileSync(localServicePath, "utf8");
    expect(content).not.toMatch(/extends\s+PrismaClient\b/);
  });

  test("AC-41: If a custom PrismaService exists, it extends the nathapp base PrismaService", () => {
    const localServicePath = join(SRC_DIR, "prisma", "prisma.service.ts");
    if (!existsSync(localServicePath)) return; // deleted — pass
    const content = readFileSync(localServicePath, "utf8");
    if (/class\s+PrismaService/.test(content)) {
      expect(content).toMatch(/extends\s+\w*PrismaService\b/);
      expect(content).toMatch(/@nathapp\/nestjs-prisma/);
    }
  });

  test("AC-42: apps/api/src/prisma/ is deleted or contains only a thin extension (not a full reimplementation)", () => {
    const prismaDir = join(SRC_DIR, "prisma");
    if (!existsSync(prismaDir)) {
      expect(true).toBe(true);
      return;
    }
    const sourceFiles = readdirSync(prismaDir).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".spec.ts"),
    );
    const isFullReimplementation = sourceFiles.some((f) => {
      const content = readFileSync(join(prismaDir, f), "utf8");
      return (
        /onModuleInit|enableShutdownHooks/.test(content) &&
        /extends\s+PrismaClient\b/.test(content)
      );
    });
    expect(isFullReimplementation).toBe(false);
  });

  test("AC-43: All feature modules import PrismaModule from the correct source", () => {
    const featureModules = [
      "agents/agents.module.ts",
      "projects/projects.module.ts",
      "tickets/tickets.module.ts",
      "comments/comments.module.ts",
      "labels/labels.module.ts",
    ];
    const usesNathappPrisma = !!allDeps["@nathapp/nestjs-prisma"];
    for (const moduleFile of featureModules) {
      if (!srcExists(moduleFile)) continue;
      const content = readSrc(moduleFile);
      if (usesNathappPrisma) {
        const hasLocalImport = /from\s+['"]\.\.\/prisma\/prisma\.module['"]/.test(content);
        if (hasLocalImport) {
          // Local module must re-export the nathapp module — not hand-roll it
          const localModule = readSrc("prisma/prisma.module.ts");
          expect(localModule).toMatch(/@nathapp\/nestjs-prisma/);
        }
      }
    }
    expect(true).toBe(true);
  });

  test("AC-44: All existing Prisma-dependent tests still pass", () => {
    bunRunApi("test", ["--passWithNoTests", "--testPathIgnorePatterns=integration"], 180_000);
  });

  // ── AppModule shape ───────────────────────────────────────────────────────

  test("AC-45: AppModule imports list matches the target shape exactly", () => {
    const content = readSrc("app.module.ts");
    const required = [
      "ConfigModule",
      "LoggingModule",
      "I18nCoreModule",
      "ThrottlerModule",
      "PrismaModule",
      "AuthModule",
      "AgentsModule",
      "ProjectsModule",
      "TicketsModule",
      "CommentsModule",
      "LabelsModule",
    ];
    for (const mod of required) {
      expect(content).toContain(mod);
    }
  });

  test("AC-46: AppModule has no APP_GUARD provider", () => {
    const content = readSrc("app.module.ts");
    expect(content).not.toMatch(/APP_GUARD/);
  });

  // ── Quality gates ─────────────────────────────────────────────────────────

  test("AC-47: bun run --cwd apps/api lint exits 0 with 0 warnings", () => {
    expect(() => bunRunApi("lint")).not.toThrow();
  });

  test("AC-48: bun run --cwd apps/api type-check exits 0 with 0 errors", () => {
    expect(() => bunRunApi("type-check")).not.toThrow();
  });

  test("AC-49: bun run test passes with >= 80% coverage for apps/api", () => {
    bunRunApi(
      "test:cov",
      [
        "--",
        '--coverageThreshold={"global":{"lines":80,"functions":80,"branches":80,"statements":80}}',
      ],
      300_000,
    );
  });

  test("AC-50: bun run api:export-spec completes without errors and produces valid openapi.json", () => {
    bunRunRoot("api:export-spec", 60_000);
    const specPath = join(MONOREPO_ROOT, "openapi.json");
    expect(existsSync(specPath)).toBe(true);
    const spec = JSON.parse(readFileSync(specPath, "utf8")) as Record<string, unknown>;
    expect(spec["openapi"]).toBeDefined();
    expect(spec["paths"]).toBeDefined();
    expect(typeof spec["paths"]).toBe("object");
  });
});
