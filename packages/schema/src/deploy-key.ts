export * as DeployKey from "./deploy-key"

import { Schema } from "effect"
import { AbsolutePath } from "./schema"

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  algorithm: Schema.Literal("ssh-ed25519"),
  publicKey: Schema.String,
  publicKeyPath: AbsolutePath,
  privateKeyPath: AbsolutePath,
}).annotate({ identifier: "DeployKey.Info" })
