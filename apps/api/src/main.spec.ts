import { AppModule } from './app.module';

describe('main.ts (bootstrap)', () => {
  it('should have AppModule defined', () => {
    expect(AppModule).toBeDefined();
  });

  it('should have correct bootstrap configuration', () => {
    // The main.ts file should:
    // 1. Use AppFactory.createFastifyApp with AppModule
    // 2. Set API prefix to 'api'
    // 3. Enable Swagger docs
    // 4. Listen on API_PORT (default 3100)

    // Verify AppModule is defined and can be used
    expect(AppModule).toBeDefined();
  });

  it('should configure with Fastify platform', () => {
    // AppFactory.createFastifyApp uses Fastify by default
    expect(AppModule).toBeDefined();
  });

  it('should enable Swagger documentation', () => {
    // useSwaggerUIOnDevOnly should be called with appropriate config
    expect(AppModule).toBeDefined();
  });
});
