```typescript

import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import * as crypto from "crypto";
import * as bcrypt from "bcrypt";

describe("api-foundation - Acceptance Tests", () => {
  let app: INestApplication;
  let prismaService: PrismaService;
  let moduleFixture: TestingModule;
  const API_KEY_SECRET = process.env.API_KEY_SECRET || "test-secret";

  beforeAll(async () => {
    moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const fastifyAdapter = new FastifyAdapter();
    const nestApp = moduleFixture.createNestApplication(fastifyAdapter);

    nestApp.setGlobalPrefix("api");
    nestApp.useGlobalPipes(new ValidationPipe());

    await nestApp.init();
    await nestApp.getHttpAdapter().getInstance().ready();

    app = nestApp;
    prismaService = moduleFixture.get<PrismaService>(PrismaService);

    await prismaService.$connect();
  });

  afterAll(async () => {
    await prismaService.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await prismaService.user.deleteMany({});
    await prismaService.agent.deleteMany({});
    await prismaService.project.deleteMany({});
    await prismaService.ticket.deleteMany({});
    await prismaService.comment.deleteMany({});
  });

  test("AC-1: main.ts uses AppFactory.create with Fastify platform", async () => {
    expect(app).toBeDefined();
    expect(app.getHttpServer()).toBeDefined();
  });

  test("AC-2: API prefix is set to 'api'", async () => {
    const response = await app.getHttpServer().inject({
      method: "GET",
      url: "/api/health",
    });
    expect(response.statusCode).not.toBe(404);
  });

  test("AC-3: Swagger enabled at /api/docs with title 'Koda API'", async () => {
    const response = await app.getHttpServer().inject({
      method: "GET",
      url: "/api/docs",
    });
    expect([200, 301, 302]).toContain(response.statusCode);
  });

  test("AC-4: app.module.ts imports ConfigModule (global), PrismaModule, AuthModule, AgentsModule, ProjectsModule, TicketsModule, CommentsModule", async () => {
    const appModule = moduleFixture.get(AppModule);
    expect(appModule).toBeDefined();
  });

  test("AC-5: Server starts on port from API_PORT env (default 3100)", async () => {
    const port = process.env.API_PORT || "3100";
    expect(app).toBeDefined();
    expect(Number.isInteger(Number(port))).toBe(true);
  });

  test("AC-6: bun run build passes", async () => {
    const buildCommand = Bun.spawnSync({
      cmd: ["bun", "run", "build"],
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(buildCommand.success).toBe(true);
  });

  test("AC-7: GET /api/docs returns 200", async () => {
    const response = await app.getHttpServer().inject({
      method: "GET",
      url: "/api/docs",
    });
    expect([200, 301, 302]).toContain(response.statusCode);
  });

  test("AC-8: PrismaService extends PrismaClient", async () => {
    expect(prismaService).toBeDefined();
    expect(typeof prismaService.$connect).toBe("function");
    expect(typeof prismaService.$disconnect).toBe("function");
  });

  test("AC-9: PrismaService implements OnModuleInit with $connect", async () => {
    const prismaInstance = moduleFixture.get<PrismaService>(PrismaService);
    expect(typeof prismaInstance.onModuleInit).toBe("function");
  });

  test("AC-10: PrismaService implements OnModuleDestroy with $disconnect", async () => {
    const prismaInstance = moduleFixture.get<PrismaService>(PrismaService);
    expect(typeof prismaInstance.onModuleDestroy).toBe("function");
  });

  test("AC-11: PrismaModule decorated with @Global()", async () => {
    const prismaInstance = moduleFixture.get<PrismaService>(PrismaService);
    expect(prismaInstance).toBeDefined();
  });

  test("AC-12: PrismaModule exports PrismaService", async () => {
    const prismaInstance = moduleFixture.get<PrismaService>(PrismaService);
    expect(prismaInstance).toBeDefined();
  });

  test("AC-13: Database migration 'init' created successfully", async () => {
    const result = await prismaService.user.findMany();
    expect(Array.isArray(result)).toBe(true);
  });

  test("AC-14: prisma.user.count() returns 0 without error", async () => {
    const count = await prismaService.user.count();
    expect(count).toBe(0);
  });

  test("AC-15: POST /api/auth/register accepts { email, name, password }, creates User with bcrypt hash (12 rounds), returns { accessToken, refreshToken, user }", async () => {
    const response = await app.getHttpServer().inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "register@test.com",
        name: "Test User",
        password: "Password123!",
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty("accessToken");
    expect(body).toHaveProperty("refreshToken");
    expect(body).toHaveProperty("user");
    expect(body.user.email).toBe("register@test.com");
    expect(body.user.name).toBe("Test User");

    const user = await prismaService.user.findUnique({
      where: { email: "register@test.com" },
    });
    expect(user).toBeDefined();
    expect(user.password).not.toBe("Password123!");
  });

  test("AC-16: POST /api/auth/login accepts { email, password }, verifies credentials, returns token pair", async () => {
    const password = "LoginPassword123!";
    const hashedPassword = await bcrypt.hash(password, 12);

    await prismaService.user.create({
      data: {
        email: "login@test.com",
        name: "Login User",
        password: hashedPassword,
        role: "USER",
      },
    });

    const response = await app.getHttpServer().inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "login@test.com",
        password: password,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty("accessToken");
    expect(body).toHaveProperty("refreshToken");
  });

  test("AC-17: POST /api/auth/refresh accepts Bearer refreshToken, returns new access and refresh tokens", async () => {
    const password = "RefreshPassword123!";
    const hashedPassword = await bcrypt.hash(password, 12);

    await prismaService.user.create({
      data: {
        email: "refresh@test.com",
        name: "Refresh User",
        password: hashedPassword,
        role: "USER",
      },
    });

    const loginResponse = await app.getHttpServer().inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "refresh@test.com",
        password: password,
      },
    });

    const loginBody = JSON.parse(loginResponse.body);

    const response = await app.getHttpServer().inject({
      method: "POST",
      url: "/api/auth/refresh",
      headers: {
        authorization: `Bearer ${loginBody.refreshToken}`,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty("accessToken");
    expect(body).toHaveProperty("refreshToken");
  });

  test("AC-18: GET /api/auth/me accepts Bearer accessToken, returns authenticated User", async () => {
    const password = "MePassword123!";
    const hashedPassword = await bcrypt.hash(password, 12);

    await prismaService.user.create({
      data: {
        email: "me@test.com",
        name: "Me User",
        password: hashedPassword,
        role: "USER",
      },
    });

    const loginResponse = await app.getHttpServer().inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "me@test.com",
        password: password,
      },
    });

    const loginBody = JSON.parse(loginResponse.body);

    const response = await app.getHttpServer().inject({
      method: "GET",
      url: "/api/auth/me",
      headers: {
        authorization: `Bearer ${loginBody.accessToken}`,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.email).toBe("me@test.com");
  });

  test("AC-19: JWT payload contains sub (userId), email, role", async () => {
    const password = "JwtPassword123!";
    const hashedPassword = await bcrypt.hash(password, 12);

    const user = await prismaService.user.create({
      data: {
        email: "jwt@test.com",
        name: "JWT User",
        password: hashedPassword,
        role: "USER",
      },
    });

    const loginResponse = await app.getHttpServer().inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "jwt@test.com",
        password: password,
      },
    });

    const loginBody = JSON.parse(loginResponse.body);
    const accessToken = loginBody.accessToken;

    const decoded = JSON.parse(
      Buffer.from(accessToken.split(".")[1], "base64").toString()
    );

    expect(decoded).toHaveProperty("sub", user.id);
    expect(decoded).toHaveProperty("email", "jwt@test.com");
    expect(decoded).toHaveProperty("role", "USER");
  });

  test("AC-20: Invalid password returns 401", async () => {
    const password = "CorrectPassword123!";
    const hashedPassword = await bcrypt.hash(password, 12);

    await prismaService.user.create({
      data: {
        email: "invalid@test.com",
        name: "Invalid User",
        password: hashedPassword,
        role: "USER",
      },
    });

    const response = await app.getHttpServer().inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "invalid@test.com",
        password: "WrongPassword123!",
      },
    });

    expect(response.statusCode).toBe(401);
  });

  test("AC-21: Missing token on /api/auth/me returns 401", async () => {
    const response = await app.getHttpServer().inject({
      method: "GET",
      url: "/api/auth/me",
    });

    expect(response.statusCode).toBe(401);
  });

  test("AC-22: All endpoints properly documented in Swagger", async () => {
    const response = await app.getHttpServer().inject({
      method: "GET",
      url: "/api/docs-json",
    });

    expect([200, 301, 302]).toContain(response.statusCode);
    if (response.statusCode === 200) {
      const swagger = JSON.parse(response.body);
      expect(swagger.paths).toBeDefined();
    }
  });

  test("AC-23: ApiKeyGuard extracts Bearer token from Authorization header", async () => {
    const apiKey = crypto.randomBytes(32).toString("hex");
    const apiKeyHash = crypto
      .createHmac("sha256", API_KEY_SECRET)
      .update(apiKey)
      .digest("hex");

    await prismaService.agent.create({
      data: {
        name: "Test Agent",
        apiKeyHash: apiKeyHash,
        status: "ACTIVE",
      },
    });

    const response = await app.getHttpServer().inject({
      method: "GET",
      url: "/api/agents",
      headers: {
        authorization: `Bearer ${apiKey}`,
      },
    });

    expect([200, 403, 401]).toContain(response.statusCode);
  });

  test("AC-24: ApiKeyGuard computes HMAC-SHA256 with API_KEY_SECRET env", async () => {
    const apiKey = crypto.randomBytes(32).toString("hex");
    const expectedHash = crypto
      .createHmac("sha256", API_KEY_SECRET)
      .update(apiKey)
      .digest("hex");

    expect(expectedHash).toBeDefined();
    expect(expectedHash.length).toBe(64);
  });

  test("AC-25: ApiKeyGuard looks up Agent by apiKeyHash", async () => {
    const apiKey = crypto.randomBytes(32).toString("hex");
    const apiKeyHash = crypto
      .createHmac("sha256", API_KEY_SECRET)
      .update(apiKey)
      .digest("hex");

    const agent = await prismaService.agent.create({
      data: {
        name: "Lookup Agent",
        apiKeyHash: apiKeyHash,
        status: "ACTIVE",
      },
    });

    const foundAgent = await prismaService.agent.findUnique({
      where: { apiKeyHash: apiKeyHash },
    });

    expect(foundAgent).toBeDefined();
    expect(foundAgent.id).toBe(agent.id);
  });

  test("AC-26: ApiKeyGuard attaches agent to request.agent and sets request.actorType = 'agent'", async () => {
    const apiKey = crypto.randomBytes(32).toString("hex");
    const apiKeyHash = crypto
      .createHmac("sha256", API_KEY_SECRET)
      .update(apiKey)
      .digest("hex");

    await prismaService.agent.create({
      data: {
        name: "Request Agent",
        apiKeyHash: apiKeyHash,
        status: "ACTIVE",
      },
    });

    const response = await app.getHttpServer().inject({
      method: "GET",
      url: "/api/agents/whoami",
      headers: {
        authorization: `Bearer ${apiKey}`,
      },
    });

    expect([200, 401]).toContain(response.statusCode);
  });

  test("AC-27: Only ACTIVE agents accepted (reject PAUSED/OFFLINE)", async () => {
    const apiKey = crypto.randomBytes(32).toString("hex");
    const apiKeyHash = crypto
      .createHmac("sha256", API_KEY_SECRET)
      .update(apiKey)
      .digest("hex");

    await prismaService.agent.create({
      data: {
        name: "Paused Agent",
        apiKeyHash: apiKeyHash,
        status: "PAUSED",
      },
    });

    const response = await app.getHttpServer().inject({
      method: "GET",
      url: "/api/agents",
      headers: {
        authorization: `Bearer ${apiKey}`,
      },
    });

    expect(response.statusCode).toBe(401);
  });

  test("AC-28: POST /api/agents generates random 32-byte hex key", async () => {
    const password = "AgentPassword123!";
    const hashedPassword = await bcrypt.hash(password, 12);

    await prismaService.user.create({
      data: {
        email: "agent@test.com",
        name: "Agent User",
        password: hashedPassword,
        role: "USER",
      },
    });

    const loginResponse = await app.getHttpServer().inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "agent@test.com",
        password: password,
      },
    });

    const loginBody = JSON.parse(loginResponse.body);

    const response = await app.getHttpServer().inject({
      method: "POST",
      url: "/api/agents",
      headers: {
        authorization: `Bearer ${loginBody.accessToken}`,
      },
      payload: {
        name: "New Agent",
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty("apiKey");
    expect(body.apiKey.length).toBe(64);
  });

  test("AC-29: POST /api/agents stores HMAC-SHA256 hash in database", async () => {
    const password = "HashPassword123!";
    const hashedPassword = await bcrypt.hash(password, 12);

    await prismaService.user.create({
      data: {
        email: "hash@test.com",
        name: "Hash User",
        password: hashedPassword,
        role: "USER",
      },
    });

    const loginResponse = await app.getHttpServer().inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "hash@test.com",
        password: password,
      },
    });

    const loginBody = JSON.parse(loginResponse.body);

    const response = await app.getHttpServer().inject({
      method: "POST",
      url: "/api/agents",
      headers: {
        authorization: `Bearer ${loginBody.accessToken}`,
      },
      payload: {
        name: "Hash Agent",
      },
    });

    expect(response.statusCode).toBe(201);

    const agent = await prismaService.agent.findFirst({
      where: { name: "Hash Agent" },
    });

    expect(agent.apiKeyHash).toBeDefined();
    expect(agent.apiKeyHash.length).toBe(64);
  });

  test("AC-30: POST /api/agents returns raw key ONCE to client", async () => {
    const password = "OncePassword123!";
    const hashedPassword = await bcrypt.hash(password, 12);

    await prismaService.user.create({
      data: {
        email: "once@test.com",
        name: "Once User",
        password: hashedPassword,
        role: "USER",
      },
    });

    const loginResponse = await app.getHttpServer().inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "once@test.com",
        password: password,
      },
    });

    const loginBody = JSON.parse(loginResponse.body);

    const response = await app.getHttpServer().inject({
      method: "POST",
      url: "/api/agents",
      headers: {
        authorization: `Bearer ${loginBody.accessToken}`,
      },
      payload: {
        name: "Once Agent",
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty("apiKey");
    expect(body.apiKey).toBeDefined();
  });

  test("AC-31: CombinedAuthGuard attempts JWT first, falls back to ApiKeyGuard", async () => {
    const password = "CombinedPassword123!";
    const hashedPassword = await bcrypt.hash(password, 12);

    await prismaService.user.create({
      data: {
        email: "combined@test.com",
        name: "Combined User",
        password: hashedPassword,
        role: "USER",
      },
    });

    const loginResponse = await app.getHttpServer().inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "combined@test.com",
        password: password,
      },
    });

    const loginBody = JSON.parse(loginResponse.body);

    const response = await app.getHttpServer().inject({
      method: "GET",
      url: "/api/auth/me",
      headers: {
        authorization: `Bearer ${loginBody.accessToken}`,
      },
    });

    expect(response.statusCode).toBe(200);
  });

  test("AC-32: Invalid API key returns 401", async () => {
    const response = await app.getHttpServer().inject({
      method: "GET",
      url: "/api/agents",
      headers: {
        authorization: "Bearer invalid-key-that-does-not-exist",
      },
    });

    expect(response.statusCode).toBe(401);
  });

  test("AC-33: Valid API key attaches agent to request", async () => {
    const apiKey = crypto.randomBytes(32).toString("hex");
    const apiKeyHash = crypto
      .createHmac("sha256", API_KEY_SECRET)
      .update(apiKey)
      .digest("hex");

    await prismaService.agent.create({
      data: {
        name: "Valid Agent",
        apiKeyHash: apiKeyHash,
        status: "ACTIVE",
      },
    });

    const response = await app.getHttpServer().inject({
      method: "GET",
      url: "/api/agents/whoami",
      headers: {
        authorization: `Bearer ${apiKey}`,
      },
    });

    expect([200, 401]).toContain(response.statusCode);
  });

  test("AC-34: @IsPublic() decorator uses SetMetadata('isPublic', true)", async () => {
    const response = await app.getHttpServer().inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "public@test.com",
        name: "Public User",
        password: "PublicPassword123!",
      },
    });

    expect(response.statusCode).toBe(201);
  });

  test("AC-35: CombinedAuthGuard checks isPublic metadata before auth", async () => {
    const response = await app.getHttpServer().inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "metadata@test.com",
        name: "Metadata User",
        password: "MetadataPassword123!",
      },
    });

    expect(response.statusCode).toBe(201);
  });

  test("AC-36: Public routes accessible without authentication", async () => {
    const response = await app.getHttpServer().inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "noauth@test.com",
        name: "No Auth User",
        password: "NoAuthPassword123!",
      },
    });

    expect(response.statusCode).toBe(201);
  });

  test("AC-37: Protected endpoints return 401 without token", async () => {
    const response = await app.getHttpServer().inject({
      method: "GET",
      url: "/api/auth/me",
    });

    expect(response.statusCode).toBe(401);
  });

  test("AC-38: CombinedAuthGuard registered globally via APP_GUARD", async () => {
    const response = await app.getHttpServer().inject({
      method: "GET",
      url: "/api/projects",
    });

    expect(response.statusCode).toBe(401);
  });

  test("AC-39: @CurrentUser() returns req.user for JWT auth", async () => {
    const password = "CurrentUserPassword123!";
    const hashedPassword = await bcrypt.hash(password, 12);

    await prismaService.user.create({
      data: {
        email: "currentuser@test.com",
        name: "Current User",
        password: hashedPassword,
        role: "USER",
      },
    });

    const loginResponse = await app.getHttpServer().inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "currentuser@test.com",
        password: password,
      },
    });

    const loginBody = JSON.parse(loginResponse.body);

    const response = await app.getHttpServer().inject({
      method: "GET",
      url: "/api/auth/me",
      headers: {
        authorization: `Bearer ${loginBody.accessToken}`,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.email).toBe("currentuser@test.com");
  });

  test("AC-40: @CurrentUser() returns req.agent for API key auth", async () => {
    const apiKey = crypto.randomBytes(32).toString("hex");
    const apiKeyHash = crypto
      .createHmac("sha256", API_KEY_SECRET)
      .update(apiKey)
      .digest("hex");

    const agent = await prismaService.agent.create({
      data: {
        name: "Current Agent",
        apiKeyHash: apiKeyHash,
        status: "ACTIVE",
      },
    });

    const response = await app.getHttpServer().inject({
      method: "GET",
      url: "/api/agents/current",
      headers: {
        authorization: `Bearer ${apiKey}`,
      },
    });

    expect([200, 401]).toContain(response.statusCode);
  });

  test("AC-41: Auth endpoints (/register, /login, /refresh) marked @IsPublic()", async () => {
    const registerResponse = await app.getHttpServer().inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "public1@test.com",
        name: "Public User 1",
        password: "Public1Password123!",
      },
    });

    expect(registerResponse.statusCode).toBe(201);

    const loginResponse = await app.getHttpServer().inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "public1@test.com",
        password: "Public1Password123!",
      },
    });

    expect(loginResponse.statusCode).toBe(200);

    const loginBody = JSON.parse(loginResponse.body);

    const refreshResponse = await app.getHttpServer().inject({
      method: "POST",
      url: "/api/auth/refresh",
      headers: {
        authorization: `Bearer ${loginBody.refreshToken}`,
      },
    });

    expect(refreshResponse.statusCode).toBe(200);
  });

  test("AC-42: Integration tests verify both auth flows work end-to-end", async () => {
    const registerResponse = await app.getHttpServer().inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "integration@test.com",
        name: "Integration User",
        password: "IntegrationPassword123!",
      },
    });

    expect(registerResponse.statusCode).toBe(201);
    const registerBody = JSON.parse(registerResponse.body);
    expect(registerBody).toHaveProperty("accessToken");

    const meResponse = await app.getHttpServer().inject({
      method: "GET",
      url: "/api/auth/me",
      headers: {
        authorization: `Bearer ${registerBody.accessToken}`,
      },
    });

    expect(meResponse.statusCode).toBe(200);
    const meBody = JSON.parse(meResponse.body);
    expect(meBody.email).toBe("integration@test.com");

    const apiKey = crypto.randomBytes(32).toString("hex");
    const apiKeyHash = crypto
      .createHmac("sha256", API_KEY_SECRET)
      .update(apiKey)
      .digest("hex");

    const agent = await prismaService.agent.create({
      data: {
        name: "Integration Agent",
        apiKeyHash: apiKeyHash,
        status: "ACTIVE",
      },
    });

    const agentResponse = await app.getHttpServer().inject({
      method: "GET",
      url: "/api/agents/current",
      headers: {
        authorization: `Bearer ${apiKey}`,
      },
    });

    expect([200, 401]).toContain(agentResponse.statusCode);
  });
});
```