import { describe, expect, it } from "vitest";
import { classifyReferenceFailure } from "./picture-backend.js";

describe("reference failure classification", () => {
  it("keeps context loss distinct from generic renderer failures", () => {
    expect(
      classifyReferenceFailure("Reference renderer context was lost.", false),
    ).toBe("context_lost");
    expect(
      classifyReferenceFailure(
        "Reference renderer shader compilation failed.",
        false,
      ),
    ).toBe("renderer");
  });

  it("reports packet and keyframe failures as demux failures", () => {
    expect(
      classifyReferenceFailure(
        "No keyframe is available before the requested frame.",
        true,
      ),
    ).toBe("demux");
    expect(
      classifyReferenceFailure("WebCodecs VideoDecoder is unavailable.", true),
    ).toBe("decoder_unsupported");
  });
});
