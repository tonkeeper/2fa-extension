import { toNano } from '@ton/core';
import { TFAMaster } from '../wrappers/TFAMaster';
import { compile, NetworkProvider } from '@ton/blueprint';

export async function run(provider: NetworkProvider) {
    const tFAMaster = provider.open(TFAMaster.createFromConfig({}, await compile('TFAMaster')));

    await tFAMaster.sendDeploy(provider.sender(), toNano('0.05'));

    await provider.waitForDeploy(tFAMaster.address);

    // run methods on `tFAMaster`
}
