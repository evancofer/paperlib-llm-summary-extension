import type { Provider } from "./settings";

export const KEY_MASK = "•••••• (stored in keychain)";

/**
 * Written in place of a deleted key. keytar throws on an empty password and Paperlib
 * exposes no way to delete one.
 */
const CLEARED = "plsum:cleared";

export interface PreferenceStore {
  get(id: string, key: string): unknown;
  set(id: string, patch: Record<string, unknown>): void;
  getPassword(id: string, key: string): Promise<string | null | undefined>;
  setPassword(id: string, key: string, value: string): Promise<void>;
}

const account = (provider: Provider) => `apiKey:${provider}`;

export class Secrets {
  constructor(
    private readonly store: PreferenceStore,
    private readonly id: string,
    private readonly warn: (message: string) => void
  ) {}

  async getKey(provider: Provider): Promise<string> {
    const value = await this.store.getPassword(this.id, account(provider));
    return !value || value === CLEARED ? "" : value;
  }

  private field(): string {
    return String(this.store.get(this.id, "apiKey") ?? "").trim();
  }

  /** Moves a key typed into the setting to the keychain. For use at startup. */
  async migrate(provider: Provider): Promise<void> {
    const value = this.field();
    if (value !== "" && value !== KEY_MASK) {
      await this.save(provider, value);
    } else {
      await this.showFor(provider);
    }
  }

  /** Handles the user changing the setting; a blank field deletes the stored key. */
  async onFieldChanged(provider: Provider): Promise<void> {
    const value = this.field();
    if (value === KEY_MASK) return;
    if (value !== "") {
      await this.save(provider, value);
    } else if ((await this.getKey(provider)) !== "") {
      await this.store.setPassword(this.id, account(provider), CLEARED);
    }
  }

  /** Makes the setting reflect whether this provider has a stored key. */
  async showFor(provider: Provider): Promise<void> {
    const shown = (await this.getKey(provider)) === "" ? "" : KEY_MASK;
    if (this.field() !== shown) {
      this.store.set(this.id, { apiKey: shown });
    }
  }

  private async save(provider: Provider, value: string): Promise<void> {
    await this.store.setPassword(this.id, account(provider), value);
    // Paperlib swallows keychain errors, so check before removing the only copy.
    if ((await this.getKey(provider)) !== value) {
      this.warn("Couldn't save the API key to the keychain. It stays in the settings file.");
      return;
    }
    this.store.set(this.id, { apiKey: KEY_MASK });
  }
}
