import { describe, expect, it } from "vitest";
import {
  exportAvidText,
  exportAvidXml,
  exportCsv,
  exportFcpXml,
  exportJson,
  exportResolveEdl,
  exportText,
  exportXmeml,
  type MarkerComment,
  type MarkerOptions,
} from "./markers.js";

// Golden fixtures. Encoding contract under test: formats whose structure
// forbids raw newlines (Resolve EDL continuation lines, Avid text records)
// encode every newline, including the join between grouped same-frame
// bodies, as the two-character sequence backslash-n. Pipes in the EDL
// become "/". The Resolve exporter is ASCII-only with a "_" prefix on
// leading digits; CSV, JSON, and plain text keep bodies verbatim.

// Deliberately unsorted; exporters sort by frame then ULID, so the two
// frame-100 comments group in id order (...03 before ...04).
const sourceComments: MarkerComment[] = [
  {
    id: "01J00000000000000000000003",
    bodyText: "42 | grade is too warm\nsecond line",
    authorName: "Chloé",
    frameIn: 100,
  },
  {
    id: "01J00000000000000000000004",
    bodyText: "Café pass, señor",
    authorName: null,
    frameIn: 100,
  },
  {
    id: "01J00000000000000000000002",
    bodyText: "Sky replacement runs long",
    authorName: "Ben",
    frameIn: 24,
    frameOut: 47,
  },
  {
    id: "01J00000000000000000000001",
    bodyText: "Fix the flag pole matte",
    authorName: "Ava",
    frameIn: 0,
  },
];

// 24 fps NDF source starting at 01:00:00:00 (frame 86400), source TC base.
const sourceOptions: MarkerOptions = {
  title: "Onelight Comments",
  rate: { num: 24, den: 1 },
  startFrame: 86400,
  dropFrame: false,
  timecodeBase: "source",
};

// Same comments addressed in record-run frames (startFrame ignored).
const recordRunOptions: MarkerOptions = {
  ...sourceOptions,
  timecodeBase: "record_run",
};

// 29.97 DF source starting at 01:00:00;00 (frame 107892). The range
// comment crosses the 01:01 drop boundary (frames ;00 and ;01 skipped).
const dropFrameComments: MarkerComment[] = [
  {
    id: "01J0000000000000000000DF01",
    bodyText: "Drop frame start",
    authorName: "Dee",
    frameIn: 0,
  },
  {
    id: "01J0000000000000000000DF02",
    bodyText: "Crosses the drop minute",
    authorName: null,
    frameIn: 1799,
    frameOut: 1802,
  },
];

const dropFrameOptions: MarkerOptions = {
  title: "Reel B",
  rate: { num: 30000, den: 1001 },
  startFrame: 107892,
  dropFrame: true,
  timecodeBase: "source",
};

describe("exportResolveEdl", () => {
  it("emits an importable marker EDL from a source-TC 24 fps reel", () => {
    expect(exportResolveEdl(sourceComments, sourceOptions)).toBe(
      `TITLE: Onelight Comments\n` +
        `FCM: NON-DROP FRAME\n` +
        `\n` +
        `001  001      V     C        01:00:00:00 01:00:00:01 01:00:00:00 01:00:00:01\n` +
        ` |C:ResolveColorBlue |M:Fix the flag pole matte (Ava) |D:1\n` +
        `002  001      V     C        01:00:01:00 01:00:02:00 01:00:01:00 01:00:02:00\n` +
        ` |C:ResolveColorBlue |M:Sky replacement runs long (Ben) |D:24\n` +
        `003  001      V     C        01:00:04:04 01:00:04:05 01:00:04:04 01:00:04:05\n` +
        ` |C:ResolveColorBlue |M:_42 / grade is too warm\\nsecond line (Chloe)\\nCafe pass, senor |D:1\n`,
    );
  });

  it("emits drop-frame labels and FCM: DROP FRAME at 29.97 DF", () => {
    expect(exportResolveEdl(dropFrameComments, dropFrameOptions)).toBe(
      `TITLE: Reel B\n` +
        `FCM: DROP FRAME\n` +
        `\n` +
        `001  001      V     C        01:00:00;00 01:00:00;01 01:00:00;00 01:00:00;01\n` +
        ` |C:ResolveColorBlue |M:Drop frame start (Dee) |D:1\n` +
        `002  001      V     C        01:00:59;29 01:01:00;05 01:00:59;29 01:01:00;05\n` +
        ` |C:ResolveColorBlue |M:Crosses the drop minute |D:4\n`,
    );
  });

  it("addresses markers from zero in record-run mode", () => {
    expect(exportResolveEdl(sourceComments, recordRunOptions)).toBe(
      `TITLE: Onelight Comments\n` +
        `FCM: NON-DROP FRAME\n` +
        `\n` +
        `001  001      V     C        00:00:00:00 00:00:00:01 00:00:00:00 00:00:00:01\n` +
        ` |C:ResolveColorBlue |M:Fix the flag pole matte (Ava) |D:1\n` +
        `002  001      V     C        00:00:01:00 00:00:02:00 00:00:01:00 00:00:02:00\n` +
        ` |C:ResolveColorBlue |M:Sky replacement runs long (Ben) |D:24\n` +
        `003  001      V     C        00:00:04:04 00:00:04:05 00:00:04:04 00:00:04:05\n` +
        ` |C:ResolveColorBlue |M:_42 / grade is too warm\\nsecond line (Chloe)\\nCafe pass, senor |D:1\n`,
    );
  });
});

describe("exportAvidText", () => {
  it("emits the five-field tab-separated Media Composer format", () => {
    expect(exportAvidText(sourceComments, sourceOptions)).toBe(
      `Ava\t01:00:00:00\tV1\tblue\tFix the flag pole matte\n` +
        `Ben\t01:00:01:00\tV1\tblue\tSky replacement runs long\n` +
        `Chloé\t01:00:04:04\tV1\tblue\t42 | grade is too warm\\nsecond line\n` +
        `Onelight\t01:00:04:04\tV1\tblue\tCafé pass, señor\n`,
    );
  });

  it("emits drop-frame labels at 29.97 DF", () => {
    expect(exportAvidText(dropFrameComments, dropFrameOptions)).toBe(
      `Dee\t01:00:00;00\tV1\tblue\tDrop frame start\n` +
        `Onelight\t01:00:59;29\tV1\tblue\tCrosses the drop minute\n`,
    );
  });
});

describe("exportAvidXml", () => {
  it("falls back to the MC-compatible text format until a real MC marker XML export is round-tripped", () => {
    expect(exportAvidXml(sourceComments, sourceOptions)).toBe(
      exportAvidText(sourceComments, sourceOptions),
    );
    expect(exportAvidXml(dropFrameComments, dropFrameOptions)).toBe(
      `Dee\t01:00:00;00\tV1\tblue\tDrop frame start\n` +
        `Onelight\t01:00:59;29\tV1\tblue\tCrosses the drop minute\n`,
    );
  });
});

describe("exportXmeml", () => {
  it("declares timebase and ntsc and keeps bodies verbatim in comment", () => {
    expect(exportXmeml(sourceComments, sourceOptions)).toBe(
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<!DOCTYPE xmeml>\n` +
        `<xmeml version="5">\n` +
        `  <sequence>\n` +
        `    <name>Onelight Comments</name>\n` +
        `    <duration>86501</duration>\n` +
        `    <rate>\n` +
        `      <timebase>24</timebase>\n` +
        `      <ntsc>FALSE</ntsc>\n` +
        `    </rate>\n` +
        `    <marker>\n` +
        `      <name>Ava</name>\n` +
        `      <comment>Fix the flag pole matte</comment>\n` +
        `      <in>86400</in>\n` +
        `      <out>-1</out>\n` +
        `    </marker>\n` +
        `    <marker>\n` +
        `      <name>Ben</name>\n` +
        `      <comment>Sky replacement runs long</comment>\n` +
        `      <in>86424</in>\n` +
        `      <out>86448</out>\n` +
        `    </marker>\n` +
        `    <marker>\n` +
        `      <name>Chloé</name>\n` +
        `      <comment>42 | grade is too warm\nsecond line</comment>\n` +
        `      <in>86500</in>\n` +
        `      <out>-1</out>\n` +
        `    </marker>\n` +
        `    <marker>\n` +
        `      <name></name>\n` +
        `      <comment>Café pass, señor</comment>\n` +
        `      <in>86500</in>\n` +
        `      <out>-1</out>\n` +
        `    </marker>\n` +
        `  </sequence>\n` +
        `</xmeml>\n`,
    );
  });

  it("declares ntsc TRUE for 1001-denominator rates", () => {
    expect(exportXmeml(dropFrameComments, dropFrameOptions)).toBe(
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<!DOCTYPE xmeml>\n` +
        `<xmeml version="5">\n` +
        `  <sequence>\n` +
        `    <name>Reel B</name>\n` +
        `    <duration>109695</duration>\n` +
        `    <rate>\n` +
        `      <timebase>30</timebase>\n` +
        `      <ntsc>TRUE</ntsc>\n` +
        `    </rate>\n` +
        `    <marker>\n` +
        `      <name>Dee</name>\n` +
        `      <comment>Drop frame start</comment>\n` +
        `      <in>107892</in>\n` +
        `      <out>-1</out>\n` +
        `    </marker>\n` +
        `    <marker>\n` +
        `      <name></name>\n` +
        `      <comment>Crosses the drop minute</comment>\n` +
        `      <in>109691</in>\n` +
        `      <out>109695</out>\n` +
        `    </marker>\n` +
        `  </sequence>\n` +
        `</xmeml>\n`,
    );
  });
});

describe("exportFcpXml", () => {
  it("emits a minimal valid fcpxml skeleton with exact rational times", () => {
    expect(exportFcpXml(sourceComments, sourceOptions)).toBe(
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<!DOCTYPE fcpxml>\n` +
        `<fcpxml version="1.11">\n` +
        `  <resources>\n` +
        `    <format id="r1" frameDuration="1/24s" width="1920" height="1080"/>\n` +
        `  </resources>\n` +
        `  <library>\n` +
        `    <event name="Onelight Comments">\n` +
        `      <project name="Onelight Comments">\n` +
        `        <sequence format="r1" duration="86501/24s" tcStart="0s" tcFormat="NDF">\n` +
        `          <spine>\n` +
        `            <gap name="Gap" offset="0s" start="0s" duration="86501/24s">\n` +
        `              <marker start="86400/24s" duration="1/24s" value="Fix the flag pole matte"/>\n` +
        `              <marker start="86424/24s" duration="24/24s" value="Sky replacement runs long"/>\n` +
        `              <marker start="86500/24s" duration="1/24s" value="42 | grade is too warm&#10;second line"/>\n` +
        `              <marker start="86500/24s" duration="1/24s" value="Café pass, señor"/>\n` +
        `            </gap>\n` +
        `          </spine>\n` +
        `        </sequence>\n` +
        `      </project>\n` +
        `    </event>\n` +
        `  </library>\n` +
        `</fcpxml>\n`,
    );
  });

  it("uses the exact 1001 rational and DF timecode format at 29.97 DF", () => {
    expect(exportFcpXml(dropFrameComments, dropFrameOptions)).toBe(
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<!DOCTYPE fcpxml>\n` +
        `<fcpxml version="1.11">\n` +
        `  <resources>\n` +
        `    <format id="r1" frameDuration="1001/30000s" width="1920" height="1080"/>\n` +
        `  </resources>\n` +
        `  <library>\n` +
        `    <event name="Reel B">\n` +
        `      <project name="Reel B">\n` +
        `        <sequence format="r1" duration="109804695/30000s" tcStart="0s" tcFormat="DF">\n` +
        `          <spine>\n` +
        `            <gap name="Gap" offset="0s" start="0s" duration="109804695/30000s">\n` +
        `              <marker start="107999892/30000s" duration="1001/30000s" value="Drop frame start"/>\n` +
        `              <marker start="109800691/30000s" duration="4004/30000s" value="Crosses the drop minute"/>\n` +
        `            </gap>\n` +
        `          </spine>\n` +
        `        </sequence>\n` +
        `      </project>\n` +
        `    </event>\n` +
        `  </library>\n` +
        `</fcpxml>\n`,
    );
  });
});

describe("exportCsv", () => {
  it("keeps bodies verbatim, including pipes and real newlines", () => {
    expect(exportCsv(sourceComments, sourceOptions)).toBe(
      `id,frame_in,frame_out,timecode,body,author\n` +
        `"01J00000000000000000000001","0","0","01:00:00:00","Fix the flag pole matte","Ava"\n` +
        `"01J00000000000000000000002","24","47","01:00:01:00","Sky replacement runs long","Ben"\n` +
        `"01J00000000000000000000003","100","100","01:00:04:04","42 | grade is too warm\nsecond line","Chloé"\n` +
        `"01J00000000000000000000004","100","100","01:00:04:04","Café pass, señor",""\n`,
    );
  });

  it("labels record-run timecode from zero", () => {
    expect(exportCsv(sourceComments, recordRunOptions)).toBe(
      `id,frame_in,frame_out,timecode,body,author\n` +
        `"01J00000000000000000000001","0","0","00:00:00:00","Fix the flag pole matte","Ava"\n` +
        `"01J00000000000000000000002","24","47","00:00:01:00","Sky replacement runs long","Ben"\n` +
        `"01J00000000000000000000003","100","100","00:00:04:04","42 | grade is too warm\nsecond line","Chloé"\n` +
        `"01J00000000000000000000004","100","100","00:00:04:04","Café pass, señor",""\n`,
    );
  });
});

describe("exportJson", () => {
  it("keeps bodies verbatim with source timecode labels", () => {
    expect(exportJson(sourceComments, sourceOptions)).toBe(
      `[\n` +
        `  {\n` +
        `    "id": "01J00000000000000000000001",\n` +
        `    "bodyText": "Fix the flag pole matte",\n` +
        `    "authorName": "Ava",\n` +
        `    "frameIn": 0,\n` +
        `    "timecode": "01:00:00:00"\n` +
        `  },\n` +
        `  {\n` +
        `    "id": "01J00000000000000000000002",\n` +
        `    "bodyText": "Sky replacement runs long",\n` +
        `    "authorName": "Ben",\n` +
        `    "frameIn": 24,\n` +
        `    "frameOut": 47,\n` +
        `    "timecode": "01:00:01:00"\n` +
        `  },\n` +
        `  {\n` +
        `    "id": "01J00000000000000000000003",\n` +
        `    "bodyText": "42 | grade is too warm\\nsecond line",\n` +
        `    "authorName": "Chloé",\n` +
        `    "frameIn": 100,\n` +
        `    "timecode": "01:00:04:04"\n` +
        `  },\n` +
        `  {\n` +
        `    "id": "01J00000000000000000000004",\n` +
        `    "bodyText": "Café pass, señor",\n` +
        `    "authorName": null,\n` +
        `    "frameIn": 100,\n` +
        `    "timecode": "01:00:04:04"\n` +
        `  }\n` +
        `]\n`,
    );
  });
});

describe("exportText", () => {
  it("keeps bodies verbatim after the timecode label", () => {
    expect(exportText(sourceComments, sourceOptions)).toBe(
      `01:00:00:00 Fix the flag pole matte\n` +
        `01:00:01:00 Sky replacement runs long\n` +
        `01:00:04:04 42 | grade is too warm\nsecond line\n` +
        `01:00:04:04 Café pass, señor\n`,
    );
  });
});
