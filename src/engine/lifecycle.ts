import { ContainerConfig } from './container';
import * as schema from '../parser/schema';
import * as settings from '../extension/settings';
import { run } from '../common/cmd';

import { getLogSink } from '../extension/log';
import { EngineError, InternalError } from '../extension/error';

export async function createContainer(config: schema.Config, workspaceFolder: string) {
    const cc = ContainerConfig.create(config, workspaceFolder);

    let imageName: string | undefined;

    if (cc.isDockerfileBased()) {
        const buildRes = await build(cc.getBuildCmd());
        if (buildRes.exit !== 0) {
            throw new EngineError(
                `${settings.getContainerEngine()} build failed with error code ${buildRes.exit}:\n`
                + `stdout: ${buildRes.stdout}\n`
                + `stderr: ${buildRes.stderr}\n`
            );
        }
        else {
            imageName = cc.getImageName();
            getLogSink().info(`Image '${imageName}' (${buildRes.stdout}) built`);
        }
    }
    else if (cc.isImageBased()) {
        imageName = cc.cfg.image;
    }
    else {
        throw new InternalError("ContainerConfig isn't dockerfile or image based");
    }

    const imageRes = await getImage(imageName);
    if (imageRes.exit !== 0) {
        throw new EngineError(
            `${settings.getContainerEngine()} Image '${imageName}' does not exist:\n`
            + `stdout: ${imageRes.stdout.trim()}\n`
            + `stderr: ${imageRes.stderr.trim()}\n`
        );
    }
    const imageHash = imageRes.stdout.trim();

    const startRes = await run([...settings.getEngineCmd(), ...cc.getCreateCmd(imageName)], {});
    let containerId: string | undefined = undefined;

    if (startRes.exit !== 0) {
        throw new EngineError(
            `${settings.getContainerEngine()} Image '${imageName}' does not exist:\n`
            + `stdout: ${startRes.stdout}\n`
            + `stderr: ${startRes.stderr}\n`
        );
    }
    else {
        containerId = startRes.stdout.trim();
        getLogSink().info(`Started container from image ${imageName} (${imageHash}) with ID ${containerId}`);

    }

    return containerId;
}


export function getImage(name: string) {
    return run([...settings.getEngineCmd(), "image", "inspect", name], {});
}

function build(args: string[]) {
    // run the docker build to generate the image
    // const buildConfig = new ContainerConfig();
    return run([...settings.getEngineCmd(), ...args], {});
}

