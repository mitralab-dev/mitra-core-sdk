import { defaultSdkCoreErrorFactory, type SdkCoreErrorFactory } from "../errors"
import { expectMessageAccepted } from "../response"
import type { Transport } from "../transport"
import type { MessageAccepted, SendEmailInput } from "../types"

export interface MessengerModule {
  /** Sends plain text to the authenticated user; channel rendering may support markdown. */
  notify(content: string): Promise<MessageAccepted>
  /** Sends an email from the app's sender; only the app's backend token may send. */
  sendEmail(input: SendEmailInput): Promise<MessageAccepted>
}

export function createMessengerModule(
  transport: Transport,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): MessengerModule {
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
