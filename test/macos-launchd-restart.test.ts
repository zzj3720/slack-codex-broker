import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("macOS launchd restart helper", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((directory) =>
        fs.rm(directory, {
          force: true,
          recursive: true
        })
      )
    );
  });

  it("runs bootout, bootstrap, then kickstart against the requested launchd service", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "launchd-restart-"));
    tempDirs.push(tempRoot);

    const fakeBin = path.join(tempRoot, "bin");
    const commandLog = path.join(tempRoot, "commands.log");
    const helperLog = path.join(tempRoot, "helper.log");
    const plistPath = path.join(tempRoot, "admin.plist");
    await fs.mkdir(fakeBin, { recursive: true });
    await fs.writeFile(plistPath, "<plist/>", "utf8");
    await fs.writeFile(
      path.join(fakeBin, "launchctl"),
      [
        "#!/bin/sh",
        "printf '%s\\n' \"$*\" >> \"$COMMAND_LOG\"",
        "exit 0",
        ""
      ].join("\n"),
      "utf8"
    );
    await fs.chmod(path.join(fakeBin, "launchctl"), 0o755);

    const scriptPath = fileURLToPath(new URL("../scripts/ops/macos-launchd-restart.mjs", import.meta.url));
    await execFileAsync(process.execPath, [
      scriptPath,
      "--domain",
      "gui/501",
      "--plist",
      plistPath,
      "--label",
      "test.admin",
      "--delay-ms",
      "0",
      "--log-file",
      helperLog,
      "--reason",
      "test restart"
    ], {
      env: {
        ...process.env,
        COMMAND_LOG: commandLog,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`
      }
    });

    await expect(fs.readFile(commandLog, "utf8")).resolves.toBe([
      `bootout gui/501 ${plistPath}`,
      `bootstrap gui/501 ${plistPath}`,
      "kickstart -k gui/501/test.admin",
      ""
    ].join("\n"));
    await expect(fs.readFile(helperLog, "utf8")).resolves.toContain("kickstart code=0");
  });
});
