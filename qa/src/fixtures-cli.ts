/* CLI entry: pnpm --filter @onelight/qa fixtures
   Synthesizes the full corpus into qa/.artifacts/fixtures. */

import { detectEnvironment } from "./capabilities.js";
import { synthesizeFixtures } from "./fixtures.js";

const env = detectEnvironment();
if (!env.ffmpeg || !env.ffprobe) {
  console.error(
    "[qa] fixtures: ffmpeg and ffprobe are required on PATH (or FFMPEG_PATH/FFPROBE_PATH).",
  );
  process.exit(1);
}

synthesizeFixtures().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
