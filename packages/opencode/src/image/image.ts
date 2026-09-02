import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Config } from "@/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { MessageV2 } from "@/session/message-v2"
import photonWasm from "@silvia-odwyer/photon-node/photon_rs_bg.wasm" with { type: "file" }
import { Context, Effect, Layer, Schema } from "effect"
import path from "node:path"
import { fileURLToPath } from "node:url"

const MAX_BASE64_BYTES = 5 * 1024 * 1024
// Warning line. Anything above this is re-encoded (and downscaled if that is not
// enough) even though it is still far below MAX_BASE64_BYTES. A single 1400x1250
// screenshot is ~1.7MB of base64 as PNG but ~370KB as JPEG q80 at the very same
// resolution, so a handful of untouched screenshots is enough to blow past a
// provider's request limit and stall the session.
const COMPRESS_OVER_BASE64_BYTES = 400 * 1024
const MAX_WIDTH = 2000
const MAX_HEIGHT = 2000
const AUTO_RESIZE = true
const JPEG_QUALITIES = [80, 85, 70, 55, 40]

export class ResizerUnavailableError extends Schema.TaggedErrorClass<ResizerUnavailableError>()(
  "ImageResizerUnavailableError",
  {},
) {
  override get message() {
    return "Image resizer is unavailable"
  }
}

export class InvalidDataUrlError extends Schema.TaggedErrorClass<InvalidDataUrlError>()("ImageInvalidDataUrlError", {
  url: Schema.String,
}) {
  override get message() {
    return "Image URL must be a base64 data URL"
  }
}

export class DecodeError extends Schema.TaggedErrorClass<DecodeError>()("ImageDecodeError", {}) {
  override get message() {
    return "Image could not be decoded"
  }
}

export class SizeError extends Schema.TaggedErrorClass<SizeError>()("ImageSizeError", {
  bytes: Schema.Number,
  max: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
  max_width: Schema.Number,
  max_height: Schema.Number,
}) {
  override get message() {
    return `Image ${this.width}x${this.height} with base64 size ${this.bytes} exceeds configured limits and could not be resized below ${this.max_width}x${this.max_height}/${this.max} bytes`
  }
}

export type Error = ResizerUnavailableError | InvalidDataUrlError | DecodeError | SizeError

export interface Interface {
  readonly normalize: (input: SessionV1.FilePart) => Effect.Effect<SessionV1.FilePart, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Image") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const loadPhoton = yield* Effect.cached(
      Effect.sync(() => {
        // Patched photon-node reads this during module init so Bun compiled binaries use the embedded wasm path.
        ;(globalThis as typeof globalThis & { __OPENCODE_PHOTON_WASM_PATH?: string }).__OPENCODE_PHOTON_WASM_PATH =
          path.isAbsolute(photonWasm) ? photonWasm : fileURLToPath(new URL(photonWasm, import.meta.url))
      }).pipe(
        Effect.andThen(() => Effect.tryPromise(() => import("@silvia-odwyer/photon-node"))),
        Effect.tapError((error) => Effect.logWarning("failed to load photon", { error })),
        Effect.mapError(() => new ResizerUnavailableError()),
      ),
    )

    const normalize = Effect.fn("Image.normalize")(function* (input: SessionV1.FilePart) {
      const image = (yield* config.get()).attachment?.image
      const info = {
        autoResize: image?.auto_resize ?? AUTO_RESIZE,
        maxWidth: image?.max_width ?? MAX_WIDTH,
        maxHeight: image?.max_height ?? MAX_HEIGHT,
        maxBase64Bytes: image?.max_base64_bytes ?? MAX_BASE64_BYTES,
        compressOverBase64Bytes: image?.compress_over_base64_bytes ?? COMPRESS_OVER_BASE64_BYTES,
      }
      // Hard failure line vs. the (lower) line we actually aim for.
      const hardMax = info.maxBase64Bytes
      const target = Math.min(hardMax, info.compressOverBase64Bytes)
      if (!input.url.startsWith("data:") || !input.url.includes(";base64,"))
        return yield* new InvalidDataUrlError({ url: input.url })

      const base64 = input.url.slice(input.url.indexOf(";base64,") + ";base64,".length)
      const bytes = Buffer.byteLength(base64, "utf8")

      const photon = yield* loadPhoton

      const decoded = yield* Effect.try({
        try: () => photon.PhotonImage.new_from_byteslice(Buffer.from(base64, "base64")),
        catch: () => new DecodeError(),
      }).pipe(Effect.tapError((error) => Effect.logWarning("failed to decode image", { error })))

      try {
        const originalWidth = decoded.get_width()
        const originalHeight = decoded.get_height()
        const dimensionsOk = originalWidth <= info.maxWidth && originalHeight <= info.maxHeight
        if (dimensionsOk && bytes <= target) return input
        // auto_resize off keeps the old contract: only the hard limits are enforced,
        // the compression warning line is advisory and cannot fail an attachment.
        if (!info.autoResize) {
          if (dimensionsOk && bytes <= hardMax) return input
          return yield* new SizeError({
            bytes,
            max: hardMax,
            width: originalWidth,
            height: originalHeight,
            max_width: info.maxWidth,
            max_height: info.maxHeight,
          })
        }

        // Smallest encoding produced anywhere along the ladder, used as a fallback
        // when nothing reaches the target but the hard limit is still satisfiable.
        let best: { data: string; mime: string; bytes: number } | undefined

        const scale = Math.min(1, info.maxWidth / originalWidth, info.maxHeight / originalHeight)
        for (const size of Array.from({ length: 32 }).reduce<Array<{ width: number; height: number }>>((acc) => {
          const previous = acc.at(-1) ?? {
            width: Math.max(1, Math.round(originalWidth * scale)),
            height: Math.max(1, Math.round(originalHeight * scale)),
          }
          const next =
            acc.length === 0
              ? previous
              : {
                  width: previous.width === 1 ? 1 : Math.max(1, Math.floor(previous.width * 0.75)),
                  height: previous.height === 1 ? 1 : Math.max(1, Math.floor(previous.height * 0.75)),
                }
          return acc.some((item) => item.width === next.width && item.height === next.height) ? acc : [...acc, next]
        }, [])) {
          const resized = photon.resize(decoded, size.width, size.height, photon.SamplingFilter.Lanczos3)
          // Re-encoding to PNG at the original size cannot get under a target the
          // original already exceeds - photon's PNG output is routinely larger than
          // the source - so skip that encode instead of paying for it every time.
          const identity = size.width === originalWidth && size.height === originalHeight
          const encoders = [
            ...(identity && bytes > target ? [] : [{ mime: "image/png", encode: () => resized.get_bytes() }]),
            ...JPEG_QUALITIES.map((quality) => ({
              mime: "image/jpeg",
              encode: () => resized.get_bytes_jpeg(quality),
            })),
          ]
          let candidate: { data: string; mime: string; bytes: number } | undefined
          for (const encoder of encoders) {
            const data = Buffer.from(encoder.encode()).toString("base64")
            const encoded = { data, mime: encoder.mime, bytes: Buffer.byteLength(data, "utf8") }
            if (!best || encoded.bytes < best.bytes) best = encoded
            if (encoded.bytes <= target) {
              candidate = encoded
              break
            }
          }
          resized.free()

          if (candidate) {
            yield* Effect.logInfo("using resized image", {
              from_mime: input.mime,
              to_mime: candidate.mime,
              from: `${originalWidth}x${originalHeight}`,
              to: `${size.width}x${size.height}`,
              from_bytes: bytes,
              to_bytes: candidate.bytes,
            })
            return {
              ...input,
              mime: candidate.mime,
              url: `data:${candidate.mime};base64,${candidate.data}`,
            }
          }
        }

        // Nothing hit the target. Keep the smallest encoding we found as long as it
        // still respects the hard limit and actually improves on the original.
        if (best && best.bytes <= hardMax && best.bytes < bytes) {
          yield* Effect.logWarning("image compressed below hard limit but above target", {
            from_mime: input.mime,
            to_mime: best.mime,
            from_bytes: bytes,
            to_bytes: best.bytes,
            target,
          })
          return {
            ...input,
            mime: best.mime,
            url: `data:${best.mime};base64,${best.data}`,
          }
        }
        if (dimensionsOk && bytes <= hardMax) return input

        return yield* new SizeError({
          bytes,
          max: hardMax,
          width: originalWidth,
          height: originalHeight,
          max_width: info.maxWidth,
          max_height: info.maxHeight,
        })
      } finally {
        decoded.free()
      }
    })

    return Service.of({ normalize })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [Config.node] })

export * as Image from "./image"
