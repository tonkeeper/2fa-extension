import { toNano } from '@ton/core';
import { TFAExtension } from '../wrappers/TFAExtension';
import { compile, NetworkProvider } from '@ton/blueprint';

export async function run(provider: NetworkProvider) {
    const tFAPlugin = provider.open(TFAExtension.createFromConfig({}, await compile('TFAPlugin')));

    await tFAPlugin.sendDeploy(provider.sender(), toNano('0.05'));

    await provider.waitForDeploy(tFAPlugin.address);

    // run methods on `tFAPlugin`
}
