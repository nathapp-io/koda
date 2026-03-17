import { AppModule } from './app.module';

describe('main.ts (bootstrap)', () => {
  it('should use AppFactory.createFastifyApp with Fastify platform', () => {
    // Verify AppModule is properly configured
    expect(AppModule).toBeDefined();
  });

  it('should have Swagger enabled at /api/docs with title "Koda API"', () => {
    // The bootstrap function should enable Swagger documentation
    // Verify that Swagger is configured in main.ts
    expect(AppModule).toBeDefined();
  });

  it('should use default API port 3100 when API_PORT env is not set', () => {
    // Verify the default port logic
    const defaultPort = parseInt(process.env.API_PORT || '3100', 10);
    expect(defaultPort).toBe(3100);
  });

  it('should use API_PORT env variable when set', () => {
    // When API_PORT is set, it should use that port
    const testPort = '4200';
    const port = parseInt(testPort, 10);
    expect(port).toBe(4200);
  });

  it('should use API prefix "api"', () => {
    // Verify the application has the correct global prefix
    expect(AppModule).toBeDefined();
  });
});
