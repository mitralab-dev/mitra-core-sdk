import type { SdkCoreErrorFactory } from "./errors"
import { defaultSdkCoreErrorFactory } from "./errors"
import { createAuthModule, type AuthModule } from "./modules/auth"
import { createEntitiesModule, type EntitiesProxy } from "./modules/entities"
import {
  createFunctionsModule,
  type FunctionsModule,
  type FunctionsModuleOptions,
} from "./modules/functions"
import { createIntegrationModule, type IntegrationModule } from "./modules/integration"
import { createQueriesModule, type QueriesModule } from "./modules/queries"
import type { Transport } from "./transport"

export interface SdkCoreTransports {
  auth: Transport
  dataManager: Transport
  functions: Transport
  integration: Transport
}

export interface SdkCoreOptions {
  transports: SdkCoreTransports
  getDataSourceId: () => string | undefined
  functions?: FunctionsModuleOptions
  errors?: SdkCoreErrorFactory
}

export interface SdkCore {
  readonly auth: AuthModule
  readonly entities: EntitiesProxy
  readonly functions: FunctionsModule
  readonly integration: IntegrationModule
  readonly queries: QueriesModule
}

export function createSdkCore(options: SdkCoreOptions): SdkCore {
  const errors = options.errors ?? defaultSdkCoreErrorFactory
  return {
    auth: createAuthModule(options.transports.auth, errors),
    entities: createEntitiesModule(options.transports.dataManager, errors),
    functions: createFunctionsModule(options.transports.functions, options.functions, errors),
    integration: createIntegrationModule(options.transports.integration, errors),
    queries: createQueriesModule(options.transports.dataManager, options.getDataSourceId, errors),
  }
}
