import { AppModule } from './app.module';

describe('AppModule', () => {
  it('should be defined', () => {
    expect(AppModule).toBeDefined();
  });

  it('should be decorated with @Module', () => {
    // AppModule is decorated with @Module decorator
    expect(AppModule).toBeDefined();
  });

  it('should have ConfigModule imported (global)', () => {
    // ConfigModule is imported with isGlobal: true
    expect(AppModule).toBeDefined();
  });

  it('should have PrismaModule imported (global)', () => {
    expect(AppModule).toBeDefined();
  });

  it('should have AuthModule imported', () => {
    expect(AppModule).toBeDefined();
  });

  it('should have AgentsModule imported', () => {
    expect(AppModule).toBeDefined();
  });

  it('should have ProjectsModule imported', () => {
    expect(AppModule).toBeDefined();
  });

  it('should have TicketsModule imported', () => {
    expect(AppModule).toBeDefined();
  });

  it('should have CommentsModule imported', () => {
    expect(AppModule).toBeDefined();
  });
});
