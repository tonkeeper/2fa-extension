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
        .storeUint(0, 2)
        .storeUint(0, 64)
        .endCell();
}

export enum OpCode {
    INSTALL = 0x43563174,
    SEND_ACTIONS = 0xb15f2c8c,
    AUTHORIZE_DEVICE = 0x0a73fcb4,
    UNAUTHORIZE_DEVICE = 0xa04d2666,
    RECOVER_ACCESS = 0x59c538dd,
    CANCEL_REQUEST = 0x30f0a407,
    DESTRUCT = 0x9d8084d6,
    DISABLE = 0x23d9c15c,
    CANCEL_DISABLING = 0xde82b501,
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
            opts.validUntil || Math.floor(Date.now() / 1000) + 120,
            OpCode.SEND_ACTIONS,
            beginCell().storeRef(opts.msg).storeUint(opts.sendMode, 8),
        );
        await this.sendExternal(provider, body);
    }

    async sendAuthorizeDevice(provider: ContractProvider, opts: AuthorizeDeviceOpts) {
        const body = packTFABody(
            opts.servicePrivateKey,
            opts.devicePrivateKey,
            opts.deviceId,
            opts.seqno,
            opts.validUntil || Math.floor(Date.now() / 1000) + 120,
            OpCode.AUTHORIZE_DEVICE,
            beginCell()
                .storeUint(opts.newDeviceId, 32)
                .storeRef(beginCell().storeUint(opts.newDevicePubkey, 256).endCell()),
        );
        await this.sendExternal(provider, body);
    }

    async sendUnauthorizeDevice(provider: ContractProvider, opts: UnathorizeDeviceOpts) {
        const body = packTFABody(
            opts.servicePrivateKey,
            opts.devicePrivateKey,
            opts.deviceId,
            opts.seqno,
            opts.validUntil || Math.floor(Date.now() / 1000) + 120,
            OpCode.UNAUTHORIZE_DEVICE,
            beginCell().storeUint(opts.removeDeviceId, 32),
        );
        await this.sendExternal(provider, body);
    }

    async sendRecoverAccess(provider: ContractProvider, opts: RecoverAccessOpts) {
        const body = packTFASeedBody(
            opts.servicePrivateKey,
            opts.seedPrivateKey,
            opts.seqno,
            opts.validUntil || Math.floor(Date.now() / 1000) + 120,
            OpCode.RECOVER_ACCESS,
            beginCell().storeUint(opts.newDevicePubkey, 256).storeUint(opts.newDeviceId, 32),
        );
        await this.sendExternal(provider, body);
    }

    async sendCancelRequest(provider: ContractProvider, opts: CancelRequestOpts) {
        const body = packTFASeedBody(
            opts.servicePrivateKey,
            opts.seedPrivateKey,
            opts.seqno,
            opts.validUntil || Math.floor(Date.now() / 1000) + 120,
            OpCode.CANCEL_REQUEST,
            beginCell(),
        );
        await this.sendExternal(provider, body);
    }

    async sendDestruct(provider: ContractProvider, opts: DestructOpts) {
        const body = packTFABody(
            opts.servicePrivateKey,
            opts.devicePrivateKey,
            opts.deviceId,
            opts.seqno,
            opts.validUntil || Math.floor(Date.now() / 1000) + 120,
            OpCode.DESTRUCT,
            beginCell(),
        );
        await this.sendExternal(provider, body);
    }

    async sendDisable(provider: ContractProvider, opts: DisableOpts) {
        const body = packSeedBody(
            opts.seedPrivateKey,
            opts.seqno,
            opts.validUntil || Math.floor(Date.now() / 1000) + 120,
            OpCode.DISABLE,
            beginCell().storeRef(opts.newStateInit).storeCoins(opts.forwardAmount),
        );
        await this.sendExternal(provider, body);
    }

    async sendCancelDisabling(provider: ContractProvider, opts: CancelDisablingOpts) {
        const body = packSeedBody(
            opts.seedPrivateKey,
            opts.seqno,
            opts.validUntil || Math.floor(Date.now() / 1000) + 120,
            OpCode.CANCEL_DISABLING,
            beginCell(),
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
        try {
            const cell = res.stack.readCell();
            return Dictionary.load(Dictionary.Keys.Uint(32), Dictionary.Values.BigUint(256), cell);
        } catch (e) {
            return Dictionary.empty(Dictionary.Keys.Uint(32), Dictionary.Values.BigUint(256));
        }
    }

    async getDevicePubkey(provider: ContractProvider, devicePubkeyId: number): Promise<bigint> {
        const res = await provider.get('get_device_pubkey', [{ type: 'int', value: BigInt(devicePubkeyId) }]);
        return res.stack.readBigNumber();
    }

    async getRecoverState(provider: ContractProvider): Promise<RecoverState> {
        const res = await provider.get('get_recover_state', []);
        const stack = res.stack;
        const recoveryState = stack.readNumber();

        switch (recoveryState) {
            case 1:
                return {
                    type: 'requested',
                    recoveryBlockedUntil: stack.readNumber(),
                    newDeviceId: stack.readNumber(),
                    newDevicePubkey: stack.readBigNumber(),
                };
            default:
                return {
                    type: 'none',
                    recoveryBlockedUntil: stack.readNumber(),
                };
        }
    }

    async getDisableState(provider: ContractProvider): Promise<DisableState> {
        const res = await provider.get('get_disable_state', []);
        const stack = res.stack;
        const disableState = stack.readNumber();

        switch (disableState) {
            case 2:
                return {
                    type: 'disabling',
                    disablingBlockedUntil: stack.readNumber(),
                    newStateInit: stack.readCell(),
                    forwardAmount: stack.readBigNumber(),
                };
            default:
                return {
                    type: 'none',
                    disablingBlockedUntil: stack.readNumber(),
                };
        }
    }
}

export type RecoverState =
    | {
          type: 'requested';
          recoveryBlockedUntil: number;
          newDeviceId: number;
          newDevicePubkey: bigint;
      }
    | {
          type: 'none';
          recoveryBlockedUntil: number;
      };

export type DisableState =
    | {
          type: 'disabling';
          disablingBlockedUntil: number;
          newStateInit: Cell;
          forwardAmount: bigint;
      }
    | {
          type: 'none';
          disablingBlockedUntil: number;
      };

export type TFAAuthDevice = {
    servicePrivateKey: Buffer;
    devicePrivateKey: Buffer;
    deviceId: number;
    seqno: number;
    validUntil?: number;
};

export type TFAAuthSeed = {
    servicePrivateKey: Buffer;
    seedPrivateKey: Buffer;
    seqno: number;
    validUntil?: number;
};

export type AuthSeed = {
    seedPrivateKey: Buffer;
    seqno: number;
    validUntil?: number;
};

export type SendActionsOpts = TFAAuthDevice & {
    msg: Cell;
    sendMode: SendMode;
};

export type AuthorizeDeviceOpts = TFAAuthDevice & {
    newDevicePubkey: bigint;
    newDeviceId: number;
};

export type UnathorizeDeviceOpts = TFAAuthDevice & {
    removeDeviceId: number;
};

export type RecoverAccessOpts = TFAAuthSeed & {
    newDevicePubkey: bigint;
    newDeviceId: number;
};

export type CancelRequestOpts = TFAAuthSeed;

export type DestructOpts = TFAAuthDevice;

export type DisableOpts = AuthSeed & {
    newStateInit: Cell;
    forwardAmount: bigint;
};

export type CancelDisablingOpts = AuthSeed;

export function packTFABody(
    servicePrivateKey: Buffer,
    devicePrivateKey: Buffer,
    deviceId: number,
    seqno: number,
    validUntil: number,
    opCode: OpCode,
    payload: Builder,
): Cell {
    const dataToSign = beginCell()
        .storeUint(opCode, 32)
        .storeUint(seqno, 32)
        .storeUint(validUntil, 64)
        .storeBuilder(payload)
        .endCell();
    const signature1 = sign(dataToSign.hash(), servicePrivateKey);
    const signature2 = sign(dataToSign.hash(), devicePrivateKey);

    const body = beginCell()
        .storeBuffer(signature1)
        .storeRef(beginCell().storeBuffer(signature2).storeUint(deviceId, 32))
        .storeSlice(dataToSign.beginParse());

    return body.endCell();
}

export function packTFASeedBody(
    servicePrivateKey: Buffer,
    seedPrivateKey: Buffer,
    seqno: number,
    validUntil: number,
    opCode: OpCode,
    payload: Builder,
): Cell {
    const dataToSign = beginCell()
        .storeUint(opCode, 32)
        .storeUint(seqno, 32)
        .storeUint(validUntil, 64)
        .storeBuilder(payload)
        .endCell();
    const signature1 = sign(dataToSign.hash(), servicePrivateKey);
    const signature2 = sign(dataToSign.hash(), seedPrivateKey);

    const body = beginCell()
        .storeBuffer(signature1)
        .storeRef(beginCell().storeBuffer(signature2))
        .storeSlice(dataToSign.beginParse());

    return body.endCell();
}

export function packSeedBody(
    seedPrivateKey: Buffer,
    seqno: number,
    validUntil: number,
    opCode: OpCode,
    payload: Builder,
): Cell {
    const dataToSign = beginCell()
        .storeUint(opCode, 32)
        .storeUint(seqno, 32)
        .storeUint(validUntil, 64)
        .storeBuilder(payload)
        .endCell();
    const signature = sign(dataToSign.hash(), seedPrivateKey);

    const body = beginCell().storeBuffer(signature).storeSlice(dataToSign.beginParse());

    return body.endCell();
}
