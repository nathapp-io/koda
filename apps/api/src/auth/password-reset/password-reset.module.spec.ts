import { Test, TestingModule } from '@nestjs/testing';
import { GlobalStubsModule } from '../../common/test-helpers/global-stubs.module';
import { EmailDispatcher } from '../../email/email-dispatcher';
import { PasswordResetController } from './password-reset.controller';
import { PasswordResetModule } from './password-reset.module';
import { PasswordResetService } from './password-reset.service';
import { PasswordResetTokenStore } from './password-reset-token.store';

/**
 * auth-passwords US-003: module-registration wiring only — no database (see api-testing rules).
 *
 * `AuthModule` imports the leaf store module instead of this one, so this compilation is also the
 * check that the request module's own dependency chain (notifications → live → auth) closes without
 * a cycle.
 */
describe('PasswordResetModule (DI wiring, no database)', () => {
  let moduleRef: TestingModule;

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [GlobalStubsModule, PasswordResetModule],
    }).compile();
  });

  afterEach(async () => {
    await moduleRef?.close();
  });

  it('exposes the controller behind the service', () => {
    expect(moduleRef.get(PasswordResetController)).toBeInstanceOf(PasswordResetController);
    expect(moduleRef.get(PasswordResetService)).toBeInstanceOf(PasswordResetService);
  });

  it('resolves the store, the dispatcher and the email collaborators it depends on', () => {
    expect(moduleRef.get(PasswordResetTokenStore)).toBeInstanceOf(PasswordResetTokenStore);
    expect(moduleRef.get(EmailDispatcher)).toBeInstanceOf(EmailDispatcher);
  });

  it('exports nothing: the request module is a surface, not a dependency', () => {
    expect(Reflect.getMetadata('exports', PasswordResetModule) ?? []).toEqual([]);
  });
});
