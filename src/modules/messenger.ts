import { defaultSdkCoreErrorFactory, type SdkCoreErrorFactory } from "../errors"
import { expectMessageAccepted } from "../response"
import type { Transport } from "../transport"
import type { MessageAccepted } from "../types"

export interface MessengerModule {
  /** Sends plain text to the authenticated user; channel rendering may support markdown. */
  notify(content: string): Promise<MessageAccepted>
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
  }
}
