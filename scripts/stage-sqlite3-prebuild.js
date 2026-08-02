#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const https = require("node:https");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const TARGET_TO_PREBUILD = {
  "win32-x64": "win32-x64",
  "darwin-x64": "darwin-x64",
  "darwin-arm64": "darwin-arm64",
  "linux-x64": "linux-x64",
  "linux-arm64": "linux-arm64",
  "alpine-x64": "linuxmusl-x64",
  "alpine-arm64": "linuxmusl-arm64",
};
const MAX_REDIRECTS = 5;

function fail(message) {
  console.error(`stage-sqlite3-prebuild: ${message}`);
  process.exit(1);
}

function currentHostTarget() {
  const key = `${process.platform}-${process.arch}`;
  return TARGET_TO_PREBUILD[key] ? key : undefined;
}

function download(url, destination, redirectsLeft, done) {
  https.get(url, { headers: { "User-Agent": "sqlite-view-build" } }, response => {
    const status = response.statusCode || 0;
    if (status >= 300 && status < 400 && response.headers.location) {
      response.resume();
      if (redirectsLeft === 0) return done(new Error("too many redirects"));
      const redirect = new URL(response.headers.location, url).toString();
      download(redirect, destination, redirectsLeft - 1, done);
      return;
    }
    if (status !== 200) {
      response.resume();
      done(new Error(`HTTP ${status} for ${url}`));
      return;
    }
    const output = fs.createWriteStream(destination);
    response.pipe(output);
    output.on("finish", () => output.close(() => done(null)));
    output.on("error", done);
  }).on("error", done);
}

function main() {
  const target = process.argv[2] || currentHostTarget();
  if (!target) fail(`no prebuild exists for this host (${process.platform}-${process.arch})`);
  const prebuildPlatform = TARGET_TO_PREBUILD[target];
  if (!prebuildPlatform) fail(`unsupported VSCE target "${target}". Supported: ${Object.keys(TARGET_TO_PREBUILD).join(", ")}`);

  const sqlite3Dir = path.join(__dirname, "..", "node_modules", "sqlite3");
  const packageJson = JSON.parse(fs.readFileSync(path.join(sqlite3Dir, "package.json"), "utf8"));
  const asset = `sqlite3-v${packageJson.version}-napi-v6-${prebuildPlatform}.tar.gz`;
  const url = `https://github.com/TryGhost/node-sqlite3/releases/download/v${packageJson.version}/${asset}`;
  const tarball = path.join(sqlite3Dir, asset);

  console.log(`Downloading ${url}`);
  download(url, tarball, MAX_REDIRECTS, error => {
    if (error) fail(error.message);
    const extraction = spawnSync("tar", ["-xzf", asset], { cwd: sqlite3Dir, stdio: "inherit" });
    fs.unlinkSync(tarball);
    if (extraction.status !== 0) fail(`tar extraction failed with status ${extraction.status}`);
    const binary = path.join(sqlite3Dir, "build", "Release", "node_sqlite3.node");
    if (!fs.existsSync(binary)) fail(`extraction did not produce ${binary}`);
    console.log(`Staged ${prebuildPlatform} binary for target ${target} (${fs.statSync(binary).size} bytes).`);
  });
}

main();
