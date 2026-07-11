import { hash, verify } from "@node-rs/argon2";
import { Pbkdf2PasswordHasher } from "@onelight/core";

export class NodePasswordHasher extends Pbkdf2PasswordHasher {
  override async hash(plain: string): Promise<string> {
    return hash(plain, {
      algorithm: 2,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
      outputLen: 32,
    });
  }

  override async verify(plain: string, stored: string): Promise<boolean> {
    if (stored.startsWith("$pbkdf2-sha256$"))
      return super.verify(plain, stored);
    if (!stored.startsWith("$argon2")) return false;
    return verify(stored, plain);
  }
}
