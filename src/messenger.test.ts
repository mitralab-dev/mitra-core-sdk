import { describe, expect, it } from "vitest"
import {
  SdkCoreConfigurationError,
  SdkCoreResponseError,
  createMessengerModule,
  createSdkCore,
} from "./index"
import type {
  EmailTemplateInput,
  EmailTemplateType,
  SendEmailInput,
  Transport,
  TransportRequestOptions,
} from "./index"

interface CapturedRequest {
  path: string
  options: TransportRequestOptions
}

class QueueTransport implements Transport {
  readonly requests: CapturedRequest[] = []

  constructor(private readonly responses: unknown[] = []) {}

  async request<T>(path: string, options: TransportRequestOptions = {}): Promise<T> {
    this.requests.push({ path, options })
    if (this.responses.length === 0) throw new Error("No response configured")
    const response = this.responses.shift()
    if (response instanceof Error) throw response
    return response as T
  }
}

describe("messenger.sendEmail", () => {
  it("sends a RAW email with every field and no sender or app", async () => {
    const transport = new QueueTransport([{ messageId: "message-1" }])

    await expect(
      createMessengerModule(transport).sendEmail({
        to: ["ana@example.com", "bia@example.com"],
        cc: ["carla@example.com"],
        bcc: ["dani@example.com"],
        replyTo: "support@example.com",
        subject: "Welcome",
        html: "<p>Hi</p>",
        text: "Hi",
      }),
    ).resolves.toEqual({ messageId: "message-1" })

    expect(transport.requests).toStrictEqual([
      {
        path: "/api/v1/messages/send",
        options: {
          method: "POST",
          body: {
            channel: "EMAIL",
            payload: {
              type: "RAW",
              to: ["ana@example.com", "bia@example.com"],
              cc: ["carla@example.com"],
              bcc: ["dani@example.com"],
              replyTo: "support@example.com",
              subject: "Welcome",
              html: "<p>Hi</p>",
              text: "Hi",
            },
          },
        },
      },
    ])
  })

  it("omits absent optional fields and drops the from and appId an untyped caller passes", async () => {
    const transport = new QueueTransport([{ messageId: "message-1" }])

    await createMessengerModule(transport).sendEmail({
      to: ["ana@example.com"],
      subject: "Welcome",
      html: "<p>Hi</p>",
      from: "spoof@example.com",
      appId: "11111111-1111-1111-1111-111111111111",
    } as SendEmailInput)

    expect(transport.requests[0]?.options.body).toStrictEqual({
      channel: "EMAIL",
      payload: {
        type: "RAW",
        to: ["ana@example.com"],
        subject: "Welcome",
        html: "<p>Hi</p>",
      },
    })
  })

  it("rejects an accepted response without a messageId", async () => {
    const messenger = createMessengerModule(new QueueTransport([{}]))

    await expect(
      messenger.sendEmail({ to: ["ana@example.com"], subject: "Welcome", html: "<p>Hi</p>" }),
    ).rejects.toBeInstanceOf(SdkCoreResponseError)
  })
})

const appId = "11111111-1111-1111-1111-111111111111"

const appTemplate = {
  id: "template-1",
  type: "SIGN_IN",
  senderIdentityId: null,
  subject: "Entre no $app.name",
  htmlBody: "<p>$code</p>",
  textBody: null,
  platformDefault: false,
  createdAt: "2026-10-26T10:00:00Z",
  updatedAt: "2026-10-26T10:05:00Z",
}

const renderedPreview = {
  subject: "Entre no Loja X",
  htmlBody: "<p>123456</p>",
  textBody: null,
}

function messengerFor(transport: Transport) {
  return createMessengerModule(transport, undefined, () => appId)
}

describe("messenger email templates", () => {
  it("lists every row of the current app, a type outside the app types included", async () => {
    const platformRow = { ...appTemplate, id: "template-0", platformDefault: true }
    const consoleOnlyRow = { ...appTemplate, id: "template-2", type: "PASSWORD_RECOVERY" }
    const transport = new QueueTransport([[appTemplate, platformRow, consoleOnlyRow]])

    await expect(messengerFor(transport).listEmailTemplates()).resolves.toEqual([
      appTemplate,
      platformRow,
      consoleOnlyRow,
    ])
    expect(transport.requests).toStrictEqual([
      { path: "/api/v1/email/templates", options: { method: "GET", params: { appId } } },
    ])
  })

  it("gets the type catalog without an app", async () => {
    const catalog = {
      type: "SSO_GUIDANCE",
      variables: [
        { name: "code", required: true, description: "Codigo", preview: "123456" },
        { name: "logo.url", required: false, description: null, preview: null },
      ],
    }
    const transport = new QueueTransport([catalog])

    await expect(
      createMessengerModule(transport).getEmailTemplateType("SSO_GUIDANCE"),
    ).resolves.toEqual(catalog)
    expect(transport.requests).toStrictEqual([
      { path: "/api/v1/email/template-types/SSO_GUIDANCE", options: { method: "GET" } },
    ])
  })

  it("gets one template of the current app", async () => {
    const transport = new QueueTransport([appTemplate])

    await expect(messengerFor(transport).getEmailTemplate("SIGN_IN")).resolves.toEqual(appTemplate)
    expect(transport.requests).toStrictEqual([
      { path: "/api/v1/email/templates/SIGN_IN", options: { method: "GET", params: { appId } } },
    ])
  })

  it("saves the whole template for the current app and returns its preview", async () => {
    const transport = new QueueTransport([appTemplate, renderedPreview])

    await expect(
      messengerFor(transport).upsertEmailTemplate("APP_USER_INVITED", {
        subject: "Convite",
        htmlBody: "<p>$app.name</p>",
        textBody: "$app.name",
      }),
    ).resolves.toStrictEqual({ template: appTemplate, preview: renderedPreview })
    expect(transport.requests).toStrictEqual([
      {
        path: "/api/v1/email/templates/APP_USER_INVITED",
        options: {
          method: "PUT",
          body: {
            appId,
            subject: "Convite",
            htmlBody: "<p>$app.name</p>",
            textBody: "$app.name",
          },
        },
      },
      {
        path: "/api/v1/email/templates/APP_USER_INVITED/preview",
        options: { method: "GET", params: { appId } },
      },
    ])
  })

  it("leaves textBody out when absent and drops the appId and sender an untyped caller passes", async () => {
    const transport = new QueueTransport([appTemplate, renderedPreview])

    await messengerFor(transport).upsertEmailTemplate("SIGN_IN", {
      subject: "Entre",
      htmlBody: "<p>$code</p>",
      appId: "22222222-2222-2222-2222-222222222222",
      senderIdentityId: "33333333-3333-3333-3333-333333333333",
    } as EmailTemplateInput)

    expect(transport.requests[0]?.options.body).toStrictEqual({
      appId,
      subject: "Entre",
      htmlBody: "<p>$code</p>",
    })
  })

  it("keeps the saved template when only the preview fails", async () => {
    const previewFailure = Object.assign(new Error("Messenger unavailable"), { status: 503 })
    const transport = new QueueTransport([appTemplate, previewFailure])

    await expect(
      messengerFor(transport).upsertEmailTemplate("SIGN_IN", { subject: "s", htmlBody: "h" }),
    ).resolves.toStrictEqual({ template: appTemplate, preview: null, previewError: previewFailure })
  })

  it("rejects without a preview when the save fails, with the Messenger error_code", async () => {
    const missingVariable = Object.assign(new Error("Template SIGN_IN is missing $code"), {
      status: 400,
      code: "TEMPLATE_MISSING_VARIABLE",
    })
    const transport = new QueueTransport([missingVariable])

    await expect(
      messengerFor(transport).upsertEmailTemplate("SIGN_IN", { subject: "s", htmlBody: "h" }),
    ).rejects.toBe(missingVariable)
    expect(transport.requests).toHaveLength(1)
  })

  it("previews the template the current app sends", async () => {
    const transport = new QueueTransport([renderedPreview])

    await expect(messengerFor(transport).previewEmailTemplate("SIGN_IN")).resolves.toEqual(
      renderedPreview,
    )
    expect(transport.requests).toStrictEqual([
      {
        path: "/api/v1/email/templates/SIGN_IN/preview",
        options: { method: "GET", params: { appId } },
      },
    ])
  })

  it("deletes the app version on a 204", async () => {
    const transport = new QueueTransport([undefined])

    await expect(
      messengerFor(transport).deleteEmailTemplate("APP_ACCESS_REQUIRED"),
    ).resolves.toBeUndefined()
    expect(transport.requests).toStrictEqual([
      {
        path: "/api/v1/email/templates/APP_ACCESS_REQUIRED",
        options: { method: "DELETE", params: { appId } },
      },
    ])
  })

  it("refuses app-scoped calls before any request when no app is fixed", async () => {
    const transport = new QueueTransport()
    const messenger = createMessengerModule(transport)

    await expect(messenger.listEmailTemplates()).rejects.toBeInstanceOf(SdkCoreConfigurationError)
    await expect(messenger.getEmailTemplate("SIGN_IN")).rejects.toBeInstanceOf(
      SdkCoreConfigurationError,
    )
    await expect(
      messenger.upsertEmailTemplate("SIGN_IN", { subject: "s", htmlBody: "h" }),
    ).rejects.toBeInstanceOf(SdkCoreConfigurationError)
    await expect(messenger.previewEmailTemplate("SIGN_IN")).rejects.toBeInstanceOf(
      SdkCoreConfigurationError,
    )
    await expect(messenger.deleteEmailTemplate("SIGN_IN")).rejects.toBeInstanceOf(
      SdkCoreConfigurationError,
    )
    expect(transport.requests).toHaveLength(0)
  })

  it("takes the app from the Core getAppId", async () => {
    const transport = new QueueTransport([[]])
    const unused = new QueueTransport()
    const core = createSdkCore({
      transports: {
        auth: unused,
        dataManager: unused,
        functions: unused,
        integration: unused,
        messenger: transport,
      },
      getAppId: () => appId,
    })

    await core.messenger.listEmailTemplates()

    expect(transport.requests[0]?.options.params).toStrictEqual({ appId })
  })

  it("refuses a dot segment as the type before any request", async () => {
    const transport = new QueueTransport()

    await expect(
      messengerFor(transport).getEmailTemplate(".." as EmailTemplateType),
    ).rejects.toBeInstanceOf(SdkCoreConfigurationError)
    expect(transport.requests).toHaveLength(0)
  })

  it.each([
    ["an empty type", { ...appTemplate, type: "" }],
    ["a missing platformDefault", { ...appTemplate, platformDefault: undefined }],
    ["a numeric textBody", { ...appTemplate, textBody: 1 }],
  ])("rejects a template with %s", async (_case, template) => {
    await expect(
      messengerFor(new QueueTransport([template])).getEmailTemplate("SIGN_IN"),
    ).rejects.toBeInstanceOf(SdkCoreResponseError)
  })

  it("rejects a catalog variable without the required flag", async () => {
    const catalog = { type: "SIGN_IN", variables: [{ name: "code", description: null }] }

    await expect(
      createMessengerModule(new QueueTransport([catalog])).getEmailTemplateType("SIGN_IN"),
    ).rejects.toBeInstanceOf(SdkCoreResponseError)
  })
})
