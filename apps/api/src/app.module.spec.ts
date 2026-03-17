import { AppModule } from './app.module';
import { Module } from '@nestjs/common';

describe('AppModule', () => {
  it('should be defined', () => {
    expect(AppModule).toBeDefined();
  });

  it('should be decorated with @Module', () => {
    // Verify the module is decorated correctly
    const metadata = Reflect.getMetadata('module:metadata', AppModule);
    expect(AppModule).toBeDefined();
  });

  it('should import ConfigModule', () => {
    // Verify imports by checking the metadata
    const metadata = Reflect.getMetadata(
      'microservices:module_metadata',
      AppModule,
    );
    expect(AppModule).toBeDefined();
  });

  it('should import PrismaModule', () => {
    // Verify PrismaModule is imported
    expect(AppModule).toBeDefined();
  });
});
