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
  parseMarkersCsv,
  parseResolveEdl,
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
  durationFrames: 240,
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
  durationFrames: 1803,
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
        ` |C:ResolveColorBlue |M:Ava: Fix the flag pole matte |D:1\n` +
        `002  001      V     C        01:00:01:00 01:00:02:00 01:00:01:00 01:00:02:00\n` +
        ` |C:ResolveColorBlue |M:Ben: Sky replacement runs long |D:24\n` +
        `003  001      V     C        01:00:04:04 01:00:04:05 01:00:04:04 01:00:04:05\n` +
        ` |C:ResolveColorBlue |M:Chloe: 42 / grade is too warm\\nsecond line\\n---\\nReviewer: Cafe pass, senor |D:1\n`,
    );
  });

  it("emits drop-frame labels and FCM: DROP FRAME at 29.97 DF", () => {
    expect(exportResolveEdl(dropFrameComments, dropFrameOptions)).toBe(
      `TITLE: Reel B\n` +
        `FCM: DROP FRAME\n` +
        `\n` +
        `001  001      V     C        01:00:00;00 01:00:00;01 01:00:00;00 01:00:00;01\n` +
        ` |C:ResolveColorBlue |M:Dee: Drop frame start |D:1\n` +
        `002  001      V     C        01:00:59;29 01:01:00;05 01:00:59;29 01:01:00;05\n` +
        ` |C:ResolveColorBlue |M:Reviewer: Crosses the drop minute |D:4\n`,
    );
  });

  it("addresses markers from zero in record-run mode", () => {
    expect(exportResolveEdl(sourceComments, recordRunOptions)).toBe(
      `TITLE: Onelight Comments\n` +
        `FCM: NON-DROP FRAME\n` +
        `\n` +
        `001  001      V     C        00:00:00:00 00:00:00:01 00:00:00:00 00:00:00:01\n` +
        ` |C:ResolveColorBlue |M:Ava: Fix the flag pole matte |D:1\n` +
        `002  001      V     C        00:00:01:00 00:00:02:00 00:00:01:00 00:00:02:00\n` +
        ` |C:ResolveColorBlue |M:Ben: Sky replacement runs long |D:24\n` +
        `003  001      V     C        00:00:04:04 00:00:04:05 00:00:04:04 00:00:04:05\n` +
        ` |C:ResolveColorBlue |M:Chloe: 42 / grade is too warm\\nsecond line\\n---\\nReviewer: Cafe pass, senor |D:1\n`,
    );
  });
});

describe("exportAvidText", () => {
  it("emits the five-field tab-separated Media Composer format", () => {
    expect(exportAvidText(sourceComments, sourceOptions)).toBe(
      `Ava\t01:00:00:00\tV1\tblue\tFix the flag pole matte\\n\\nAuthor: Ava\\nStatus: Open\n` +
        `Ben\t01:00:01:00\tV1\tblue\tSky replacement runs long\\n\\nAuthor: Ben\\nStatus: Open\n` +
        `Chloé\t01:00:04:04\tV1\tblue\t42 | grade is too warm\\nsecond line\\n\\nAuthor: Chloé\\nStatus: Open\n` +
        `Onelight\t01:00:04:04\tV1\tblue\tCafé pass, señor\\n\\nAuthor: Reviewer\\nStatus: Open\n`,
    );
  });

  it("emits drop-frame labels at 29.97 DF", () => {
    expect(exportAvidText(dropFrameComments, dropFrameOptions)).toBe(
      `Dee\t01:00:00;00\tV1\tblue\tDrop frame start\\n\\nAuthor: Dee\\nStatus: Open\n` +
        `Onelight\t01:00:59;29\tV1\tblue\tCrosses the drop minute\\n\\nAuthor: Reviewer\\nStatus: Open\n`,
    );
  });
});

describe("exportAvidXml", () => {
  it("falls back to the MC-compatible text format until a real MC marker XML export is round-tripped", () => {
    expect(exportAvidXml(sourceComments, sourceOptions)).toBe(
      exportAvidText(sourceComments, sourceOptions),
    );
    expect(exportAvidXml(dropFrameComments, dropFrameOptions)).toBe(
      `Dee\t01:00:00;00\tV1\tblue\tDrop frame start\\n\\nAuthor: Dee\\nStatus: Open\n` +
        `Onelight\t01:00:59;29\tV1\tblue\tCrosses the drop minute\\n\\nAuthor: Reviewer\\nStatus: Open\n`,
    );
  });
});

describe("thread context and review state", () => {
  const thread: MarkerComment[] = [
    {
      id: "01J0000000000000000000ST01",
      bodyText: "Hold for legal",
      authorName: "Ava",
      frameIn: 12,
      completed: true,
      internal: true,
      replies: [
        {
          id: "01J0000000000000000000ST02",
          bodyText: "Approved with the alternate card",
          authorName: "Ben",
        },
      ],
    },
  ];

  it("carries author, replies, completion, and internal visibility into NLE notes", () => {
    const edl = exportResolveEdl(thread, sourceOptions);
    expect(edl).toContain("|C:ResolveColorPurple");
    expect(edl).toContain("[Done, Internal] Ava: Hold for legal");
    expect(edl).toContain("Reply from Ben: Approved with the alternate card");

    const avid = exportAvidText(thread, sourceOptions);
    expect(avid).toContain("\tmagenta\t");
    expect(avid).toContain("Status: Completed");
    expect(avid).toContain("Visibility: Internal");
    expect(avid).toContain("Ben: Approved with the alternate card");

    const fcp = exportFcpXml(thread, sourceOptions);
    expect(fcp).toContain('completed="1"');
    expect(fcp).toContain("Visibility: Internal");

    const xmeml = exportXmeml(thread, sourceOptions);
    expect(xmeml).toContain("Status: Completed");
    expect(xmeml).toContain("Ben: Approved with the alternate card");
  });
});

describe("exportXmeml", () => {
  it("keeps source timecode in the sequence while markers stay sequence-relative", () => {
    expect(exportXmeml(sourceComments, sourceOptions)).toBe(
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<!DOCTYPE xmeml>\n` +
        `<xmeml version="5">\n` +
        `  <sequence>\n` +
        `    <name>Onelight Comments</name>\n` +
        `    <duration>240</duration>\n` +
        `    <rate>\n` +
        `      <timebase>24</timebase>\n` +
        `      <ntsc>FALSE</ntsc>\n` +
        `    </rate>\n` +
        `    <timecode>\n` +
        `      <rate>\n` +
        `        <timebase>24</timebase>\n` +
        `        <ntsc>FALSE</ntsc>\n` +
        `      </rate>\n` +
        `      <string>01:00:00:00</string>\n` +
        `      <frame>86400</frame>\n` +
        `      <displayformat>NDF</displayformat>\n` +
        `    </timecode>\n` +
        `    <marker>\n` +
        `      <name>Ava: Fix the flag pole matte</name>\n` +
        `      <in>0</in>\n` +
        `      <out>-1</out>\n` +
        `      <comment>Fix the flag pole matte\n\nAuthor: Ava\nStatus: Open</comment>\n` +
        `    </marker>\n` +
        `    <marker>\n` +
        `      <name>Ben: Sky replacement runs long</name>\n` +
        `      <in>24</in>\n` +
        `      <out>48</out>\n` +
        `      <comment>Sky replacement runs long\n\nAuthor: Ben\nStatus: Open</comment>\n` +
        `    </marker>\n` +
        `    <marker>\n` +
        `      <name>Chloé: 42 | grade is too warm second line</name>\n` +
        `      <in>100</in>\n` +
        `      <out>-1</out>\n` +
        `      <comment>42 | grade is too warm\nsecond line\n\nAuthor: Chloé\nStatus: Open</comment>\n` +
        `    </marker>\n` +
        `    <marker>\n` +
        `      <name>Reviewer: Café pass, señor</name>\n` +
        `      <in>100</in>\n` +
        `      <out>-1</out>\n` +
        `      <comment>Café pass, señor\n\nAuthor: Reviewer\nStatus: Open</comment>\n` +
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
        `    <duration>1803</duration>\n` +
        `    <rate>\n` +
        `      <timebase>30</timebase>\n` +
        `      <ntsc>TRUE</ntsc>\n` +
        `    </rate>\n` +
        `    <timecode>\n` +
        `      <rate>\n` +
        `        <timebase>30</timebase>\n` +
        `        <ntsc>TRUE</ntsc>\n` +
        `      </rate>\n` +
        `      <string>01:00:00;00</string>\n` +
        `      <frame>107892</frame>\n` +
        `      <displayformat>DF</displayformat>\n` +
        `    </timecode>\n` +
        `    <marker>\n` +
        `      <name>Dee: Drop frame start</name>\n` +
        `      <in>0</in>\n` +
        `      <out>-1</out>\n` +
        `      <comment>Drop frame start\n\nAuthor: Dee\nStatus: Open</comment>\n` +
        `    </marker>\n` +
        `    <marker>\n` +
        `      <name>Reviewer: Crosses the drop minute</name>\n` +
        `      <in>1799</in>\n` +
        `      <out>1803</out>\n` +
        `      <comment>Crosses the drop minute\n\nAuthor: Reviewer\nStatus: Open</comment>\n` +
        `    </marker>\n` +
        `  </sequence>\n` +
        `</xmeml>\n`,
    );
  });
});

describe("exportFcpXml", () => {
  it("emits exact rational source timing without inflating sequence duration", () => {
    expect(exportFcpXml(sourceComments, sourceOptions)).toBe(
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<!DOCTYPE fcpxml>\n` +
        `<fcpxml version="1.10">\n` +
        `  <resources>\n` +
        `    <format id="r1" frameDuration="1/24s" width="1920" height="1080"/>\n` +
        `  </resources>\n` +
        `  <library>\n` +
        `    <event name="Onelight Comments">\n` +
        `      <project name="Onelight Comments">\n` +
        `        <sequence format="r1" duration="240/24s" tcStart="86400/24s" tcFormat="NDF">\n` +
        `          <spine>\n` +
        `            <gap name="Onelight Comments" offset="86400/24s" start="86400/24s" duration="240/24s">\n` +
        `              <marker start="86400/24s" duration="1/24s" value="Ava: Fix the flag pole matte" note="Fix the flag pole matte&#10;&#10;Author: Ava&#10;Status: Open" completed="0"/>\n` +
        `              <marker start="86424/24s" duration="24/24s" value="Ben: Sky replacement runs long" note="Sky replacement runs long&#10;&#10;Author: Ben&#10;Status: Open" completed="0"/>\n` +
        `              <marker start="86500/24s" duration="1/24s" value="Chloé: 42 | grade is too warm second line" note="42 | grade is too warm&#10;second line&#10;&#10;Author: Chloé&#10;Status: Open" completed="0"/>\n` +
        `              <marker start="86500/24s" duration="1/24s" value="Reviewer: Café pass, señor" note="Café pass, señor&#10;&#10;Author: Reviewer&#10;Status: Open" completed="0"/>\n` +
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
        `<fcpxml version="1.10">\n` +
        `  <resources>\n` +
        `    <format id="r1" frameDuration="1001/30000s" width="1920" height="1080"/>\n` +
        `  </resources>\n` +
        `  <library>\n` +
        `    <event name="Reel B">\n` +
        `      <project name="Reel B">\n` +
        `        <sequence format="r1" duration="1804803/30000s" tcStart="107999892/30000s" tcFormat="DF">\n` +
        `          <spine>\n` +
        `            <gap name="Reel B" offset="107999892/30000s" start="107999892/30000s" duration="1804803/30000s">\n` +
        `              <marker start="107999892/30000s" duration="1001/30000s" value="Dee: Drop frame start" note="Drop frame start&#10;&#10;Author: Dee&#10;Status: Open" completed="0"/>\n` +
        `              <marker start="109800691/30000s" duration="4004/30000s" value="Reviewer: Crosses the drop minute" note="Crosses the drop minute&#10;&#10;Author: Reviewer&#10;Status: Open" completed="0"/>\n` +
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
      `01:00:00:00 Ava: Fix the flag pole matte\n` +
        `01:00:01:00 Ben: Sky replacement runs long\n` +
        `01:00:04:04 Chloé: 42 | grade is too warm\nsecond line\n` +
        `01:00:04:04 Reviewer: Café pass, señor\n`,
    );
  });
});

// Defensive-export contract: mistagged sources and hostile comment bytes must
// still produce importable, well-formed output rather than throwing or
// emitting invalid XML.
describe("defensive exporters", () => {
  // dropFrame is set true but 24 fps is not a drop-frame rate: exporters must
  // coerce it to non-drop rather than throwing.
  const mistagged: MarkerOptions = {
    title: "Mistagged",
    rate: { num: 24, den: 1 },
    startFrame: 0,
    dropFrame: true,
    timecodeBase: "source",
  };
  const point: MarkerComment[] = [
    {
      id: "01J0000000000000000000AA01",
      bodyText: "hello",
      authorName: "Q",
      frameIn: 0,
    },
  ];

  it("coerces dropFrame to non-drop at a non-drop-frame rate instead of throwing", () => {
    expect(() => exportResolveEdl(point, mistagged)).not.toThrow();
    const edl = exportResolveEdl(point, mistagged);
    expect(edl).toContain("FCM: NON-DROP FRAME");
    expect(edl).toContain("00:00:00:00");
    expect(edl).not.toContain("00:00:00;00");
    expect(exportAvidText(point, mistagged)).toContain("00:00:00:00");
    expect(exportFcpXml(point, mistagged)).toContain('tcFormat="NDF"');
    expect(() => exportCsv(point, mistagged)).not.toThrow();
    expect(() => exportJson(point, mistagged)).not.toThrow();
    expect(() => exportText(point, mistagged)).not.toThrow();
    expect(() => exportXmeml(point, mistagged)).not.toThrow();
  });

  it("strips XML-illegal control characters from fcpxml and xmeml", () => {
    const dirty: MarkerComment[] = [
      {
        id: "01J0000000000000000000AA02",
        bodyText: "bell\x07 and null\x00 end",
        authorName: "ctl\x1f",
        frameIn: 0,
      },
    ];
    const fcp = exportFcpXml(dirty, mistagged);
    expect(fcp).not.toContain("\x07");
    expect(fcp).not.toContain("\x00");
    expect(fcp).toContain('value="ctl: bell and null end"');
    const xmeml = exportXmeml(dirty, mistagged);
    expect(xmeml).not.toContain("\x07");
    expect(xmeml).not.toContain("\x00");
    expect(xmeml).not.toContain("\x1f");
    expect(xmeml).toContain(
      "<comment>bell and null end\n\nAuthor: ctl\nStatus: Open</comment>",
    );
    expect(xmeml).toContain("<name>ctl: bell and null end</name>");
  });

  it("neutralizes the CDATA terminator in xmeml character data", () => {
    const cdata: MarkerComment[] = [
      {
        id: "01J0000000000000000000AA03",
        bodyText: "danger ]]> here",
        authorName: null,
        frameIn: 0,
      },
    ];
    const xmeml = exportXmeml(cdata, mistagged);
    expect(xmeml).not.toContain("]]>");
    expect(xmeml).toContain("]]&gt;");
  });
});

describe("marker import (the way back)", () => {
  const rate = { num: 24, den: 1 };
  const comments = [
    {
      id: "01A",
      frameIn: 24,
      frameOut: null,
      bodyText: "warmer mids",
      authorName: "David",
    },
    {
      id: "01B",
      frameIn: 100,
      frameOut: 147,
      bodyText: "hold this\nlonger",
      authorName: null,
    },
  ];

  it("round-trips through the Resolve marker EDL", () => {
    const edl = exportResolveEdl(comments, { rate, startFrame: 86400 });
    const back = parseResolveEdl(edl, { rate, startFrame: 86400 });
    expect(back).toHaveLength(2);
    expect(back[0]).toMatchObject({ frameIn: 24, frameOut: null });
    // The author is folded into the text on export; the words survive.
    expect(back[0]?.bodyText).toContain("warmer mids");
    expect(back[1]).toMatchObject({ frameIn: 100, frameOut: 147 });
    expect(back[1]?.bodyText).toContain("hold this");
    expect(back[1]?.bodyText).toContain("longer");
  });

  it("round-trips through the CSV", () => {
    const csv = exportCsv(comments, { rate });
    const back = parseMarkersCsv(csv);
    expect(back).toHaveLength(2);
    expect(back[0]).toEqual({
      frameIn: 24,
      frameOut: null,
      bodyText: "warmer mids",
    });
    expect(back[1]).toMatchObject({ frameIn: 100, frameOut: 147 });
  });

  it("skips junk lines instead of failing the file", () => {
    const edl = [
      "TITLE: Hand-mangled",
      "FCM: NON-DROP FRAME",
      "",
      "garbage line",
      "001  001      V     C        00:00:01:00 00:00:01:01 00:00:01:00 00:00:01:01",
      " |C:ResolveColorBlue |M:still here |D:1",
      "002  broken event with no timecodes",
    ].join("\n");
    const back = parseResolveEdl(edl, { rate });
    expect(back).toHaveLength(1);
    expect(back[0]?.bodyText).toBe("still here");
    expect(parseMarkersCsv("not,a,marker,csv\n1,2,3,4")).toEqual([]);
  });
});
