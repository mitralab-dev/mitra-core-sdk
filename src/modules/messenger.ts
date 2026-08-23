import { defaultSdkCoreErrorFactory, type SdkCoreErrorFactory } from "../errors"
import { expectEmpty } from "../response"
import type { Transport } from "../transport"

export interface MessengerModule {
  /** Sends plain text to the authenticated user; channel rendering may support markdown. */
  notify(content: string): Promise<void>
}

export function createMessengerModule(
  transport: Transport,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): MessengerModule {
  return {
    async notify(content) {
      expectEmpty(
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
