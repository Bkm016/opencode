import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit } from "effect"
import { Image } from "@/image/image"
import { Config } from "@/config/config"
import { MessageID, PartID, SessionID } from "@/session/schema"
import path from "node:path"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Image.node, [[Config.node, TestConfig.layer()]]))
const tiny = testEffect(
  LayerNode.compile(Image.node, [
    [Config.node, TestConfig.layer({ get: () => Effect.succeed({ attachment: { image: { max_base64_bytes: 1 } } }) })],
  ]),
)

// Mutated per test; Config.get is a thunk so each normalize() re-reads it.
let imageConfig: Record<string, unknown> = {}
const configured = testEffect(
  LayerNode.compile(Image.node, [
    [Config.node, TestConfig.layer({ get: () => Effect.succeed({ attachment: { image: imageConfig } }) })],
  ]),
)

/** Deterministic noise, so PNG cannot compress it away and JPEG has real work to do. */
function noise(width: number, height: number) {
  const pixels = new Uint8Array(width * height * 4)
  let seed = 0x2545f491
  for (let index = 0; index < pixels.length; index += 4) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    pixels[index] = seed & 0xff
    pixels[index + 1] = (seed >> 8) & 0xff
    pixels[index + 2] = (seed >> 16) & 0xff
    pixels[index + 3] = 255
  }
  return pixels
}

function base64Of(url: string) {
  return url.slice(url.indexOf(";base64,") + ";base64,".length)
}

function part(mime: string, data: string) {
  return {
    id: PartID.ascending(),
    messageID: MessageID.ascending(),
    sessionID: SessionID.make("ses_test"),
    type: "file" as const,
    mime,
    url: `data:${mime};base64,${data}`,
  }
}

describe("Image", () => {
  it.effect("normalizes generated png and jpeg attachments", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const source = new photon.PhotonImage(
        new Uint8Array(Array.from({ length: 64 * 64 * 4 }, (_, index) => (index % 4 === 3 ? 255 : index % 251))),
        64,
        64,
      )
      const image = yield* Image.Service
      const results = yield* Effect.all([
        image.normalize(part("image/png", Buffer.from(source.get_bytes()).toString("base64"))),
        image.normalize(part("image/jpeg", Buffer.from(source.get_bytes_jpeg(90)).toString("base64"))),
      ])

      source.free()
      expect(results.map((result) => result.url.startsWith(`data:${result.mime};base64,`))).toEqual([true, true])
      expect(results.every((result) => result.mime === "image/png" || result.mime === "image/jpeg")).toBe(true)
    }),
  )

  it.effect("accepts webp attachments that are already within limits", () =>
    Effect.gen(function* () {
      const image = yield* Image.Service
      const input = part("image/webp", "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA")

      expect(yield* image.normalize(input)).toEqual(input)
    }),
  )

  it.effect("resizes images that fit the byte limit but exceed dimension limits", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const source = new photon.PhotonImage(new Uint8Array(Array.from({ length: 9_000 * 4 }, () => 255)), 9_000, 1)
      const image = yield* Image.Service
      const result = yield* image.normalize(part("image/png", Buffer.from(source.get_bytes()).toString("base64")))
      const resized = photon.PhotonImage.new_from_byteslice(
        Buffer.from(result.url.slice(result.url.indexOf(";base64,") + ";base64,".length), "base64"),
      )

      source.free()
      expect(resized.get_width()).toBeLessThanOrEqual(2_000)
      expect(resized.get_height()).toBeLessThanOrEqual(2_000)
      resized.free()
    }),
  )

  it.effect("resizes the 5MB base64 picture fixture", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const data = Buffer.from(
        yield* Effect.promise(() =>
          Bun.file(path.join(import.meta.dir, "fixtures", "picture-5mb-base64.png")).arrayBuffer(),
        ),
      )
      const input = part("image/png", data.toString("base64"))
      const image = yield* Image.Service
      const result = yield* image.normalize(input)
      const base64 = result.url.slice(result.url.indexOf(";base64,") + ";base64,".length)
      const resized = photon.PhotonImage.new_from_byteslice(Buffer.from(base64, "base64"))

      expect(input.url.slice(input.url.indexOf(";base64,") + ";base64,".length).length).toBe(5 * 1024 * 1024)
      expect(result.url).not.toBe(input.url)
      expect(base64.length).toBeLessThan(5 * 1024 * 1024)
      expect(resized.get_width()).toBeLessThanOrEqual(2_000)
      expect(resized.get_height()).toBeLessThanOrEqual(2_000)
      resized.free()
    }),
  )

  tiny.effect("fails with a typed size error when no resized candidate fits", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const source = new photon.PhotonImage(new Uint8Array(Array.from({ length: 4 }, () => 255)), 1, 1)
      const image = yield* Image.Service
      const exit = yield* image
        .normalize(part("image/png", Buffer.from(source.get_bytes()).toString("base64")))
        .pipe(Effect.exit)

      source.free()
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(Image.SizeError)
        if (error instanceof Image.SizeError) {
          expect(error.width).toBe(1)
          expect(error.height).toBe(1)
          expect(error.max).toBe(1)
        }
      }
    }),
  )

  configured.effect("compresses images above the warning line even when they fit the hard limit", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const source = new photon.PhotonImage(noise(512, 512), 512, 512)
      const input = part("image/png", Buffer.from(source.get_bytes()).toString("base64"))
      source.free()
      const original = base64Of(input.url).length
      imageConfig = { max_base64_bytes: 5 * 1024 * 1024, compress_over_base64_bytes: Math.floor(original / 2) }

      const image = yield* Image.Service
      const result = yield* image.normalize(input)
      const base64 = base64Of(result.url)
      const decoded = photon.PhotonImage.new_from_byteslice(Buffer.from(base64, "base64"))

      // Under the hard limit the whole way, so the old code returned it untouched.
      expect(original).toBeLessThan(5 * 1024 * 1024)
      expect(base64.length).toBeLessThanOrEqual(Math.floor(original / 2))
      // Re-encoding alone is enough here, so full resolution survives.
      expect(decoded.get_width()).toBe(512)
      expect(decoded.get_height()).toBe(512)
      decoded.free()
    }),
  )

  configured.effect("leaves images below the warning line untouched", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const source = new photon.PhotonImage(noise(64, 64), 64, 64)
      const input = part("image/png", Buffer.from(source.get_bytes()).toString("base64"))
      source.free()
      imageConfig = { compress_over_base64_bytes: base64Of(input.url).length + 1 }

      const image = yield* Image.Service
      expect(yield* image.normalize(input)).toEqual(input)
    }),
  )

  configured.effect("respects auto_resize: false by only enforcing the hard limit", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const source = new photon.PhotonImage(noise(256, 256), 256, 256)
      const input = part("image/png", Buffer.from(source.get_bytes()).toString("base64"))
      source.free()
      imageConfig = { auto_resize: false, compress_over_base64_bytes: 1 }

      const image = yield* Image.Service
      // The warning line is advisory: with resizing disabled it must not fail the attachment.
      expect(yield* image.normalize(input)).toEqual(input)
    }),
  )

  it.effect("compresses a screenshot-sized png under the default warning line", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const source = new photon.PhotonImage(noise(800, 800), 800, 800)
      const input = part("image/png", Buffer.from(source.get_bytes()).toString("base64"))
      source.free()

      const image = yield* Image.Service
      const result = yield* image.normalize(input)
      const base64 = base64Of(result.url)

      // 800x800 is far below the 2000x2000 / 5MB hard limits, yet a run of these
      // is exactly what used to accumulate until requests stopped going through.
      expect(base64Of(input.url).length).toBeGreaterThan(400 * 1024)
      expect(base64.length).toBeLessThanOrEqual(400 * 1024)
    }),
  )
})
