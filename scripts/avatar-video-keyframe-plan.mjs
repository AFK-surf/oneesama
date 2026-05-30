#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const DEFAULT_ASSET_ROOT = path.resolve("tmp/avatar-video");
const KEYFRAME_FILES = {
  idleFirst: "oneesama-video-idle-first.png",
  idleLast: "oneesama-video-idle-last.png",
  speakingFirst: "oneesama-video-speaking-first.png",
  speakingLast: "oneesama-video-speaking-last.png",
};

const SHARED_IDENTITY = [
  "Use the attached reference as the identity anchor.",
  "Photorealistic young woman, black hair with bangs, black-framed glasses, navy blazer, white shirt, pearl necklace.",
  "Centered chest-up on-camera meeting avatar, same crop, same lens, same clean studio lighting, simple soft background.",
  "No subtitles, no text, no logos, no extra people, no hand covering the face, no camera angle change.",
].join(" ");

function parseArgs(argv) {
  const args = {
    ref: "",
    outDir: path.join(process.env.ONEESAMA_AVATAR_ASSET_ROOT || DEFAULT_ASSET_ROOT, "keyframes"),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--ref") args.ref = argv[++i] || "";
    else if (arg === "--out-dir") args.outDir = argv[++i] || "";
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/avatar-video-keyframe-plan.mjs --ref <image> [--out-dir tmp/avatar-video/keyframes]

Writes Image2 prompt files, a manifest, and a review checklist.
The Image2 outputs should be saved with these names:
  ${KEYFRAME_FILES.idleFirst}
  ${KEYFRAME_FILES.idleLast}      optional; copy the approved first frame for loop v1 if not needed
  ${KEYFRAME_FILES.speakingFirst}
  ${KEYFRAME_FILES.speakingLast}  optional; copy the approved first frame for loop v1 if not needed`);
}

function requireInput(args) {
  const refPath = path.resolve(args.ref || "");
  if (!args.ref || !fs.existsSync(refPath)) {
    throw new Error("--ref must point to the portrait reference image");
  }
  return {
    refPath,
    outDir: path.resolve(args.outDir || path.join(DEFAULT_ASSET_ROOT, "keyframes")),
  };
}

function promptForState(state, endpoint) {
  const isSpeaking = state === "speaking";
  const stateLine = isSpeaking
    ? "Mouth is slightly open as a restrained mid-speech keyframe; eyes open, calm focused expression."
    : "Mouth is naturally closed; eyes open, calm warm neutral expression, attentive but not talking.";
  const endpointLine =
    endpoint === "last"
      ? "This is the loop end frame. It must be nearly identical to the approved first frame for the same state; only tiny natural settling differences are allowed."
      : "This is the loop first frame. Make it a stable canonical frame that can be reused as the loop end frame if needed.";
  return [
    SHARED_IDENTITY,
    stateLine,
    endpointLine,
    "The idle and speaking frames must keep the same face, glasses, hair shape, outfit, lighting, background, crop, and camera distance; only the mouth state should differ.",
  ].join(" ");
}

function writeText(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${content.trim()}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = requireInput(args);
  const promptDir = path.join(config.outDir, "prompts");
  const prompts = {
    "idle-first.prompt.txt": promptForState("idle", "first"),
    "idle-last.prompt.txt": promptForState("idle", "last"),
    "speaking-first.prompt.txt": promptForState("speaking", "first"),
    "speaking-last.prompt.txt": promptForState("speaking", "last"),
  };
  for (const [fileName, prompt] of Object.entries(prompts)) {
    writeText(path.join(promptDir, fileName), prompt);
  }

  const manifest = {
    version: 1,
    sourceReference: path.relative(process.cwd(), config.refPath),
    keyframeDir: path.relative(process.cwd(), config.outDir),
    states: {
      idle: {
        firstFrame: KEYFRAME_FILES.idleFirst,
        lastFrame: KEYFRAME_FILES.idleLast,
        promptFiles: ["prompts/idle-first.prompt.txt", "prompts/idle-last.prompt.txt"],
      },
      speaking: {
        firstFrame: KEYFRAME_FILES.speakingFirst,
        lastFrame: KEYFRAME_FILES.speakingLast,
        promptFiles: ["prompts/speaking-first.prompt.txt", "prompts/speaking-last.prompt.txt"],
      },
    },
    reviewGate: [
      "face/glasses/hair/outfit match the reference and each other",
      "idle and speaking share the same crop, lighting, background, and camera distance",
      "only the mouth state differs between idle and speaking",
      "optional last frames are nearly identical to their approved first frames",
    ],
    nextCommand:
      "npm run avatar:video:seedance -- --keyframe-dir tmp/avatar-video/keyframes --out-dir tmp/avatar-video",
  };
  writeText(
    path.join(config.outDir, "oneesama-video-keyframes.manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  writeText(
    path.join(config.outDir, "REVIEW.md"),
    `# Oneesama Video Avatar Keyframe Review

Before running Seedance, approve the Image2 keyframes:

- ${KEYFRAME_FILES.idleFirst}: idle first/canonical frame
- ${KEYFRAME_FILES.idleLast}: idle loop end frame, optional; may be copied from first frame for v1
- ${KEYFRAME_FILES.speakingFirst}: speaking first/canonical frame
- ${KEYFRAME_FILES.speakingLast}: speaking loop end frame, optional; may be copied from first frame for v1

Review gate:

- Face, glasses, hair, blazer, shirt, and pearl necklace stay consistent with the reference.
- Idle and speaking have the same crop, lighting, background, and camera distance.
- The only intentional cross-state difference is the mouth: idle closed, speaking slightly open.
- Last frames, if generated separately, are nearly identical to their matching first frames.

After approval:

\`\`\`bash
npm run avatar:video:seedance -- --keyframe-dir ${path.relative(process.cwd(), config.outDir)} --out-dir tmp/avatar-video
\`\`\`
`,
  );
  console.log(`Wrote Image2 keyframe plan to ${config.outDir}`);
}

main();
