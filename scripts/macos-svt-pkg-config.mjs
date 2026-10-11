#!/usr/bin/env node
// FFmpeg only needs this one pinned package; no system pkg-config is required.
import path from "node:path";
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("1.0"); process.exit(0); }
const prefix = process.env.PP_SVT_PREFIX;
if (!prefix || !path.isAbsolute(prefix) || !args.some(a => a.includes("SvtAv1Enc") || /^dav1d(?:\s|$)/.test(a))) process.exit(1);
const dav1d = args.some(a => /^dav1d(?:\s|$)/.test(a));
if (dav1d) {
  if (args.includes("--cflags")) console.log(`-I${prefix}/include`);
  if (args.includes("--libs")) console.log(`-L${prefix}/lib -ldav1d`);
  if (args.includes("--modversion")) console.log("1.5.3");
  process.exit(0);
}
if (args.includes("--cflags")) console.log(`-I${prefix}/include/svt-av1 -DRTC_BUILD=0`);
if (args.includes("--libs")) console.log(`-L${prefix}/lib -lSvtAv1Enc`);
if (args.includes("--modversion")) console.log("4.2.0");
if (args.includes("--variable=includedir")) console.log(`${prefix}/include`);
// configure's existence/version checks all target SvtAv1Enc >= 0.9.0.
