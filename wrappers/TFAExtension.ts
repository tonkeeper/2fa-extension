import {
    Address,
    beginCell,
    Builder,
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
import { KeyPair, sign } from '@ton/crypto';

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

    async sendSendActions(provider: ContractProvider, opts: SendActionsOpts) {
        const body = packTFABody(
            opts.servicePrivateKey,
            opts.devicePrivateKey,
            opts.deviceId,
            opts.seqno,
            OpCode.SEND_ACTIONS,
            beginCell().storeRef(opts.actionsList),
        );
        await this.sendExternal(provider, body);
    }

    async sendExternal(provider: ContractProvider, body: Cell) {
        await provider.external(body);
    }

    async getSeqno(provider: ContractProvider): Promise<number> {
        const res = await provider.get('get_seqno', []);
        return res.stack.readNumber();
    }

    async getWalletAddr(provider: ContractProvider): Promise<Address> {
        const res = await provider.get('get_wallet_addr', []);
        return res.stack.readAddress();
    }

    async getServicePubkey(provider: ContractProvider): Promise<bigint> {
        const res = await provider.get('get_service_pubkey', []);
        return res.stack.readBigNumber();
    }

    async getSeedPubkey(provider: ContractProvider): Promise<bigint> {
        const res = await provider.get('get_seed_pubkey', []);
        return res.stack.readBigNumber();
    }

    async getDevicePubkeys(provider: ContractProvider): Promise<Dictionary<number, bigint>> {
        const res = await provider.get('get_device_pubkeys', []);
        const cell = res.stack.readCell();
        return Dictionary.load(Dictionary.Keys.Uint(32), Dictionary.Values.BigUint(256), cell);
    }

    async getDevicePubkey(provider: ContractProvider, devicePubkeyId: number): Promise<bigint> {
        const res = await provider.get('get_device_pubkey', [{ type: 'int', value: BigInt(devicePubkeyId) }]);
        return res.stack.readBigNumber();
    }

    async getRecoverState(provider: ContractProvider): Promise<RecoverState> {
        const res = await provider.get('get_recover_state', []);
        return res.stack.readNumber();
    }
}

export enum RecoverState {
    NONE = 0,
    REQUESTED = 1,
}

export type TFAAuthDevice = {
    servicePrivateKey: Buffer;
    devicePrivateKey: Buffer;
    deviceId: number;
    seqno: number;
};

export type SendActionsOpts = TFAAuthDevice & {
    actionsList: Cell;
};

export function packTFABody(
    servicePrivateKey: Buffer,
    devicePrivateKey: Buffer,
    deviceId: number,
    seqno: number,
    opCode: OpCode,
    payload: Builder,
): Cell {
    const dataToSign = beginCell().storeUint(seqno, 32).storeBuilder(payload).endCell();
    const signature1 = sign(dataToSign.hash(), servicePrivateKey);
    const signature2 = sign(dataToSign.hash(), devicePrivateKey);

    const body = beginCell()
        .storeUint(opCode, 32)
        .storeBuffer(signature1)
        .storeRef(beginCell().storeBuffer(signature2).storeUint(deviceId, 32))
        .storeSlice(dataToSign.beginParse());

    return body.endCell();
}
