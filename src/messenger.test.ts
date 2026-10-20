import { describe, expect, it } from "vitest"
import { SdkCoreResponseError, createMessengerModule } from "./index"
import type { SendEmailInput, Transport, TransportRequestOptions } from "./index"

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

  it("omits absent optional fields and drops a from that an untyped caller passes", async () => {
    const transport = new QueueTransport([{ messageId: "message-1" }])

    await createMessengerModule(transport).sendEmail({
      to: ["ana@example.com"],
      subject: "Welcome",
      html: "<p>Hi</p>",
      from: "spoof@example.com",
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
