import { configurationError, defaultSdkCoreErrorFactory, type SdkCoreErrorFactory } from "../errors"
import type { AgentConnectionsModule } from "./agentConnections"
import type { AgentsModule } from "./agents"
import type { AppsModule } from "./apps"
import type { FunctionsAdminModule } from "./functionsAdmin"
import type { IntegrationAdminModule } from "./integrationAdmin"
import type { MembersModule } from "./members"
import type { SchemaModule } from "./schema"
import type { AppContext } from "../types"

const SUMMARY_PAGE_SIZE = 2000

export interface ContextModule {
  /**
   * Reads safe authoring context sequentially and fails on the first unavailable capability.
   *
   * Function code, file contents, integration secrets, and connection credentials are excluded.
   * Summary lists are capped at 2000 and report total and truncation metadata.
   */
  getAppContext(appId?: string): Promise<AppContext>
}

export interface ContextModuleDependencies {
  apps: AppsModule
  schema: SchemaModule
  functionsAdmin: FunctionsAdminModule
  agents: AgentsModule
  integrationAdmin: IntegrationAdminModule
  agentConnections: AgentConnectionsModule
  members: MembersModule
  getAppId?: (() => string | undefined) | undefined
}

export function createContextModule(
  dependencies: ContextModuleDependencies,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): ContextModule {
  return {
    async getAppContext(requestedAppId) {
      const appId = requestedAppId ?? dependencies.getAppId?.()
      if (!appId) {
        configurationError("An appId is required for app context", errors)
      }

      const app = await dependencies.apps.get(appId)
      const tables = await dependencies.schema.listTables({ scope: "APP", includeColumns: true })
      const functionsPage = await dependencies.functionsAdmin.list({
        page: 0,
        size: SUMMARY_PAGE_SIZE,
        sort: "name",
      })
      const agentsPage = await dependencies.agents.list({
        page: 0,
        size: SUMMARY_PAGE_SIZE,
        sort: "name",
      })
      const fileResponse = await dependencies.apps.getFiles(appId)
      const integrationsPage = await dependencies.integrationAdmin.list({
        page: 0,
        size: SUMMARY_PAGE_SIZE,
        sort: "alias",
      })
      const connections = await dependencies.agentConnections.list()
      const users = await dependencies.members.list()

      return {
        appId,
        app,
        tables,
        functions: functionsPage.content,
        functionsTotal: functionsPage.totalElements,
        functionsTruncated: functionsPage.content.length < functionsPage.totalElements,
        agents: agentsPage.content,
        agentsTotal: agentsPage.totalElements,
        agentsTruncated: agentsPage.content.length < agentsPage.totalElements,
        files: Object.keys(fileResponse.files).sort(),
        integrations: integrationsPage.content,
        integrationsTotal: integrationsPage.totalElements,
        integrationsTruncated: integrationsPage.content.length < integrationsPage.totalElements,
        connections,
        users,
      }
    },
  }
}
