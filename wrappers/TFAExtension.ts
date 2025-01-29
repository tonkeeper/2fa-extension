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
        .storeUint(0, 2)
        .storeUint(0, 64)
        .endCell();
}

export enum OpCode {
    INSTALL = 0x43563174,
    INTERNAL_SIGNED = 0x53684037,
    SEND_ACTIONS = 0xb15f2c8c,
    REMOVE_EXTENSION = 0x9d8084d6,
    DELEGATION = 0x23d9c15c,
    CANCEL_DELEGATION = 0xde82b501,
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
            rootCAPubkey: bigint;
            seedPubkey: bigint;
        },
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(OpCode.INSTALL, 32)
                .storeUint(opts.rootCAPubkey, 256)
                .storeUint(opts.seedPubkey, 256)
                .endCell(),
        });
    }

    async sendSendActions(provider: ContractProvider, opts: SendActionsOpts) {
        const body = packTFABody(
            opts.certificate,
            opts.seedPrivateKey,
            opts.seqno,
            opts.validUntil || Math.floor(Date.now() / 1000) + 120,
            OpCode.SEND_ACTIONS,
            beginCell().storeRef(opts.msg).storeUint(opts.sendMode, 8),
        );
        await this.sendExternal(provider, body);
    }

    async sendInternalSendActions(provider: ContractProvider, via: Sender, value: bigint, opts: SendActionsOpts) {
        const body = packTFABody(
            opts.certificate,
            opts.seedPrivateKey,
            opts.seqno,
            opts.validUntil || Math.floor(Date.now() / 1000) + 120,
            OpCode.SEND_ACTIONS,
            beginCell().storeRef(opts.msg).storeUint(opts.sendMode, 8),
        );
        await provider.internal(via, {
            value,
            sendMode: SendMode.NONE,
            body: beginCell().storeUint(OpCode.INTERNAL_SIGNED, 32).storeSlice(body.beginParse()).endCell(),
        });
    }

    async sendRemoveExtension(provider: ContractProvider, opts: RemoveExtOpts) {
        const body = packTFABody(
            opts.certificate,
            opts.seedPrivateKey,
            opts.seqno,
            opts.validUntil || Math.floor(Date.now() / 1000) + 120,
            OpCode.REMOVE_EXTENSION,
            beginCell(),
        );
        await this.sendExternal(provider, body);
    }

    async sendDelegation(provider: ContractProvider, opts: DelegationOpts) {
        const body = packSeedBody(
            opts.seedPrivateKey,
            opts.seqno,
            opts.validUntil || Math.floor(Date.now() / 1000) + 120,
            OpCode.DELEGATION,
            beginCell().storeRef(opts.newStateInit).storeCoins(opts.forwardAmount),
        );
        await this.sendExternal(provider, body);
    }

    async sendCancelDelegation(provider: ContractProvider, opts: CancelDelegationOpts) {
        const body = packSeedBody(
            opts.seedPrivateKey,
            opts.seqno,
            opts.validUntil || Math.floor(Date.now() / 1000) + 120,
            OpCode.CANCEL_DELEGATION,
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

    async getRootPubkey(provider: ContractProvider): Promise<bigint> {
        const res = await provider.get('get_root_pubkey', []);
        return res.stack.readBigNumber();
    }

    async getSeedPubkey(provider: ContractProvider): Promise<bigint> {
        const res = await provider.get('get_seed_pubkey', []);
        return res.stack.readBigNumber();
    }

    async getDelegationState(provider: ContractProvider): Promise<DelegationState> {
        const res = await provider.get('get_delegation_state', []);
        const stack = res.stack;
        const recoveryState = stack.readNumber();
        const blockedUntil = stack.readNumber();
        const data = stack.readTuple();

        switch (recoveryState) {
            case 0:
                return {
                    type: 'none',
                    blockedUntil,
                };
            case 1:
                return {
                    type: 'delegation',
                    newStateInit: data.readCell(),
                    forwardAmount: data.readBigNumber(),
                    blockedUntil,
                };
            default:
                throw new Error(`Unknown recovery state: ${recoveryState}`);
        }
    }

    async getEstimatedAttachedValue(
        provider: ContractProvider,
        opts: {
            forwardMsg: Cell;
            outputMsgCount: number;
            extendedActionCount: number;
        },
    ): Promise<bigint> {
        const res = await provider.get('get_estimated_attached_value', [
            { type: 'cell', cell: opts.forwardMsg },
            { type: 'int', value: BigInt(opts.outputMsgCount) },
            { type: 'int', value: BigInt(opts.extendedActionCount) },
        ]);
        return res.stack.readBigNumber();
    }
}

export type DelegationState =
    | {
          type: 'delegation';
          blockedUntil: number;
          newStateInit: Cell;
          forwardAmount: bigint;
      }
    | {
          type: 'none';
          blockedUntil: number;
      };

export type Certificate = {
    keypair: KeyPair;
    validUntil: number;
    signature: Buffer;
};

export type TFAAuth = {
    seedPrivateKey: Buffer;
    certificate: Certificate;
    seqno: number;
    validUntil?: number;
};

export type AuthSeed = {
    seedPrivateKey: Buffer;
    seqno: number;
    validUntil?: number;
};

export type SendActionsOpts = TFAAuth & {
    msg: Cell;
    sendMode: SendMode;
};

export type RemoveExtOpts = TFAAuth;

export type DelegationOpts = AuthSeed & {
    newStateInit: Cell;
    forwardAmount: bigint;
};

export type CancelDelegationOpts = AuthSeed;

export function packTFABody(
    certificate: Certificate,
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
    const signature1 = sign(dataToSign.hash(), certificate.keypair.secretKey);
    const signature2 = sign(dataToSign.hash(), seedPrivateKey);

    const cert = beginCell()
        .storeUint(certificate.validUntil, 64)
        .storeBuffer(certificate.keypair.publicKey)
        .storeBuffer(certificate.signature)
        .endCell();

    const body = beginCell()
        .storeRef(cert)
        .storeRef(beginCell().storeBuffer(signature2))
        .storeSlice(dataToSign.beginParse())
        .storeBuffer(signature1);

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

    const body = beginCell().storeSlice(dataToSign.beginParse()).storeBuffer(signature);

    return body.endCell();
}
