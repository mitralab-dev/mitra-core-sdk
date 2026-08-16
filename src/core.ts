import type { SdkCoreErrorFactory } from "./errors"
import { defaultSdkCoreErrorFactory } from "./errors"
import { createAuthModule, type AuthModule } from "./modules/auth"
import { createDataSourcesModule, type DataSourcesModule } from "./modules/dataSources"
import { createEntitiesModule, type EntitiesProxy } from "./modules/entities"
import {
  createFunctionsModule,
  type FunctionsModule,
  type FunctionsModuleOptions,
} from "./modules/functions"
import { createFunctionsAdminModule, type FunctionsAdminModule } from "./modules/functionsAdmin"
import { createIntegrationModule, type IntegrationModule } from "./modules/integration"
import {
  createIntegrationAdminModule,
  type IntegrationAdminModule,
} from "./modules/integrationAdmin"
import { createMembersModule, type MembersModule } from "./modules/members"
import { createQueriesModule, type QueriesModule } from "./modules/queries"
import { createSqlModule, type SqlModule } from "./modules/sql"
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
  readonly dataSources: DataSourcesModule
  readonly entities: EntitiesProxy
  readonly functions: FunctionsModule
  readonly functionsAdmin: FunctionsAdminModule
  readonly integration: IntegrationModule
  readonly integrationAdmin: IntegrationAdminModule
  readonly members: MembersModule
  readonly queries: QueriesModule
  readonly sql: SqlModule
}

export function createSdkCore(options: SdkCoreOptions): SdkCore {
  const errors = options.errors ?? defaultSdkCoreErrorFactory
  return {
    auth: createAuthModule(options.transports.auth, errors),
    dataSources: createDataSourcesModule(options.transports.dataManager, errors),
    entities: createEntitiesModule(options.transports.dataManager, errors),
    functions: createFunctionsModule(options.transports.functions, options.functions, errors),
    functionsAdmin: createFunctionsAdminModule(options.transports.functions, errors),
    integration: createIntegrationModule(options.transports.integration, errors),
    integrationAdmin: createIntegrationAdminModule(options.transports.integration, errors),
    members: createMembersModule(options.transports.auth, errors),
    queries: createQueriesModule(options.transports.dataManager, options.getDataSourceId, errors),
    sql: createSqlModule(options.transports.dataManager, errors),
  }
}
