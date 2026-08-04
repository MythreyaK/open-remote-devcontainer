import * as vscode from "vscode";
import * as path from "node:path";

import { getGlobalState, setGlobalState } from "../common/globalState";
import { existsSync } from "node:fs";

const VERSION_KEY = "prevVersion";
const ReleaseNotesNever = "releaseNotes.never";

enum ReleaseNotesNotify {
    Yes = "Yes",
    No = "No",
    Never = "Never",
};

export function checkVersionAndNotify(ctx: vscode.ExtensionContext) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const current = ctx.extension.packageJSON.version as string;
    const previous = getGlobalState<string>(ctx, VERSION_KEY);

    const dontShow = getGlobalState(ctx, ReleaseNotesNever);
    if (dontShow !== undefined || previous === current) { return; }

    const label = (previous ? `Updated to v${current}` : `Installed v${current}`)
      + ". Show changelog?";

    void vscode.window.showInformationMessage(
        `Remote - Devcontainer: ${label}`,
        ...Object.values(ReleaseNotesNotify),
    ).then((choice) => {
        if (choice === ReleaseNotesNotify.Yes) {
            const names = ["changelog.md", "CHANGELOG.md"];
            for (const name of names) {
                const changelogPath = path.join(ctx.extensionPath, name);
                if (existsSync(changelogPath)) {
                    vscode.commands.executeCommand("markdown.showPreview", vscode.Uri.file(changelogPath));
                    break;
                }
            }
        }
        else if (choice === ReleaseNotesNotify.Never) {
            setGlobalState(ctx, ReleaseNotesNever, "true");
        }

        if (choice !== undefined) {
            // make sure user interacted, else they might
            // interact later if the notification hits a timeout
            setGlobalState(ctx, VERSION_KEY, current);
        }
    });
}
