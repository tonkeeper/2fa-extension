import {
    Address,
    beginCell,
    Cell,
    Contract,
    contractAddress,
    ContractProvider,
    Dictionary,
    DictionaryValue,
    Sender,
    SendMode,
} from '@ton/core';
import { DictionaryKey } from '@ton/core/src/dict/Dictionary';

export type TFAExtensionConfig = {
    wallet: Address;
};

export function tFAPluginConfigToCell(config: TFAExtensionConfig): Cell {
    return beginCell()
        .storeUint(0, 32)
        .storeAddress(config.wallet)
        .storeUint(0, 256)
        .storeUint(0, 256)
        .storeDict()
        .storeUint(0, 1)
        .storeUint(0, 32)
        .endCell();
}

export enum OpCode {
    INSTALL = 125,
    SEND_ACTIONS = 130,
    AUTHORIZE_DEVICE = 131,
    UNAUTHORIZE_DEVICE = 132,
    RECOVER_ACCESS = 133,
    CANCEL_REQUEST = 134,
}

export class TFAExtension implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromAddress(address: Address) {
        return new TFAExtension(address);
    }

    static createFromConfig(config: TFAExtensionConfig, code: Cell, workchain = 0) {
        const data = tFAPluginConfigToCell(config);
        const init = { code, data };
        return new TFAExtension(contractAddress(workchain, init), init);
    }

    async sendDeploy(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        opts: {
            servicePubkey: bigint;
            seedPubkey: bigint;
            devicePubkeys: Dictionary<number, bigint>;
        },
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(OpCode.INSTALL, 32)
                .storeUint(opts.servicePubkey, 256)
                .storeUint(opts.seedPubkey, 256)
                .storeDict(opts.devicePubkeys)
                .endCell(),
        });
    }

    async sendExternal(provider: ContractProvider, body: Cell) {
        await provider.external(body);
    }
}
