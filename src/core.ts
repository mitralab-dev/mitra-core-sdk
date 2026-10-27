import type { SdkCoreErrorFactory } from "./errors"
import { defaultSdkCoreErrorFactory } from "./errors"
import {
  createAgentConnectionsModule,
  type AgentConnectionsModule,
} from "./modules/agentConnections"
import {
  createAgentCredentialsModule,
  type AgentCredentialsModule,
} from "./modules/agentCredentials"
import { createAgentsModule, type AgentsModule } from "./modules/agents"
import { createAgentTasksModule, type AgentTasksModule } from "./modules/agentTasks"
import { createAppsModule, type AppsModule } from "./modules/apps"
import { createAuthModule, type AuthModule } from "./modules/auth"
import { createContextModule, type ContextModule } from "./modules/context"
import { createCustomQueriesModule, type CustomQueriesModule } from "./modules/customQueries"
import { createDataSourcesModule, type DataSourcesModule } from "./modules/dataSources"
import { createEntitiesModule, type EntitiesProxy } from "./modules/entities"
import {
  createFunctionsModule,
  type FunctionsModule,
  type FunctionsModuleOptions,
} from "./modules/functions"
import { createFunctionsAdminModule, type FunctionsAdminModule } from "./modules/functionsAdmin"
import { createImportsModule, type ImportsModule } from "./modules/imports"
import { createIntegrationModule, type IntegrationModule } from "./modules/integration"
import {
  createIntegrationAdminModule,
  type IntegrationAdminModule,
} from "./modules/integrationAdmin"
import {
  createIntegrationResourcesModule,
  type IntegrationResourcesModule,
} from "./modules/integrationResources"
import {
  createIntegrationTemplatesModule,
  type IntegrationTemplatesModule,
} from "./modules/integrationTemplates"
import { createMembersModule, type MembersModule } from "./modules/members"
import { createMessengerModule, type MessengerModule } from "./modules/messenger"
import { createPublicFunctionsModule, type PublicFunctionsModule } from "./modules/publicFunctions"
import { createQueriesModule, type QueriesModule } from "./modules/queries"
import { createSchemaModule, type SchemaModule } from "./modules/schema"
import { createSqlModule, type SqlModule } from "./modules/sql"
import { createWorkflowsModule, type WorkflowsModule } from "./modules/workflows"
import type { Transport } from "./transport"

export interface SdkCoreTransports {
  auth: Transport
  dataManager: Transport
  functions: Transport
  integration: Transport
  /** Code Studio transport. App-scoped adapters must prevent callers from targeting another app. */
  codeStudio?: Transport
  /** Copilot transport for tasks, credentials, models, and app connections. */
  copilot?: Transport
  /** Messenger transport for current-user notifications. */
  messenger?: Transport
  /**
   * Anonymous Functions transport. It must not add Authorization or X-App-Id headers.
   * No fallback to the authenticated Functions transport is performed.
   */
  publicFunctions?: Transport
}

export interface SdkCoreOptions {
  transports: SdkCoreTransports
  /** Resolves the app fixed by the concrete client without inspecting tokens in core. */
  getAppId?: () => string | undefined
  functions?: FunctionsModuleOptions
  errors?: SdkCoreErrorFactory
}

export interface SdkCore {
  readonly agentConnections: AgentConnectionsModule
  readonly agentCredentials: AgentCredentialsModule
  readonly agents: AgentsModule
  readonly agentTasks: AgentTasksModule
  readonly apps: AppsModule
  readonly auth: AuthModule
  readonly context: ContextModule
  readonly customQueries: CustomQueriesModule
  readonly dataSources: DataSourcesModule
  readonly entities: EntitiesProxy
  readonly functions: FunctionsModule
  readonly functionsAdmin: FunctionsAdminModule
  readonly imports: ImportsModule
  readonly integration: IntegrationModule
  readonly integrationAdmin: IntegrationAdminModule
  readonly integrationResources: IntegrationResourcesModule
  readonly integrationTemplates: IntegrationTemplatesModule
  readonly members: MembersModule
  readonly messenger: MessengerModule
  readonly publicFunctions: PublicFunctionsModule
  readonly queries: QueriesModule
  readonly sql: SqlModule
  readonly schema: SchemaModule
  readonly workflows: WorkflowsModule
}

export function createSdkCore(options: SdkCoreOptions): SdkCore {
  const errors = options.errors ?? defaultSdkCoreErrorFactory
  const codeStudio = options.transports.codeStudio ?? unavailableTransport("codeStudio", errors)
  const copilot = options.transports.copilot ?? unavailableTransport("copilot", errors)
  const messengerTransport =
    options.transports.messenger ?? unavailableTransport("messenger", errors)
  const apps = createAppsModule(codeStudio, errors)
  const schema = createSchemaModule(options.transports.dataManager, errors)
  const functionsAdmin = createFunctionsAdminModule(options.transports.functions, errors)
  const agents = createAgentsModule(options.transports.functions, copilot, errors)
  const integrationAdmin = createIntegrationAdminModule(options.transports.integration, errors)
  const agentConnections = createAgentConnectionsModule(copilot, errors)
  const members = createMembersModule(options.transports.auth, errors)
  return {
    agentConnections,
    agentCredentials: createAgentCredentialsModule(copilot, errors),
    agents,
    agentTasks: createAgentTasksModule(copilot, errors),
    apps,
    auth: createAuthModule(options.transports.auth, errors),
    context: createContextModule(
      {
        apps,
        schema,
        functionsAdmin,
        agents,
        integrationAdmin,
        agentConnections,
        getAppId: options.getAppId,
      },
      errors,
    ),
    customQueries: createCustomQueriesModule(options.transports.dataManager, errors),
    dataSources: createDataSourcesModule(options.transports.dataManager, errors),
    entities: createEntitiesModule(options.transports.dataManager, errors),
    functions: createFunctionsModule(options.transports.functions, options.functions, errors),
    functionsAdmin,
    imports: createImportsModule(options.transports.dataManager, errors),
    integration: createIntegrationModule(options.transports.integration, errors),
    integrationAdmin,
    integrationResources: createIntegrationResourcesModule(options.transports.integration, errors),
    integrationTemplates: createIntegrationTemplatesModule(options.transports.integration, errors),
    members,
    messenger: createMessengerModule(messengerTransport, errors),
    publicFunctions: createPublicFunctionsModule(options.transports.publicFunctions, errors),
    queries: createQueriesModule(options.transports.dataManager, errors),
    sql: createSqlModule(options.transports.dataManager, errors),
    schema,
    workflows: createWorkflowsModule(options.transports.functions, errors),
  }
}

function unavailableTransport(name: string, errors: SdkCoreErrorFactory): Transport {
  return {
    request() {
      return Promise.reject(errors.configuration(`The ${name} transport is not configured`))
    },
  }
}
