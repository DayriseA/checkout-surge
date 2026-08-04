import type { BackendRead } from "../backend-read";

export type AdminNotice =
  | string
  | {
      kind: "failure";
      read: BackendRead<unknown>;
    };

export function adminFailureNotice(read: BackendRead<unknown>): AdminNotice {
  return { kind: "failure", read };
}
