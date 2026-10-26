import { configurationError, defaultSdkCoreErrorFactory, type SdkCoreErrorFactory } from "../errors"
import { encodePathSegment } from "../path"
import {
  expectEmailSender,
  expectEmailSettings,
  expectEmailTemplate,
  expectEmailTemplatePreview,
  expectEmailTemplateTypeCatalog,
  expectEmpty,
  expectMessageAccepted,
  expectObjectArray,
} from "../response"
import type { Transport } from "../transport"
import type {
  EmailSender,
  EmailSenderInput,
  EmailSettings,
  EmailSettingsInput,
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
  /**
   * Renders the app's saved template, or the platform one, with the catalog's sample values. It
   * does not prove which HTML goes out: the sender and the brand policy decide that at send time.
   */
  previewEmailTemplate(type: EmailTemplateType): Promise<EmailTemplatePreview>
  /** Deletes the current app's version of a template, so the platform text applies again. */
  deleteEmailTemplate(type: EmailTemplateType): Promise<void>
  /** Lists the addresses available as senders in the workspace of the token. */
  listEmailSenders(): Promise<EmailSender[]>
  /**
   * Registers an address in the name of the person in the token and makes it available in the
   * app's workspace. An address the person already owns comes back as saved, made available too.
   * Messenger mails a verification link and a 6-digit code to the address.
   */
  registerEmailSender(input: EmailSenderInput): Promise<EmailSender>
  /**
   * Mails the AWS link again while AWS has not verified the address, and a new code only while
   * the person has not confirmed one yet.
   */
  resendEmailSenderVerification(senderId: string): Promise<EmailSender>
  /** Confirms the 6-digit code the person read in the mailbox of the address. */
  confirmEmailSender(senderId: string, code: string): Promise<EmailSender>
  /** Gets the current app's sender settings and the From its emails use now. */
  getEmailSettings(): Promise<EmailSettings>
  /** Replaces the current app's sender settings; a field left out is cleared. */
  updateEmailSettings(input: EmailSettingsInput): Promise<EmailSettings>
}

export function createMessengerModule(
  transport: Transport,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
  getAppId?: () => string | undefined,
): MessengerModule {
  const templatePath = (type: EmailTemplateType) =>
    `/api/v1/email/templates/${encodePathSegment(type, "email template type", errors)}`
  const senderPath = (senderId: string) =>
    `/api/v1/email/identities/${encodePathSegment(senderId, "email sender id", errors)}`
  const currentAppId = (): string => {
    const appId = getAppId?.()
    if (!appId) configurationError("An appId is required for app email calls", errors)
    return appId
  }
  const settingsPath = () =>
    `/api/v1/email/apps/${encodePathSegment(currentAppId(), "app id", errors)}/settings`
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
    async listEmailSenders() {
      return expectObjectArray(
        await transport.request<unknown>("/api/v1/email/identities/workspace", { method: "GET" }),
        "Email sender list response",
        errors,
        expectEmailSender,
      )
    },
    async registerEmailSender(input) {
      return expectEmailSender(
        await transport.request<unknown>("/api/v1/email/identities", {
          method: "POST",
          body: { email: input.email, displayName: input.displayName },
        }),
        "Register email sender response",
        errors,
      )
    },
    async resendEmailSenderVerification(senderId) {
      return expectEmailSender(
        await transport.request<unknown>(`${senderPath(senderId)}/resend-verification`, {
          method: "POST",
        }),
        "Resend email sender verification response",
        errors,
      )
    },
    async confirmEmailSender(senderId, code) {
      return expectEmailSender(
        await transport.request<unknown>(`${senderPath(senderId)}/confirm`, {
          method: "POST",
          body: { code },
        }),
        "Confirm email sender response",
        errors,
      )
    },
    async getEmailSettings() {
      return expectEmailSettings(
        await transport.request<unknown>(settingsPath(), { method: "GET" }),
        "Email settings response",
        errors,
      )
    },
    async updateEmailSettings(input) {
      return expectEmailSettings(
        await transport.request<unknown>(settingsPath(), {
          method: "PUT",
          body: settingsBody(input),
        }),
        "Update email settings response",
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

function settingsBody(input: EmailSettingsInput): Record<string, unknown> {
  return {
    ...(input.senderIdentityId === undefined ? {} : { senderIdentityId: input.senderIdentityId }),
    ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
    ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
  }
}
