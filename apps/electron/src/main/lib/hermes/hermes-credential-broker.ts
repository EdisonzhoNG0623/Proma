import {
  hermesCredentialStore,
  type HermesCredentialSlot,
  type HermesCredentialStore,
} from './hermes-credential-store'

export const HERMES_CREDENTIAL_SLOTS: readonly HermesCredentialSlot[] = [
  'dashboard-token',
  'dashboard-password',
  'api-server-key',
  'ssh-password',
  'ssh-private-key',
  'ssh-private-key-passphrase',
]

export type HermesCredentialState = Partial<Record<HermesCredentialSlot, boolean>>

/**
 * Main-only target ownership boundary. Renderer may name a target + fixed slot, but never
 * chooses, receives, or deletes a credential ref.
 */
export class HermesCredentialBroker {
  constructor(private readonly store: HermesCredentialStore = hermesCredentialStore) {}

  setSecret(targetId: string, slot: HermesCredentialSlot, secret: string): void {
    this.assertSlot(slot)
    this.store.setOwnedCredential(targetId, slot, secret)
  }

  getSecret(targetId: string, slot: HermesCredentialSlot): string | null {
    this.assertSlot(slot)
    return this.store.getOwnedCredential(targetId, slot)
  }

  clearSecret(targetId: string, slot: HermesCredentialSlot): boolean {
    this.assertSlot(slot)
    return this.store.clearOwnedCredential(targetId, slot)
  }

  clearTarget(targetId: string): number {
    return this.store.clearTargetCredentials(targetId)
  }

  claimLegacyRef(targetId: string, slot: HermesCredentialSlot, ref: string): boolean {
    this.assertSlot(slot)
    return this.store.claimLegacyCredential(targetId, slot, ref)
  }

  credentialState(targetId: string): HermesCredentialState {
    const state: HermesCredentialState = {}
    for (const slot of HERMES_CREDENTIAL_SLOTS) {
      if (this.store.hasOwnedCredential(targetId, slot)) state[slot] = true
    }
    return state
  }

  private assertSlot(slot: HermesCredentialSlot): void {
    if (!HERMES_CREDENTIAL_SLOTS.includes(slot)) throw new Error('Hermes credential slot 无效')
  }
}

export const hermesCredentialBroker = new HermesCredentialBroker()
