export * as ConfigAttachmentV1 from "./attachment"

import { Schema } from "effect"
import { PositiveInt } from "../../schema"

export const Image = Schema.Struct({
  auto_resize: Schema.optional(Schema.Boolean).annotate({
    description: "Resize images before sending them to the model when they exceed configured limits (default: true)",
  }),
  max_width: Schema.optional(PositiveInt).annotate({
    description: "Maximum image width before resizing or rejecting the attachment (default: 2000)",
  }),
  max_height: Schema.optional(PositiveInt).annotate({
    description: "Maximum image height before resizing or rejecting the attachment (default: 2000)",
  }),
  max_base64_bytes: Schema.optional(PositiveInt).annotate({
    description: "Maximum base64 payload bytes for an image attachment (default: 5242880)",
  }),
  compress_over_base64_bytes: Schema.optional(PositiveInt).annotate({
    description:
      "Warning threshold: re-encode (and downscale if needed) an image once its base64 payload exceeds this many bytes, even when it is still below max_base64_bytes (default: 409600)",
  }),
}).annotate({ identifier: "ImageAttachmentConfig" })
export type Image = Schema.Schema.Type<typeof Image>

export const Info = Schema.Struct({
  image: Schema.optional(Image).annotate({ description: "Image attachment configuration" }),
  max_total_base64_bytes: Schema.optional(PositiveInt).annotate({
    description:
      "Maximum combined base64 payload bytes for all attachments sent in a single model request; the oldest ones are replaced with a placeholder first (default: 8388608)",
  }),
}).annotate({ identifier: "AttachmentConfig" })
export type Info = Schema.Schema.Type<typeof Info>
