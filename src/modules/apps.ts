import { defaultSdkCoreErrorFactory, type SdkCoreErrorFactory } from "../errors"
import { encodePathSegment } from "../path"
import {
  expectAppDefinition,
  expectAppDeploy,
  expectAppSummary,
  expectAppVersion,
  expectEmpty,
  expectObject,
  expectPage,
} from "../response"
import type { QueryParamValue, Transport } from "../transport"
import type {
  AppCreateInput,
  AppDefinition,
  AppDeploy,
  AppFiles,
  AppGetOptions,
  AppListOptions,
  AppPublishOptions,
  AppSummary,
  AppUpdateInput,
  AppVersion,
  Page,
  PageOptions,
} from "../types"

export interface AppsModule {
  /** Lists tenant apps. App-scoped tokens cannot call this collection operation. */
  list(options?: AppListOptions): Promise<Page<AppSummary>>
  /** Gets one app, optionally selecting its DRAFT or PUBLISHED version. */
  get(appId: string, options?: AppGetOptions): Promise<AppDefinition>
  /** Creates an app with an initial DRAFT version. App-scoped tokens cannot call this method. */
  create(input: AppCreateInput): Promise<AppDefinition>
  /** Permanently deletes an app, every version, and every deployed artifact. */
  delete(appId: string): Promise<void>
  /** Patches app metadata. Omitted fields are preserved. */
  update(appId: string, input: AppUpdateInput): Promise<AppDefinition>
  /** Gets the complete file map for the current app version. */
  getFiles(appId: string): Promise<AppFiles>
  /** Replaces the complete DRAFT file map. Files omitted from the input are deleted. */
  replaceFiles(appId: string, files: Record<string, string>): Promise<AppFiles>
  /** Merges DRAFT files. Null deletes one path; omitted paths are preserved. */
  mergeFiles(appId: string, files: Record<string, string | null>): Promise<AppFiles>
  /** Starts an asynchronous preview build from a snapshot of the current DRAFT. */
  build(appId: string): Promise<AppDeploy>
  /** Starts an asynchronous build and publishes only after its successful callback. */
  publish(appId: string, options?: AppPublishOptions): Promise<AppDefinition>
  /** Gets a deploy by id. Prefer this stable id for polling. */
  getDeploy(appId: string, deployId: string): Promise<AppDeploy>
  /** Gets the deploy currently referenced by the app version, or null. */
  getCurrentDeploy(appId: string): Promise<AppDeploy | null>
  /** Logically cancels a BUILDING deploy. Late callbacks cannot publish it. */
  cancelBuild(appId: string, deployId: string): Promise<AppDeploy>
  /** Instantly points the app at a previous DEPLOYED version without rebuilding. */
  rollback(appId: string, targetVersionId: string): Promise<AppDefinition>
  /** Lists deploy history. Defaults to page 0, size 20, and `createdAt,desc`; maximum size is 100. */
  listDeploys(appId: string, options?: PageOptions): Promise<Page<AppDeploy>>
  /** Lists immutable versions. Defaults to page 0, size 20, and `createdAt,desc`; maximum size is 100. */
  listVersions(appId: string, options?: PageOptions): Promise<Page<AppVersion>>
}

export function createAppsModule(
  transport: Transport,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): AppsModule {
  const appPath = (appId: string) => `/api/v1/apps/${encodePathSegment(appId, "app id", errors)}`
  const params = (
    options: PageOptions = {},
    defaultSort?: string,
  ): Record<string, QueryParamValue> => ({
    page: options.page,
    size: options.size,
    sort: options.sort ?? defaultSort,
  })
  return {
    async list(options = {}) {
      return expectPage<AppSummary>(
        await transport.request<unknown>("/api/v1/apps", {
          method: "GET",
          params: {
            ...params(options, "createdAt,desc"),
            search: options.search,
            version: options.version,
            brand: options.brand,
          },
        }),
        "App page response",
        errors,
        expectAppSummary,
      )
    },
    async get(appId, options = {}) {
      return expectAppDefinition(
        await transport.request<unknown>(appPath(appId), {
          method: "GET",
          params: { version: options.version },
        }),
        "App response",
        errors,
      )
    },
    async create(input) {
      return expectAppDefinition(
        await transport.request<unknown>("/api/v1/apps", { method: "POST", body: input }),
        "Create app response",
        errors,
      )
    },
    async delete(appId) {
      expectEmpty(
        await transport.request<unknown>(appPath(appId), { method: "DELETE" }),
        "Delete app response",
        errors,
      )
    },
    async update(appId, input) {
      return expectAppDefinition(
        await transport.request<unknown>(appPath(appId), { method: "PATCH", body: input }),
        "Update app response",
        errors,
      )
    },
    async getFiles(appId) {
      return expectFiles(
        await transport.request<unknown>(`${appPath(appId)}/files`, { method: "GET" }),
        errors,
      )
    },
    async replaceFiles(appId, files) {
      return expectFiles(
        await transport.request<unknown>(`${appPath(appId)}/files`, {
          method: "PUT",
          body: { files },
        }),
        errors,
      )
    },
    async mergeFiles(appId, files) {
      return expectFiles(
        await transport.request<unknown>(`${appPath(appId)}/files`, {
          method: "PATCH",
          body: { files },
        }),
        errors,
      )
    },
    async build(appId) {
      return expectAppDeploy(
        await transport.request<unknown>(`${appPath(appId)}/build`, { method: "POST" }),
        "Build app deploy response",
        errors,
      )
    },
    async publish(appId, options = {}) {
      return expectAppDefinition(
        await transport.request<unknown>(`${appPath(appId)}/publish`, {
          method: "POST",
          body: options.externalAccess === undefined ? undefined : options,
        }),
        "Publish app response",
        errors,
      )
    },
    async getDeploy(appId, deployId) {
      return expectAppDeploy(
        await transport.request<unknown>(
          `${appPath(appId)}/deploys/${encodePathSegment(deployId, "deploy id", errors)}`,
          { method: "GET" },
        ),
        "App deploy response",
        errors,
      )
    },
    async getCurrentDeploy(appId) {
      const response = await transport.request<unknown>(`${appPath(appId)}/deploys/current`, {
        method: "GET",
      })
      return response === null
        ? null
        : expectAppDeploy(response, "Current app deploy response", errors)
    },
    async cancelBuild(appId, deployId) {
      return expectAppDeploy(
        await transport.request<unknown>(
          `${appPath(appId)}/deploys/${encodePathSegment(deployId, "deploy id", errors)}/cancel`,
          { method: "POST" },
        ),
        "Cancel app build response",
        errors,
      )
    },
    async rollback(appId, targetVersionId) {
      return expectAppDefinition(
        await transport.request<unknown>(`${appPath(appId)}/rollback`, {
          method: "POST",
          body: { targetVersionId },
        }),
        "Rollback app response",
        errors,
      )
    },
    async listDeploys(appId, options = {}) {
      return expectPage<AppDeploy>(
        await transport.request<unknown>(`${appPath(appId)}/deploys`, {
          method: "GET",
          params: params(options, "createdAt,desc"),
        }),
        "App deploy page response",
        errors,
        expectAppDeploy,
      )
    },
    async listVersions(appId, options = {}) {
      return expectPage<AppVersion>(
        await transport.request<unknown>(`${appPath(appId)}/versions`, {
          method: "GET",
          params: params(options, "createdAt,desc"),
        }),
        "App version page response",
        errors,
        expectAppVersion,
      )
    },
  }
}

function expectFiles(value: unknown, errors: SdkCoreErrorFactory): AppFiles {
  const response = expectObject<AppFiles>(value, "App files response", errors)
  if (
    response.files === null ||
    typeof response.files !== "object" ||
    Array.isArray(response.files) ||
    Object.values(response.files).some((content) => typeof content !== "string")
  ) {
    throw errors.invalidResponse("App files response has an invalid files field")
  }
  return response
}
