import { monotonicFactory } from "ulidx";

export interface IdGen {
  ulid(): string;
}

export class UlidGenerator implements IdGen {
  private readonly factory = monotonicFactory();

  ulid(): string {
    return this.factory();
  }
}
