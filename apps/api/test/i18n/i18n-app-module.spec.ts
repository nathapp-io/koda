import 'reflect-metadata';
import { AppModule } from '../../src/app.module';

describe('AppModule i18n registration', () => {
  it('should import I18nCoreModule', () => {
    const imports: unknown[] = Reflect.getMetadata('imports', AppModule) ?? [];

    const hasI18nCoreModule = imports.some((m) => {
      if (typeof m === 'function') {
        return m.name === 'I18nCoreModule';
      }
      if (typeof m === 'object' && m !== null) {
        const obj = m as Record<string, unknown>;
        // Dynamic module shape: { module: I18nCoreModule, ... }
        if (typeof obj['module'] === 'function') {
          return (obj['module'] as { name: string }).name === 'I18nCoreModule';
        }
      }
      return false;
    });

    expect(hasI18nCoreModule).toBe(true);
  });
});
