import { configurationError, defaultSdkCoreErrorFactory, type SdkCoreErrorFactory } from "../errors"
import { encodePathSegment } from "../path"
import {
  expectEmailTemplate,
  expectEmailTemplatePreview,
  expectEmailTemplateTypeCatalog,
  expectEmpty,
  expectMessageAccepted,
  expectObjectArray,
} from "../response"
import type { Transport } from "../transport"
import type {
  EmailTemplate,
  EmailTemplateInput,
  EmailTemplatePreview,
  EmailTemplateType,
  EmailTemplateTypeCatalog,
  EmailTemplateUpsertResult,
  MessageAccepted,
  SendEmailInput,
} from "../types"

export interface MessengerModule {
  /** Sends plain text to the authenticated user; channel rendering may support markdown. */
  notify(content: string): Promise<MessageAccepted>
  /** Sends an email from the app's sender; only the app's backend token may send. */
  sendEmail(input: SendEmailInput): Promise<MessageAccepted>
  /**
   * Lists the current app's email templates: the platform row (`platformDefault: true`) of every
   * type and, beside it, the app's row for each type the app has rewritten.
   */
  listEmailTemplates(): Promise<EmailTemplate[]>
  /** Gets the variables a type accepts, referenced as `$name` in the subject and HTML body. */
  getEmailTemplateType(type: EmailTemplateType): Promise<EmailTemplateTypeCatalog>
  /** Gets the current app's version of a template, or the platform text when it has none. */
  getEmailTemplate(type: EmailTemplateType): Promise<EmailTemplate>
  /**
   * Replaces the current app's version of a template and renders its preview. Every required
   * variable must appear in the subject or the HTML body.
   */
  upsertEmailTemplate(
    type: EmailTemplateType,
    input: EmailTemplateInput,
  ): Promise<EmailTemplateUpsertResult>
  /** Renders the template the current app sends for a type with the preview values. */
  previewEmailTemplate(type: EmailTemplateType): Promise<EmailTemplatePreview>
  /** Deletes the current app's version of a template, so the platform text applies again. */
  deleteEmailTemplate(type: EmailTemplateType): Promise<void>
}

export function createMessengerModule(
  transport: Transport,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
  getAppId?: () => string | undefined,
): MessengerModule {
  const templatePath = (type: EmailTemplateType) =>
    `/api/v1/email/templates/${encodePathSegment(type, "email template type", errors)}`
  const currentAppId = (): string => {
    const appId = getAppId?.()
    if (!appId) configurationError("An appId is required for email templates", errors)
    return appId
  }
  const preview = async (type: EmailTemplateType, appId: string) =>
    expectEmailTemplatePreview(
      await transport.request<unknown>(`${templatePath(type)}/preview`, {
        method: "GET",
        params: { appId },
      }),
      "Email template preview response",
      errors,
    )
  return {
    async notify(content) {
      return expectMessageAccepted(
        await transport.request<unknown>("/api/v1/messages/notify", {
          method: "POST",
          body: { content },
        }),
        "Notify user response",
        errors,
      )
    },
    async sendEmail(input) {
      return expectMessageAccepted(
        await transport.request<unknown>("/api/v1/messages/send", {
          method: "POST",
          body: { channel: "EMAIL", payload: rawEmailPayload(input) },
        }),
        "Send email response",
        errors,
      )
    },
    async listEmailTemplates() {
      return expectObjectArray(
        await transport.request<unknown>("/api/v1/email/templates", {
          method: "GET",
          params: { appId: currentAppId() },
        }),
        "Email template list response",
        errors,
        expectEmailTemplate,
      )
    },
    async getEmailTemplateType(type) {
      return expectEmailTemplateTypeCatalog(
        await transport.request<unknown>(
          `/api/v1/email/template-types/${encodePathSegment(type, "email template type", errors)}`,
          { method: "GET" },
        ),
        "Email template type response",
        errors,
      )
    },
    async getEmailTemplate(type) {
      return expectEmailTemplate(
        await transport.request<unknown>(templatePath(type), {
          method: "GET",
          params: { appId: currentAppId() },
        }),
        "Email template response",
        errors,
      )
    },
    async upsertEmailTemplate(type, input) {
      const appId = currentAppId()
      const template = expectEmailTemplate(
        await transport.request<unknown>(templatePath(type), {
          method: "PUT",
          body: templateBody(appId, input),
        }),
        "Upsert email template response",
        errors,
      )
      // The save is done, so a preview failure must not reject: the caller would retry a write
      // that already happened.
      try {
        return { template, preview: await preview(type, appId) }
      } catch (previewError) {
        return { template, preview: null, previewError }
      }
    },
    async previewEmailTemplate(type) {
      return preview(type, currentAppId())
    },
    async deleteEmailTemplate(type) {
      expectEmpty(
        await transport.request<unknown>(templatePath(type), {
          method: "DELETE",
          params: { appId: currentAppId() },
        }),
        "Delete email template response",
        errors,
      )
    },
  }
}

// Field by field on purpose: a `from` from an untyped caller must not reach the Messenger.
function rawEmailPayload(input: SendEmailInput): Record<string, unknown> {
  return {
    type: "RAW",
    to: input.to,
    ...(input.cc === undefined ? {} : { cc: input.cc }),
    ...(input.bcc === undefined ? {} : { bcc: input.bcc }),
    ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
    subject: input.subject,
    html: input.html,
    ...(input.text === undefined ? {} : { text: input.text }),
  }
}

// Field by field for the same reason: an untyped `appId` or `senderIdentityId` must not reach it.
function templateBody(appId: string, input: EmailTemplateInput): Record<string, unknown> {
  return {
    appId,
    subject: input.subject,
    htmlBody: input.htmlBody,
    ...(input.textBody === undefined ? {} : { textBody: input.textBody }),
  }
}
