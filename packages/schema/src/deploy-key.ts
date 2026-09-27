export * as DeployKey from "./deploy-key"

import { Schema } from "effect"
import { AbsolutePath } from "./schema"

// GitHub 等平台要求同一个部署公钥全局只能绑定一个仓库，因此每个远端仓库各自持有一把密钥。
export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  /** 规范化的远端仓库标识，如 `github.com/owner/repo`，与传输协议无关。 */
  repository: Schema.String,
  algorithm: Schema.Literal("ssh-ed25519"),
  publicKey: Schema.String,
  publicKeyPath: AbsolutePath,
  privateKeyPath: AbsolutePath,
}).annotate({ identifier: "DeployKey.Info" })

export interface GetInput extends Schema.Schema.Type<typeof GetInput> {}
export const GetInput = Schema.Struct({
  repository: Schema.Trim.pipe(Schema.check(Schema.isNonEmpty())),
}).annotate({ identifier: "DeployKey.GetInput" })

export const ErrorReason = Schema.Literals(["invalid_repository", "unavailable"])
export type ErrorReason = typeof ErrorReason.Type
