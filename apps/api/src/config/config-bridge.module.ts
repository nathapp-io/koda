import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_CFG, IAppConfig } from './app.config';
import { AUTH_CFG, IAuthConfig } from './auth.config';
import { RAG_CFG, IRagConfig } from './rag.config';
import { VCS_CFG, IVcsConfig } from './vcs.config';

@Global()
@Module({
  providers: [
    { provide: APP_CFG,  useFactory: (cs: ConfigService) => cs.get<IAppConfig>('app'),   inject: [ConfigService] },
    { provide: AUTH_CFG, useFactory: (cs: ConfigService) => cs.get<IAuthConfig>('auth'), inject: [ConfigService] },
    { provide: RAG_CFG,  useFactory: (cs: ConfigService) => cs.get<IRagConfig>('rag'),   inject: [ConfigService] },
    { provide: VCS_CFG,  useFactory: (cs: ConfigService) => cs.get<IVcsConfig>('vcs'),   inject: [ConfigService] },
  ],
  exports: [APP_CFG, AUTH_CFG, RAG_CFG, VCS_CFG],
})
export class ConfigBridgeModule {}
