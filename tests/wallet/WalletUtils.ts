import { Address, beginCell, Cell, CurrencyCollection, Dictionary, MessageRelaxed, StateInit, toNano } from '@ton/core';
import { bufferToBigInt, Opcodes, WalletId, WalletV5 } from '../../wrappers/WalletV5';
import { KeyPair, sign } from '@ton/crypto';
import { ActionAddExtension, packActionsList } from './wallet_v5_actions';
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { compile } from '@ton/blueprint';

function timestamp() {
    return Math.floor(Date.now() / 1000);
}

export function createMsgInternal(params: {
    bounce?: boolean;
    dest: Address;
    value: bigint | CurrencyCollection;
    body?: Cell;
    init?: StateInit | null;
}): MessageRelaxed {
    return {
        info: {
            type: 'internal',
            ihrDisabled: true,
            bounce: params.bounce ?? false,
            bounced: false,
            dest: params.dest,
            value: typeof params.value === 'bigint' ? { coins: params.value } : params.value,
            ihrFee: 0n,
            forwardFee: 0n,
            createdLt: 0n,
            createdAt: 0,
        },
        body: params.body || beginCell().endCell(),
        init: params.init,
    };
}

export function createBody(actionsList: Cell, keypair: KeyPair) {
    const payload = beginCell()
        .storeUint(Opcodes.auth_signed_internal, 32)
        .storeUint(0, 80)
        .storeUint(timestamp() + 10000, 32)
        .storeUint(0, 32) // seqno
        .storeSlice(actionsList.beginParse())
        .endCell();

    const signature = sign(payload.hash(), keypair.secretKey);
    return beginCell().storeSlice(payload.beginParse()).storeUint(bufferToBigInt(signature), 512).endCell();
}

export function createExternalBody(actionsList: Cell, valid_until: number, keypair: KeyPair) {
    const payload = beginCell()
        .storeUint(Opcodes.auth_signed, 32)
        .storeUint(0, 80)
        .storeUint(valid_until, 32)
        .storeUint(0, 32) // seqno
        .storeSlice(actionsList.beginParse())
        .endCell();

    const signature = sign(payload.hash(), keypair.secretKey);
    return beginCell().storeSlice(payload.beginParse()).storeUint(bufferToBigInt(signature), 512).endCell();
}

export async function linkExtensionToWallet(
    wallet: SandboxContract<WalletV5>,
    deployer: SandboxContract<TreasuryContract>,
    linkTo: Address,
    keypair: KeyPair,
) {
    const res = await wallet.sendInternalSignedMessage(deployer.getSender(), {
        value: toNano(0.1),
        body: createBody(packActionsList([new ActionAddExtension(linkTo)]), keypair),
    });
    expect(res.transactions).toHaveTransaction({
        from: deployer.address,
        to: wallet.address,
        success: true,
    });
    expect((await wallet.getExtensionsArray())[0]).toEqualAddress(linkTo);
}

export async function deployWallet(
    blockchain: Blockchain,
    deployer: SandboxContract<TreasuryContract>,
    keypair: KeyPair,
    walletV5Code: Cell,
) {
    const wallet = blockchain.openContract(
        WalletV5.createFromConfig(
            {
                seqno: 0,
                walletId: 0n,
                publicKey: keypair.publicKey,
                extensions: Dictionary.empty(),
            },
            walletV5Code,
        ),
    );

    const walletDeployResult = await wallet.sendDeploy(deployer.getSender(), toNano('1.0'));
    expect(walletDeployResult.transactions).toHaveTransaction({
        from: deployer.address,
        to: wallet.address,
        deploy: true,
        success: true,
    });

    return wallet;
}
