<!--
Adapted from OpenAI Codex's .system/imagegen/SKILL.md and
references/prompting.md, licensed under Apache-2.0 (imagegen.LICENSE.txt).
Modified for OpenCode: native tool names, image loading, and attachment delivery;
Codex-only paths and unbundled CLI resources are omitted.
-->

# Image Generation

Generate or edit images for the current task: website and game assets, product
shots, illustrations, UI mockups, diagrams, or transparent-background cutouts.

## Tool Selection

- Use the available native image tool (`image_generation` or `image_gen`) for image generation and editing. Loading this skill provides guidance, not an alternative renderer.
- Do not substitute HTML, SVG, canvas, Python drawing, or placeholders for a requested image. Use code-native output only when the user explicitly requests it or asks to edit an existing code-native asset.
- Use only the tool's actual exposed parameters. Do not invent destination-path, model, quality, mask, or output-format arguments.
- Do not ask for an API key to use the native tool. If it is unavailable or fails, report the limitation; do not silently switch to an external API, CLI, or a different image model.
- This skill is self-contained. It does not bundle a Python CLI or require Codex-specific scripts.

## Intent And Inputs

Distinguish intent from execution strategy:

- **Generate:** create a new image, including when supplied images are references for subject, style, composition, or mood.
- **Edit:** modify an existing image while preserving its other features. Explicitly state what changes and what remains invariant.
- **Multiple assets:** use a separate native generation call for each distinct asset or requested variant. A request for a batch does not imply switching to an API or CLI.

For every input image, identify its index and role: edit target, reference image,
or supporting insert/style/compositing input. Do not assume all inputs are edit targets.
When a target or reference exists only on disk, load it with `read` so its image
attachment is available in the conversation before invoking the image tool.
Do not promise that the image tool can open an arbitrary filesystem path.

## Workflow

1. Determine whether the request is generation or editing, one asset or several, and preview-only or project-bound.
2. Gather the user's prompt, exact text, constraints, avoid list, and input images. Proceed without reconfirming a clear request; ask only if a missing critical detail blocks useful execution.
3. Label image roles and load local references or targets into the conversation.
4. Normalize detailed prompts without adding creative requirements. Augment generic prompts only where it materially improves the result.
5. Invoke the native image tool. For transparent output, request actual transparency rather than a painted checkerboard.
6. When outputs are available for inspection, check subject, style, composition, text, and edit invariants. Do not claim to have inspected an inaccessible output.
7. If correction is needed, make one targeted change and repeat the critical invariants to reduce drift.
8. Deliver the selected output. For project-bound assets, save the actual returned artifact in the workspace and update consuming references when the available tools permit it; otherwise clearly report the remaining delivery limitation.

## Prompt Augmentation

Structure prompts as scene/backdrop, subject, important details, constraints,
and intended use. For complex requests use short labeled lines, not a dense paragraph.
The scaffold below is optional prompt text, not the tool's argument schema.

```text
Use case: <generation or edit category>
Asset type: <intended use>
Primary request: <user's main prompt>
Input images: <Image 1: role; Image 2: role>
Scene/backdrop: <environment>
Subject: <main subject>
Style/medium: <photo, illustration, 3D, etc.>
Composition/framing: <viewpoint, framing, placement>
Lighting/mood: <lighting and atmosphere>
Color palette: <requested or relevant palette>
Materials/textures: <surface details>
Text (verbatim): "<exact text>"
Constraints: <must keep and must avoid>
```

Include only lines that help the request. Do not turn this scaffold into a checklist
of details that must be invented.

- Preserve specific prompts faithfully; normalize their structure instead of expanding their creative scope.
- For generic prompts, useful additions include framing, intended use, practical layout, polish level, and scene details implied by the request.
- Do not add unrelated characters, objects, brand names, slogans, palettes, or narrative beats.
- Do not invent left/right placement unless the user or surrounding layout supports it. Request negative space when the asset needs room for UI or copy.
- For photorealism, use photographic language and concrete natural texture rather than indiscriminate stylized polish.
- Quote required text verbatim and specify relevant typography and placement. Spell difficult words letter-by-letter when useful; request no extra characters.
- For edits, repeat `change only X; keep Y unchanged` on every iteration.
- For compositing, reference images by index and explain what moves where, with matching lighting, perspective, and scale.

## Generation Categories

- **photorealistic-natural:** candid/editorial scenes, real texture, natural lighting, deliberate camera framing.
- **product-mockup:** product and packaging materials, clean silhouette, accurate labels and readable text.
- **ui-mockup:** intended fidelity, practical layout, hierarchy, and interface elements rather than concept-art styling.
- **infographic-diagram:** audience, reading flow, explicit labels, and readable structure.
- **scientific-educational:** learning objective, required labels, scientific accuracy, arrows, and whitespace.
- **ads-marketing:** audience, brand positioning, scene, and exact requested copy.
- **productivity-visual:** slide, chart, or workflow with supplied data, clear hierarchy, and readable typography.
- **logo-brand:** simple scalable silhouette and balanced negative space; a generated bitmap is not an editable vector deliverable.
- **illustration-story:** concrete scene beats or panels and consistent characters.
- **stylized-concept:** medium, texture, and rendering cues without unrelated story elements.
- **historical-scene:** location, date, and period-appropriate clothing, objects, and environment.

## Edit Categories

- **text-localization:** replace only text; preserve typography, layout, spacing, and hierarchy unless changes are necessary.
- **identity-preserve:** lock face, body, pose, hair, and expression; change only the requested features.
- **precise-object-edit:** remove or replace the named element while preserving surrounding texture and lighting.
- **lighting-weather:** change environmental conditions, not geometry, framing, or subject identity.
- **background-extraction:** request a genuinely transparent cutout, preserving fine edges and label text without halos or restyling.
- **style-transfer:** identify palette, texture, or brushwork to transfer, and constrain unwanted extra elements.
- **compositing:** identify source and destination images; preserve base framing and match perspective, scale, and light.
- **sketch-to-render:** retain layout, proportions, and perspective while adding requested materials and lighting.

## Output Handling

- Treat returned attachments and actual tool-reported paths as authoritative. Do not invent a saved path or assume a `$CODEX_HOME/generated_images` directory exists.
- For preview or brainstorming, use the tool's inline image delivery. Do not add a redundant prose description of the generated image.
- For a workspace asset, use the user's destination when specified; otherwise choose a suitable project asset location. Do not leave project references pointing only at a transient attachment.
- Preserve the generated alpha channel for transparent outputs.
- Do not overwrite an existing asset without a replacement request; prefer a descriptive sibling version such as `hero-v2.png`.
- For multiple assets, retain each selected deliverable, not discarded variants unless requested.
- Report saved paths only after files have actually been saved. Do not report success for a generation or save operation that failed.

## Examples

Generation:

```text
Use case: product-mockup
Asset type: landing page hero
Primary request: a minimal hero image of a ceramic coffee mug
Style/medium: clean product photography
Composition/framing: wide composition with usable negative space for page copy
Lighting/mood: soft studio lighting
Constraints: no logos, no text, no watermark
```

Edit:

```text
Use case: precise-object-edit
Asset type: product photo background replacement
Input images: Image 1: edit target
Primary request: replace only the background with a warm sunset gradient
Constraints: keep the product, framing, and edges unchanged; no text; no watermark
```
