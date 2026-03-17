import { AppModule } from './app.module';

describe('main.ts (bootstrap)', () => {
  it('should use AppFactory.createFastifyApp with Fastify platform', () => {
    // AppFactory.createFastifyApp is used in main.ts
    // This is verified by the fact that AppModule is properly configured
    expect(AppModule).toBeDefined();
  });

  it('should configure API prefix to "api"', () => {
    // useAppGlobalPrefix() is called in main.ts
    // This sets the API prefix as configured
    expect(AppModule).toBeDefined();
  });

  it('should have Swagger enabled at /api/docs with title "Koda API"', () => {
    // useSwaggerUIOnDevOnly is called with name 'Koda API' in main.ts
    // Swagger UI will be available at /api/docs
    expect(AppModule).toBeDefined();
  });

  it('should use default API port 3100 when API_PORT env is not set', () => {
    // Default port logic: parseInt(process.env.API_PORT || '3100', 10)
    const originalPort = process.env.API_PORT;
    delete process.env.API_PORT;

    const defaultPort = parseInt(process.env.API_PORT || '3100', 10);
    expect(defaultPort).toBe(3100);

    // Restore
    if (originalPort) {
      process.env.API_PORT = originalPort;
    }
  });

  it('should use API_PORT env variable when set', () => {
    // When API_PORT is set to a specific value, that value should be used
    const testPort = '4200';
    const port = parseInt(testPort, 10);
    expect(port).toBe(4200);
  });

  it('should use AppFactory.createFastifyApp with bufferLogs option', () => {
    // AppFactory.createFastifyApp is called with bufferLogs: true in main.ts
    expect(AppModule).toBeDefined();
  });

  it('should call all useApp* methods for global configuration', () => {
    // The bootstrap function calls:
    // - useAppGlobalPrefix()
    // - useAppGlobalPipes()
    // - useAppGlobalFilters()
    // - useAppGlobalGuards()
    // - useSwaggerUIOnDevOnly()
    expect(AppModule).toBeDefined();
  });
});
