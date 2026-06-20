import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_CFG, IAppConfig } from './app.config';
import { AUTH_CFG, IAuthConfig } from './auth.config';
import { RAG_CFG, IRagConfig } from './rag.config';
import { VCS_CFG, IVcsConfig } from './vcs.config';

@Global()
@Module({
  providers: [
    {
      provide: APP_CFG,
      useFactory: (cs: ConfigService) => {
        const cfg = cs.get<IAppConfig>('app');
        if (!cfg) throw new Error('ConfigBridgeModule: app config not loaded — ensure appConfig is in ConfigModule.forRoot load array');
        return cfg;
      },
      inject: [ConfigService],
    },
    {
      provide: AUTH_CFG,
      useFactory: (cs: ConfigService) => {
        const cfg = cs.get<IAuthConfig>('auth');
        if (!cfg) throw new Error('ConfigBridgeModule: auth config not loaded — ensure authConfig is in ConfigModule.forRoot load array');
        return cfg;
      },
      inject: [ConfigService],
    },
    {
      provide: RAG_CFG,
      useFactory: (cs: ConfigService) => {
        const cfg = cs.get<IRagConfig>('rag');
        if (!cfg) throw new Error('ConfigBridgeModule: rag config not loaded — ensure ragConfig is in ConfigModule.forRoot load array');
        return cfg;
      },
      inject: [ConfigService],
    },
    {
      provide: VCS_CFG,
      useFactory: (cs: ConfigService) => {
        const cfg = cs.get<IVcsConfig>('vcs');
        if (!cfg) throw new Error('ConfigBridgeModule: vcs config not loaded — ensure vcsConfig is in ConfigModule.forRoot load array');
        return cfg;
      },
      inject: [ConfigService],
    },
  ],
  exports: [APP_CFG, AUTH_CFG, RAG_CFG, VCS_CFG],
})
export class ConfigBridgeModule {}
